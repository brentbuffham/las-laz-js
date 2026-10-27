// src/fragments/parallel.js
//==========================================================
// findFragmentsParallel: findFragments on every core. The cloud is cut
// into tiles on its two widest axes (plan, for a muckpile from above),
// each grown by an overlap wider than a rock, and each runs in a worker
// (the LAZ pool, src/laz/pool.js) with the whole cloud's spacing, so
// every tile has the same cell, maxDistance and floor. A fragment is
// kept from the one tile whose core holds its centroid; where two kept
// fragments claim a point the first keeps it, and a fragment left with
// under half its points is a duplicate across a seam and is dropped.
// Ids by size, largest first, as findFragments. The surface and the
// part in no fragment are plan areas on a grid of 1.5 point spacings,
// whatever the method. Without workers (none, or threads 1) the tiles
// run one by one here, with the same result.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf } from "../index/grid.js";
import { createLazPool, defaultThreads } from "../laz/pool.js";
import { findFragments } from "./findFragments.js";
import { pointSpacing } from "./spacing.js";
import { resultFields } from "./resolution.js";

var MIN_TILE_POINTS = 200000;   // under this per thread, one tile on this thread is quicker than a pool
var CELL_SPACINGS = 1.5, MAX_CELLS = 6e7;
var FACET_ONLY = ["maxDistance", "k", "normals", "facetOptions", "concaveAngle", "surfaceDistance", "viewpoint", "fill", "fillDistance"];

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/**
 * findFragments split over tiles and run in parallel workers (browser Web Workers or Node worker_threads).
 * @param {object} cols - point columns, as findFragments.
 * @param {object} opts - findFragments' options, and: threads (workers; default one fewer than the cores, at
 *   most 16; 1 runs here), tile (the side of a tile's core, m; default from the cloud's area, about two tiles a
 *   thread, at least 4 overlaps), overlap (m each side; default max(2.5, reliefRadius + 1.5): wider than the
 *   largest rock, and the watershed's relief radius), onProgress(done, total) (tiles).
 * @returns {Promise<object>} findFragments' result (fragment, fragments, surfaceArea, unassignedArea, method,
 *   spacing, floor, resolution, warnings, cell, fromWatershed / fromFacets for the hybrid), plus tiles and threads;
 *   facets is null (facet ids are each tile's own).
 */
