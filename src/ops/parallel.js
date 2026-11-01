// src/ops/parallel.js
//==========================================================
// The slow per-point tools on every core, for a cloud in memory:
// selectOutliersParallel, selectSparseParallel, pointNormalsParallel and
// denoisePointsParallel. The cloud is cut into tiles on its plan, each
// tile holds its own points and a ring of the points around it (wide
// enough for the tool's neighbours), and each runs on a pool worker
// (src/laz/pool.js, src/index/tileJobs.js). Only a tile's core points
// are taken from its result, so what comes back is the serial tool's
// answer where the ring covers a point's neighbours (selectSparse and
// pointNormals: always; denoisePoints with a given sigma: always;
// selectOutliers: for every point whose k nearest lie within the
// overlap). Under 200,000 points, with threads 1, or with workers that
// will not start, the tool runs on this thread. Progress is one
// climbing bar of 1000 either way, and a signal stops the run.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { defaultThreads, createLazPool } from "../laz/pool.js";
import { planFast } from "../index/planFast.js";
import { cloudDensity } from "../index/density.js";
import { sharedBar } from "../progressBar.js";
import { selectOutliers } from "./outliers.js";
import { selectSparse } from "./sparse.js";
import { pointNormals } from "./normals.js";
import { denoisePoints, denoiseResult } from "./denoise.js";
import { sameType } from "./columns.js";
import { suggestDoubleLayer, addDoubleLayerStats } from "./doubleLayer.js";
import { checkK, checkMaxDistance } from "../index/knn.js";

var MIN_POINTS = 200000;        // under this a pool does not pay: the tool runs here
var TILES_PER_THREAD = 4;       // more tiles than workers, for the uneven densities of a cloud
var CORE_RINGS = 10;            // a tile's side is at least this many rings (the ring is a small part of it)
var SAMPLE_TILES = 4;           // tiles measured for denoisePointsParallel's noise level

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function stopped() { return new LasError(ERROR_CODES.ABORTED, "the run was stopped"); }
function isTyped(a) { return a instanceof Float32Array || a instanceof Float64Array; }

// threads, tile and signal checked; the bar; and, when it pays, the tiles (ringOf(plan spacing) is the ring's width)
async function prepare(cols, o, ringOf) {
	if (o.tile !== undefined && !(typeof o.tile === "number" && o.tile > 0 && isFinite(o.tile))) throw bad("tile must be a positive distance, not " + JSON.stringify(o.tile));
	var threads = o.threads === undefined ? await defaultThreads() : o.threads;
	if (!Number.isInteger(threads) || threads < 1) throw bad("threads must be a whole number >= 1, not " + JSON.stringify(o.threads));
	var bar = sharedBar(o.onProgress, o.signal), n = cols.count;
	bar.at(0);
	var out = { threads: threads, bar: bar, signal: o.signal, plan: null };
	if (threads === 1 || !isTyped(cols.x) || !isTyped(cols.y) || !isTyped(cols.z) || (n < MIN_POINTS && o.tile === undefined)) return out;
	var dens = cloudDensity(cols.x, cols.y, cols.z, n), M = ringOf(dens > 0 && isFinite(dens) ? 1 / Math.sqrt(dens) : 0);
	if (!(M > 0)) return out;
	out.M = M;
	out.plan = planFast(cols.x, cols.y, cols.z, n, { dims: 3, M: M, targetTiles: TILES_PER_THREAD * threads, side: o.tile, minSide: o.tile === undefined ? CORE_RINGS * M : 2 * M });
	return out;
}

