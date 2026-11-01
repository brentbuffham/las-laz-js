// src/filter/dedupeParallel.js
//==========================================================
// dedupeParallel: dedupe on every core, and the same answer. The cloud is cut into
// tiles on its plan (the two widest axes; x and y for a plan comparison), each tile
// takes its own points and a ring of the points around it, wide enough that every point
// within tolerance of a core point is in the tile, and each tile sweeps its points in
// the cloud's order on a pool worker (src/filter/dedupeCore.js). A tile cannot know the
// fate of a ring point that has a neighbour outside the ring, so its belief about a ring
// point can differ from the tile that owns the point. The run is not trusted until
// every tile's belief about every ring point near its core is the owner's answer:
// then each point's fate follows from its earlier neighbours' fates, which is the
// rule, and the rule has one answer. A tile whose belief was wrong is swept again with
// the owners' answers frozen in its ring, and the check repeats (a chain that crosses
// several seams takes several rounds); after MAX_ROUNDS the cloud is swept here. Kept
// points and every column following them are those of dedupe.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { defaultThreads, createLazPool } from "../laz/pool.js";
import { sharedBar } from "../progressBar.js";
import { planFast } from "../index/planFast.js";
import { dedupe, keepColumns } from "./dedupe.js";

var MIN_POINTS = 400000;        // under this a pool does not pay: one sweep here
var TILES_PER_THREAD = 4;       // more tiles than workers, for the uneven densities of a cloud
var RING = 2, CORE_RINGS = 50;  // the ring is RING tolerances wide; a tile's side is at least CORE_RINGS rings (the ring is a small part of it)
var MAX_ROUNDS = 6, INNER = 1.01;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function stopped() { return new LasError(ERROR_CODES.ABORTED, "the run was stopped"); }

/**
 * dedupe on the worker pool (browser Web Workers or Node worker_threads), the same points kept in the same order.
 * @param {object} cols - PointColumns ({ count, x, y, z?, ... }), typed arrays.
 * @param {number} tolerance - distance below which points merge (> 0).
 * @param {{z?: boolean, threads?: number, tile?: number, onProgress?: function(number, number), signal?: AbortSignal}} [opts] -
 *   z: compare in 3D; threads: workers (default one fewer than the cores, at most 16; 1 sweeps here); tile: the side of a
 *   tile's core (default: about four tiles a thread; a smaller cloud than 400 000 points is swept here); onProgress(done, total):
 *   one climbing bar over the whole run, total 1000; signal: stops it (ABORTED).
 * @returns {Promise<object>} dedupe's result (PointColumns of the kept points), plus tiles, threads and rounds
 *   (sweeps of the tiles beyond the first, to settle points near a seam).
 */