export async function findFragmentsParallel(cols, opts) {
	if (opts === undefined || opts === null || typeof opts !== "object") throw bad("findFragmentsParallel needs options: { method?, … }");
	var co = coordsOf(cols, "findFragmentsParallel"), n = cols.count, st = co.stride;
	var threads = opts.threads === undefined ? await defaultThreads() : opts.threads;
	if (!Number.isInteger(threads) || threads < 1) throw bad("threads must be a whole number >= 1, not " + JSON.stringify(opts.threads));
	var method = opts.method === undefined ? "facets" : opts.method;
	var spacing = pointSpacing(cols);
	// precomputed normals are per point of the whole cloud; too few points or one thread: findFragments as it is
	if (opts.normals !== undefined || !(spacing > 0) || n < 2 * MIN_TILE_POINTS && opts.tile === undefined) return Object.assign(findFragments(cols, strip(opts)), { tiles: 1, threads: 1 });

	// the two widest axes of the box: the tiles' plane
	var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], C = [co.x, co.y, co.z], i, a, k;
	for (i = 0; i < n; i++) for (a = 0; a < 3; a++) { var v = C[a][i * st]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
	var order = [0, 1, 2].sort(function (p, q) { return (hi[q] - lo[q]) - (hi[p] - lo[p]); }), U = C[order[0]], V = C[order[1]];
	var u0 = lo[order[0]], v0 = lo[order[1]], du = hi[order[0]] - u0, dv = hi[order[1]] - v0;

	var rr = opts.reliefRadius === undefined ? 1 : opts.reliefRadius;
	var M = opts.overlap === undefined ? Math.max(2.5, rr + 1.5) : opts.overlap;
	if (!(typeof M === "number" && M >= 0 && isFinite(M))) throw bad("overlap must be a distance >= 0, not " + JSON.stringify(opts.overlap));
	var T = opts.tile;
	if (T === undefined) T = Math.max(4 * M, Math.sqrt(du * dv / (2 * threads)));
	if (!(typeof T === "number" && T > 0 && isFinite(T))) throw bad("tile must be a positive distance, not " + JSON.stringify(opts.tile));
	var NU = Math.max(1, Math.ceil(du / T)), NV = Math.max(1, Math.ceil(dv / T)), NT = NU * NV;
	if (NT === 1 || threads === 1 && opts.tile === undefined) return Object.assign(findFragments(cols, Object.assign(strip(opts), { spacing: spacing })), { tiles: 1, threads: 1 });

	// each tile's points: its core grown by M (a point is in up to four tiles while M < T / 2)
	function span(t, d0, N) { var a0 = Math.max(0, Math.floor((t - d0 - M) / T)), a1 = Math.min(N - 1, Math.floor((t - d0 + M) / T)); return [a0, a1]; }
	var counts = new Uint32Array(NT);
	for (i = 0; i < n; i++) {
		var su = span(U[i * st], u0, NU), sv = span(V[i * st], v0, NV);
		for (var b = sv[0]; b <= sv[1]; b++) for (a = su[0]; a <= su[1]; a++) counts[b * NU + a]++;
	}
	var members = [];
	for (k = 0; k < NT; k++) members.push(new Uint32Array(counts[k]));
	counts.fill(0);
	for (i = 0; i < n; i++) {
		var pu = span(U[i * st], u0, NU), pv = span(V[i * st], v0, NV);
		for (var b2 = pv[0]; b2 <= pv[1]; b2++) for (a = pu[0]; a <= pu[1]; a++) { var t = b2 * NU + a; members[t][counts[t]++] = i; }
	}

	// run them: the pool, or here
	var tileOpts = Object.assign(strip(opts), { spacing: spacing }), prog = opts.onProgress, done = 0;
	var Arr = co.x instanceof Float32Array ? Float32Array : Float64Array;
	function columns(idx) {
		var m = idx.length, x = new Arr(m), y = new Arr(m), z = new Arr(m);
		for (var j = 0; j < m; j++) { var o = idx[j] * st; x[j] = co.x[o]; y[j] = co.y[o]; z[j] = co.z[o]; }
		return { count: m, x: x, y: y, z: z };
	}
	var pool = threads > 1 ? await createLazPool(Math.min(threads, NT)) : null;
	var results;
	try {
		results = await Promise.all(members.map(function (idx) {
			if (idx.length < 9) return Promise.resolve(null);
			var tc = columns(idx);
			var job = pool ? pool.fragments({ count: tc.count, x: tc.x.buffer, y: tc.y.buffer, z: tc.z.buffer, f32: Arr === Float32Array, opts: tileOpts })
				: Promise.resolve().then(function () { return findFragments(tc, tileOpts); });
			return job.then(function (r) { done++; if (prog) prog(done, NT); return r; });
		}));
	} finally {
		if (pool) pool.close();
	}

	// stitch: keep each tile's fragments whose centroid is in its core; the first claim on a point holds
	var label = new Uint32Array(n), kept = [], planeDistances = [], sideOn = false, cell = NaN;
	results.forEach(function (r, ti) {
		if (!r) return;
		var tu = ti % NU, tv = Math.floor(ti / NU), cu0 = u0 + tu * T, cv0 = v0 + tv * T, idx = members[ti];
		var cu1 = tu === NU - 1 ? Infinity : cu0 + T, cv1 = tv === NV - 1 ? Infinity : cv0 + T;
		if (tu === 0) cu0 = -Infinity;
		if (tv === 0) cv0 = -Infinity;
		if (r.planeDistance > 0) planeDistances.push(r.planeDistance);
		if (r.warnings.some(function (w) { return w.code === "SIDE_ON"; })) sideOn = true;
		if (r.cell > 0) cell = r.cell;
		var gid = new Uint32Array(r.fragments.length + 1);
		r.fragments.forEach(function (f) {
			var c = f.centroid, cu = c[order[0]], cv = c[order[1]];
			if (cu >= cu0 && cu < cu1 && cv >= cv0 && cv < cv1) { kept.push(f); gid[f.id] = kept.length; }
		});
		for (var j = 0; j < idx.length; j++) { var g = gid[r.fragment[j]]; if (g && !label[idx[j]]) label[idx[j]] = g; }
	});
	// duplicates across a seam: a fragment left with under half its points goes
	var have = new Uint32Array(kept.length + 1);
	for (i = 0; i < n; i++) if (label[i]) have[label[i]]++;
	var live = kept.map(function (f, q) { return { f: f, g: q + 1, keep: have[q + 1] >= 0.5 * f.count }; }).filter(function (e) { return e.keep; });
	live.sort(function (p, q) { return q.f.size - p.f.size || q.f.count - p.f.count || p.g - q.g; });
	var newId = new Uint32Array(kept.length + 1), fragments = [];
	live.forEach(function (e, q) {
		newId[e.g] = q + 1;
		var f = Object.assign({}, e.f, { id: q + 1 });
		delete f.sheet; delete f.facets;
		fragments.push(f);
	});
	var fragment = new Uint32Array(n);
	for (i = 0; i < n; i++) if (label[i]) fragment[i] = newId[label[i]];

	// plan areas: cells of 1.5 spacings on the tiles' plane holding points; in none, those with no point in a fragment
	var px = CELL_SPACINGS * spacing, GW = Math.floor(du / px) + 1, GH = Math.floor(dv / px) + 1;
	while (GW * GH > MAX_CELLS) { px *= 2; GW = Math.floor(du / px) + 1; GH = Math.floor(dv / px) + 1; }
	var hit = new Uint8Array(GW * GH), held = new Uint8Array(GW * GH), cells = 0, none = 0;
	for (i = 0; i < n; i++) {
		var q2 = Math.floor((V[i * st] - v0) / px) * GW + Math.floor((U[i * st] - u0) / px);
		hit[q2] = 1; if (fragment[i]) held[q2] = 1;
	}
	for (k = 0; k < hit.length; k++) if (hit[k]) { cells++; if (!held[k]) none++; }
	planeDistances.sort(function (p, q) { return p - q; });
	var out = { fragment: fragment, fragments: fragments, surfaceArea: cells * px * px, unassignedArea: none * px * px, method: method,
		facets: null, planeDistance: planeDistances.length ? planeDistances[Math.floor((planeDistances.length - 1) / 2)] : NaN };
	if (method !== "facets") out.cell = cell;
	if (method === "hybrid") {
		out.fromWatershed = fragments.filter(function (f) { return f.from === "watershed"; }).length;
		out.fromFacets = fragments.length - out.fromWatershed;
	}
	var given = { sideOn: sideOn };
	if (method !== "watershed" && opts.maxDistance !== undefined) given.maxDistance = opts.maxDistance;
	if (method === "watershed") given.ignored = FACET_ONLY.filter(function (key) { return opts[key] !== undefined; });
	return Object.assign(resultFields(out, spacing, given), { tiles: NT, threads: pool ? Math.min(threads, NT) : 1 });
}

// findFragments' own options: no function (it cannot go to a worker) and none of this module's
function strip(opts) {
	var o = {};
	Object.keys(opts).forEach(function (key) { if (key !== "onProgress" && key !== "threads" && key !== "tile" && key !== "overlap") o[key] = opts[key]; });
	return o;
}