// Run a job on tiles (all, or those in `list`): in the pool, as many in flight as workers. apply(tile, result) takes each result.
// Returns false, with nothing run, when workers will not start.
async function runTiles(cols, plan, job, params, o, apply, list) {
	var NT = plan.NT, members = plan.members, tiles = (list || Array.from({ length: NT }, function (_, t) { return t; })).filter(function (t) { return members[t].length > 0; });
	if (!tiles.length) return true;
	var pool = await createLazPool(Math.min(o.threads, Math.max(2, tiles.length)));
	if (!pool) return false;
	var signal = o.signal, abort = function () { pool.close(); };
	if (signal) signal.addEventListener("abort", abort);
	try {
		var x = cols.x, y = cols.y, z = cols.z, A = x instanceof Float32Array ? Float32Array : Float64Array, next = 0, total = 0, done = new Float64Array(NT), last = -1;
		var order = tiles.slice().sort(function (p, q) { return members[q].length - members[p].length; });
		order.forEach(function (t) { total += members[t].length; });
		var report = function (t, f) {
			done[t] = Math.max(done[t], Math.min(1, f) * members[t].length);
			var sum = 0;
			for (var q = 0; q < order.length; q++) sum += done[order[q]];
			if (sum - last >= 0.005 * total || sum >= total) { last = sum; o.share(total ? sum / total : 1); }
		};
		var lane = async function () {
			while (next < order.length) {
				if (signal && signal.aborted) throw stopped();
				var t = order[next++], idx = members[t], m = idx.length, i;
				var tx = new A(m), ty = new A(m), tz = new A(m);
				for (i = 0; i < m; i++) { var g = idx[i]; tx[i] = x[g]; ty[i] = y[g]; tz[i] = z[g]; }
				var r = await pool.tile({ job: job, params: params, count: m, x: tx.buffer, y: ty.buffer, z: tz.buffer, f32: A === Float32Array }, function (f) { report(t, f); });
				apply(t, r);
				report(t, 1);
			}
		};
		var lanes = [];
		for (var w = 0; w < pool.size; w++) lanes.push(lane());
		await Promise.all(lanes);
		if (signal && signal.aborted) throw stopped();
		return true;
	} catch (err) {
		throw signal && signal.aborted ? stopped() : err;
	} finally {
		if (signal) signal.removeEventListener("abort", abort);
		pool.close();
	}
}

/**
 * selectOutliers on every core. The same rule (PDAL's statistical outliers: a point's mean distance to its k nearest above
 * the cloud's mean plus multiplier standard deviations, accumulated in point order), with each tile finding its core points'
 * k nearest among its own points and a ring: exact where the k nearest lie within the overlap, which a stray point may not
 * (it is still far from anything, so it is still an outlier).
 * @param {object} cols - point columns (typed x, y, z).
 * @param {{k?: number, multiplier?: number, overlap?: number, threads?: number, tile?: number,
 *   onProgress?: function(number, number), signal?: AbortSignal}} [opts] - k 8, multiplier 2; overlap: the ring's width (default
 *   30 point spacings, at least 0.5); threads (default one fewer than the cores, at most 16; 1 runs here); tile: a core's side
 *   (default about four tiles a thread); onProgress(done, total): one bar of 1000; signal stops it (ABORTED).
 * @returns {Promise<Uint32Array>} ascending point numbers, as selectOutliers
 */