export async function dedupeParallel(cols, tolerance, opts) {
	var o = opts || {};
	if (!(tolerance > 0)) throw bad("dedupe tolerance must be > 0");
	if (o.tile !== undefined && !(typeof o.tile === "number" && o.tile > 0 && isFinite(o.tile))) throw bad("tile must be a positive distance, not " + JSON.stringify(o.tile));
	var threads = o.threads === undefined ? await defaultThreads() : o.threads;
	if (!Number.isInteger(threads) || threads < 1) throw bad("threads must be a whole number >= 1, not " + JSON.stringify(o.threads));
	var signal = o.signal, bar = sharedBar(o.onProgress), n = cols.count, use3d = !!(o.z && cols.z);
	if (signal && signal.aborted) throw stopped();
	bar.at(0);
	function here(rounds) {
		var r = dedupe(cols, tolerance, { z: o.z, signal: signal, onProgress: bar.sub(0, 1) });
		bar.at(1);
		return Object.assign(r, { tiles: 1, threads: 1, rounds: rounds || 0 });
	}
	if (threads === 1 || (n < MIN_POINTS && o.tile === undefined) || !n) return here();
	var isTyped = function (a) { return a instanceof Float32Array || a instanceof Float64Array; };
	if (!isTyped(cols.x) || !isTyped(cols.y) || (use3d && !isTyped(cols.z))) return here();
	var x = cols.x, y = cols.y, z = use3d ? cols.z : null;
	var M = RING * tolerance;
	var plan = planFast(x, y, z, n, { dims: use3d ? 3 : 2, M: M, targetTiles: TILES_PER_THREAD * threads, side: o.tile, minSide: o.tile === undefined ? CORE_RINGS * M : 2 * M, near: tolerance * INNER });
	if (!plan) return here();
	bar.at(0.04);
	await Promise.resolve();   // the loop turns once: a stop that came in is seen
	if (signal && signal.aborted) throw stopped();

	var pool = await createLazPool(Math.min(threads, plan.NT));
	if (!pool) return here();
	var abort = function () { pool.close(); };
	if (signal) signal.addEventListener("abort", abort);
	try {
		var NT = plan.NT, own = plan.own, members = plan.members, A = x instanceof Float32Array ? Float32Array : Float64Array;
		var keep = new Uint8Array(n);                // 1: kept, from the point's own tile
		var belief = new Array(NT);                  // each tile's answer for the ring points near its core (what it swept with)
		var order = [];
		for (var t = 0; t < NT; t++) order.push(t);
		order.sort(function (p, q) { return members[q].length - members[p].length; });

		// run the tiles in `list` (a pool task each; as many in flight as workers, so the copies of columns are not all held at once)
		async function sweep(list, frozenFrom, share) {
			var next = 0, done = new Float64Array(NT), total = 0, last = -1;
			list.forEach(function (tt) { total += members[tt].length; });
			function report(tt, f) {
				done[tt] = Math.max(done[tt], Math.min(1, f) * members[tt].length);
				var sum = 0;
				for (var q = 0; q < list.length; q++) sum += done[list[q]];
				if (sum - last >= 0.005 * total || sum >= total) { last = sum; bar.at(share[0] + (share[1] - share[0]) * (total ? sum / total : 1)); }
			}
			async function lane() {
				while (next < list.length) {
					if (signal && signal.aborted) throw stopped();
					var tt = list[next++], idx = members[tt], m = idx.length, i;
					var tx = new A(m), ty = new A(m), tz = use3d ? new A(m) : null;
					for (i = 0; i < m; i++) { var g = idx[i]; tx[i] = x[g]; ty[i] = y[g]; if (use3d) tz[i] = z[g]; }
					var task = { count: m, x: tx.buffer, y: ty.buffer, z: use3d ? tz.buffer : null, f32: A === Float32Array, tolerance: tolerance };
					var seen = null;
					if (frozenFrom) {
						// the ring points are not swept: they stand as the owners' answers (and the core points are swept)
						var fr = new Uint8Array(m);
						for (i = 0; i < m; i++) if (own[idx[i]] !== tt) fr[i] = keep[idx[i]] ? 1 : 2;
						task.frozen = fr.buffer;
						seen = new Uint8Array(plan.ringAt[tt].length);
						for (i = 0; i < seen.length; i++) seen[i] = fr[plan.ringAt[tt][i]] === 1 ? 1 : 0;
					}
					var r = await pool.dedupe(task, function (f) { report(tt, f); });
					var st = r.status;
					if (!seen) {
						var at = plan.ringAt[tt];
						seen = new Uint8Array(at.length);
						for (i = 0; i < at.length; i++) seen[i] = st[at[i]];
					}
					for (i = 0; i < m; i++) if (own[idx[i]] === tt) keep[idx[i]] = st[i];
					belief[tt] = seen;
					report(tt, 1);
				}
			}
			var lanes = [];
			for (var w = 0; w < pool.size; w++) lanes.push(lane());
			await Promise.all(lanes);
		}
		// the tiles whose belief about a ring point near their core is not the owner's answer
		function disagree() {
			var out = [];
			for (var tt = 0; tt < NT; tt++) {
				var idx = members[tt], at = plan.ringAt[tt], near = plan.ringNear[tt], b = belief[tt];
				for (var q = 0; q < at.length; q++) if (near[q] && b[q] !== keep[idx[at[q]]]) { out.push(tt); break; }
			}
			return out;
		}

		await sweep(order, false, [0.04, 0.88]);
		var rounds = 0, dirty = disagree();
		while (dirty.length && rounds < MAX_ROUNDS) {
			rounds++;
			await sweep(dirty, true, [0.88 + 0.01 * (rounds - 1), 0.88 + 0.01 * rounds]);
			dirty = disagree();
		}
		if (signal && signal.aborted) throw stopped();
		if (dirty.length) { pool.close(); return here(rounds); }   // a chain through more seams than MAX_ROUNDS: sweep it here
		pool.close();
		bar.at(0.94);
		var count = 0, i2;
		for (i2 = 0; i2 < n; i2++) count += keep[i2];
		var sel = new Uint32Array(count), w2 = 0;
		for (i2 = 0; i2 < n; i2++) if (keep[i2]) sel[w2++] = i2;
		var out = keepColumns(cols, sel);
		bar.at(1);
		return Object.assign(out, { tiles: NT, threads: Math.min(threads, NT), rounds: rounds });
	} catch (err) {
		throw signal && signal.aborted ? stopped() : err;
	} finally {
		if (signal) signal.removeEventListener("abort", abort);
		pool.close();
	}
}