export async function selectOutliersParallel(cols, opts) {
	var o = opts || {}, k = o.k === undefined ? 8 : o.k, mult = o.multiplier === undefined ? 2 : o.multiplier;
	checkK(k, "k");
	if (!(typeof mult === "number" && isFinite(mult))) throw bad("multiplier must be a finite number, not " + String(mult));
	if (o.overlap !== undefined && !(typeof o.overlap === "number" && o.overlap > 0 && isFinite(o.overlap))) throw bad("overlap must be a distance > 0, not " + JSON.stringify(o.overlap));
	var env = await prepare(cols, o, function (spacing) { return o.overlap !== undefined ? o.overlap : Math.max(0.5, 30 * spacing); }), bar = env.bar, n = cols.count;
	var here = function () { var r = selectOutliers(cols, { k: k, multiplier: mult, onProgress: bar.sub(0, 1), signal: o.signal }); bar.at(1); return r; };
	if (!env.plan) return here();
	var plan = env.plan, means = new Float64Array(n).fill(NaN);
	var ok = await runTiles(cols, plan, "outliers", { k: k }, Object.assign({ share: function (f) { bar.at(0.02 + 0.9 * f); } }, env), function (t, r) {
		var idx = plan.members[t];
		for (var j = 0; j < idx.length; j++) if (plan.own[idx[j]] === t) means[idx[j]] = r.means[j];
	});
	if (!ok) return here();
	// the cloud's mean and spread, in point order as PDAL accumulates them (a point with no mean is isolated: an outlier, not counted)
	var cnt = 0, M1 = 0, M2 = 0, i;
	for (i = 0; i < n; i++) { var v = means[i]; if (v !== v) continue; var delta = v - M1, dn = delta / (cnt + 1); M1 += dn; M2 += delta * dn * cnt; cnt++; }
	if (cnt <= k) { bar.at(1); return new Uint32Array(0); }
	var threshold = M1 + mult * Math.sqrt(M2 / (cnt - 1)), hits = 0;
	for (i = 0; i < n; i++) if (means[i] > threshold || means[i] !== means[i]) hits++;
	var out = new Uint32Array(hits), w2 = 0;
	for (i = 0; i < n; i++) if (means[i] > threshold || means[i] !== means[i]) out[w2++] = i;
	bar.at(1);
	return out;
}

/**
 * selectSparse on every core. Exact: the ring is one radius wide, so every point within the radius of a core point is in its tile.
 * @param {object} cols - point columns (typed x, y, z).
 * @param {{radius: number, minNeighbours?: number, xy?: boolean, threads?: number, tile?: number,
 *   onProgress?: function(number, number), signal?: AbortSignal}} opts - as selectSparse, and threads, tile, onProgress (one bar of 1000), signal.
 * @returns {Promise<Uint32Array>} the sparse points, ascending, as selectSparse
 */
export async function selectSparseParallel(cols, opts) {
	var o = opts || {}, radius = o.radius;
	if (!(typeof radius === "number" && radius > 0 && isFinite(radius))) throw bad("selectSparse radius must be a positive finite number, not " + String(radius));
	var minN = o.minNeighbours === undefined ? 1 : o.minNeighbours;
	if (!(Number.isInteger(minN) && minN >= 1)) throw bad("selectSparse minNeighbours must be a whole number >= 1, not " + String(minN));
	var env = await prepare(cols, o, function () { return radius * 1.01; }), bar = env.bar;
	var here = function () { var r = selectSparse(cols, { radius: radius, minNeighbours: minN, xy: o.xy, onProgress: bar.sub(0, 1), signal: o.signal }); bar.at(1); return r; };
	if (!env.plan) return here();
	var plan = env.plan, parts = [], total = 0;
	var ok = await runTiles(cols, plan, "sparse", { radius: radius, minNeighbours: minN, xy: !!o.xy }, Object.assign({ share: function (f) { bar.at(0.02 + 0.93 * f); } }, env), function (t, r) {
		var idx = plan.members[t], keep = [];
		for (var q = 0; q < r.sel.length; q++) { var p = idx[r.sel[q]]; if (plan.own[p] === t) keep.push(p); }
		parts.push(keep); total += keep.length;
	});
	if (!ok) return here();
	var out = new Uint32Array(total), at = 0;
	parts.forEach(function (l) { out.set(l, at); at += l.length; });
	out.sort();
	bar.at(1);
	return out;
}

/**
 * pointNormals on every core. Exact: the ring is a little wider than maxDistance, so every neighbour of a core point is in its tile.
 * @param {object} cols - point columns (typed x, y, z).
 * @param {{k?: number, maxDistance: number, threads?: number, tile?: number, onProgress?: function(number, number),
 *   signal?: AbortSignal}} opts - as pointNormals (without start and end), and threads, tile, onProgress (one bar of 1000), signal.
 * @returns {Promise<{normal: Float32Array, residual: Float32Array}>} as pointNormals
 */
export async function pointNormalsParallel(cols, opts) {
	var o = opts || {}, k = o.k === undefined ? 16 : o.k;
	checkK(k, "k");
	checkMaxDistance(o.maxDistance);
	if (o.start !== undefined || o.end !== undefined) throw bad("pointNormalsParallel takes the whole cloud; use pointNormals for a range");
	var env = await prepare(cols, o, function () { return o.maxDistance * 1.01; }), bar = env.bar, n = cols.count;
	var here = function () { var r = pointNormals(cols, { k: k, maxDistance: o.maxDistance, onProgress: bar.sub(0, 1), signal: o.signal }); bar.at(1); return r; };
	if (!env.plan) return here();
	var plan = env.plan, normal = new Float32Array(3 * n), residual = new Float32Array(n);
	var ok = await runTiles(cols, plan, "normals", { k: k, maxDistance: o.maxDistance }, Object.assign({ share: function (f) { bar.at(0.02 + 0.96 * f); } }, env), function (t, r) {
		var idx = plan.members[t];
		for (var j = 0; j < idx.length; j++) {
			var p = idx[j];
			if (plan.own[p] !== t) continue;
			normal[3 * p] = r.normal[3 * j]; normal[3 * p + 1] = r.normal[3 * j + 1]; normal[3 * p + 2] = r.normal[3 * j + 2];
			residual[p] = r.residual[j];
		}
	});
	if (!ok) return here();
	bar.at(1);
	return { normal: normal, residual: residual };
}

/**
 * denoisePoints on every core. The ring is (iterations + 1) x maxDistance wide, so a core point's pass-by-pass neighbourhood is in
 * its tile: with sigma given, the points where denoisePoints puts them. Without it, sigma is measured on four tiles (their median),
 * where denoisePoints measures it on a sample of the whole cloud.
 * @param {object} cols - point columns (typed x, y, z).
 * @param {{method?: string, k?: number, maxDistance: number, sigma?: number, iterations?: number, normals?: boolean, inPlace?: boolean,
 *   threads?: number, tile?: number, onProgress?: function(number, number), signal?: AbortSignal}} opts - as denoisePoints, and threads,
 *   tile, onProgress (one bar of 1000), signal.
 * @returns {Promise<object>} as denoisePoints
 */
export async function denoisePointsParallel(cols, opts) {
	var o = opts || {}, method = o.method === undefined ? "bilateral" : o.method, k = o.k === undefined ? 16 : o.k;
	if (method !== "bilateral" && method !== "mls") throw bad("method must be \"bilateral\" or \"mls\", not " + String(method));
	checkK(k, "k");
	checkMaxDistance(o.maxDistance);
	var iterations = o.iterations === undefined ? 1 : o.iterations;
	if (!(Number.isInteger(iterations) && iterations >= 1)) throw bad("iterations must be a whole number >= 1, not " + String(iterations));
	if (o.sigma !== undefined && !(typeof o.sigma === "number" && isFinite(o.sigma) && o.sigma > 0)) throw bad("sigma must be a positive finite number, not " + String(o.sigma));
	var env = await prepare(cols, o, function () { return (iterations + 1) * o.maxDistance; }), bar = env.bar, n = cols.count;
	var serial = function () {
		var r = denoisePoints(cols, { method: method, k: k, maxDistance: o.maxDistance, sigma: o.sigma, iterations: iterations, normals: o.normals, inPlace: o.inPlace, onProgress: bar.sub(0, 1), signal: o.signal });
		bar.at(1);
		return r;
	};
	if (!env.plan) return serial();
	var plan = env.plan, sigma = o.sigma, MEASURE = sigma === undefined ? 0.1 : 0;
	if (sigma === undefined) {
		// the noise level: the median of the levels of a few of the biggest-core tiles spread through the cloud
		var big = Array.from({ length: plan.NT }, function (_, t) { return t; }).filter(function (t) { return plan.members[t].length >= 1000; });
		var pick = [];
		for (var q = 0; q < Math.min(SAMPLE_TILES, big.length); q++) pick.push(big[Math.floor((q + 0.5) * big.length / Math.min(SAMPLE_TILES, big.length))]);
		var levels = [];
		if (pick.length) {
			var okNoise = await runTiles(cols, plan, "noise", { k: k, maxDistance: o.maxDistance }, Object.assign({ share: function (f) { bar.at(MEASURE * f); } }, env), function (t, r) { if (r.value[0] === r.value[0]) levels.push(r.value[0]); }, pick);
			if (!okNoise) return serial();
		}
		levels.sort(function (a, b) { return a - b; });
		sigma = levels.length ? levels[Math.floor((levels.length - 1) / 2)] : NaN;
		if (!(sigma > 0)) return serial();   // no plane to measure on (or a perfectly flat one): the serial tool's rule for a cloud with no noise level
	}
	var positions = false, dst = { count: n, x: sameType(cols.x, n), y: sameType(cols.y, n), z: sameType(cols.z, n) }, normal = o.normals ? new Float32Array(3 * n) : null;
	var params = { method: method, k: k, maxDistance: o.maxDistance, sigma: sigma, iterations: iterations, normals: !!o.normals };
	var ok = await runTiles(cols, plan, "denoise", params, Object.assign({ share: function (f) { bar.at(MEASURE + (0.98 - MEASURE) * f); } }, env), function (t, r) {
		var idx = plan.members[t];
		for (var j = 0; j < idx.length; j++) {
			var p = idx[j];
			if (plan.own[p] !== t) continue;
			dst.x[p] = r.x[j]; dst.y[p] = r.y[j]; dst.z[p] = r.z[j];
			if (normal) { normal[3 * p] = r.normal[3 * j]; normal[3 * p + 1] = r.normal[3 * j + 1]; normal[3 * p + 2] = r.normal[3 * j + 2]; }
		}
	});
	if (!ok) return serial();
	var out = denoiseResult(cols, dst, normal, positions, o.inPlace);
	bar.at(1);
	return out;
}


/**
 * suggestDoubleLayer on every core: each tile measures its own points (doubleLayerStats), the measures are added, and the
 * suggestion is made from the sum. A cell cut by a tile's edge counts as two, and the area is counted on each tile's own
 * grid, so the numbers differ a little from a run on the whole cloud, as a different sample of the same cloud would.
 * @param {object} cols - point columns (typed x, y, z).
 * @param {{strength?: string, threads?: number, tile?: number, onProgress?: function(number, number), signal?: AbortSignal}} [opts] -
 *   as suggestDoubleLayer, and threads, tile (a core's side; default about four tiles a thread), onProgress (one bar of 1000), signal.
 * @returns {Promise<object>} suggestDoubleLayer's result
 */
export async function suggestDoubleLayerParallel(cols, opts) {
	var o = opts || {};
	var env = await prepare(cols, o, function (spacing) { return Math.max(1e-6, spacing * 0.01); }), bar = env.bar;
	var here = function () { var r = suggestDoubleLayer(cols, { strength: o.strength, onProgress: bar.sub(0, 1), signal: o.signal }); bar.at(1); return r; };
	if (!env.plan) return here();
	var plan = env.plan, parts = [];
	var ok = await runTiles(cols, plan, "doubleStats", {}, Object.assign({ share: function (f) { bar.at(0.02 + 0.96 * f); } }, env), function (t, r) {
		var bins = r.hist.length / r.cells.length;
		parts.push({ points: r.head[0], area: r.head[1], cells: Array.from(r.cells), hist: Array.from({ length: r.cells.length }, function (_, i) { return r.hist.slice(i * bins, (i + 1) * bins); }) });
	});
	if (!ok) return here();
	var result = suggestDoubleLayer(addDoubleLayerStats(parts), { strength: o.strength });
	bar.at(1);
	return result;
}
