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
import { defaultThreads } from "../laz/pool.js";
import { planTiles, runTiles } from "../index/planTiles.js";
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
	var n = cols.count, st = coordsOf(cols, "findFragmentsParallel").stride;
	var threads = opts.threads === undefined ? await defaultThreads() : opts.threads;
	if (!Number.isInteger(threads) || threads < 1) throw bad("threads must be a whole number >= 1, not " + JSON.stringify(opts.threads));
	var method = opts.method === undefined ? "facets" : opts.method;
	var spacing = pointSpacing(cols);
	// precomputed normals are per point of the whole cloud; too few points or one thread: findFragments as it is
	if (opts.normals !== undefined || !(spacing > 0) || n < 2 * MIN_TILE_POINTS && opts.tile === undefined) return Object.assign(findFragments(cols, strip(opts)), { tiles: 1, threads: 1 });

	var rr = opts.reliefRadius === undefined ? 1 : opts.reliefRadius;
	var M = opts.overlap === undefined ? Math.max(2.5, rr + 1.5) : opts.overlap;
	if (!(typeof M === "number" && M >= 0 && isFinite(M))) throw bad("overlap must be a distance >= 0, not " + JSON.stringify(opts.overlap));
	if (opts.tile !== undefined && !(typeof opts.tile === "number" && opts.tile > 0 && isFinite(opts.tile))) throw bad("tile must be a positive distance, not " + JSON.stringify(opts.tile));
	var plan = planTiles(cols, opts.tile !== undefined ? opts.tile : function (du, dv) { return Math.max(4 * M, Math.sqrt(du * dv / (2 * threads))); }, M, "findFragmentsParallel");
	var NT = plan.NT, members = plan.members, order = plan.order, U = plan.U, V = plan.V, u0 = plan.u0, v0 = plan.v0, du = plan.du, dv = plan.dv, i, k;
	if (NT === 1 || threads === 1 && opts.tile === undefined) return Object.assign(findFragments(cols, Object.assign(strip(opts), { spacing: spacing })), { tiles: 1, threads: 1 });

	// run them: the pool, or here
	var tileOpts = Object.assign(strip(opts), { spacing: spacing });
	var ran = await runTiles(plan, threads, function (pool, task) { return pool.fragments(Object.assign(task, { opts: tileOpts })); },
		function (tc) { return findFragments(tc, tileOpts); }, opts.onProgress);
	var results = ran.results;

	// stitch: keep each tile's fragments whose centroid is in its core; the first claim on a point holds
	var label = new Uint32Array(n), kept = [], planeDistances = [], sideOn = false, cell = NaN;
	results.forEach(function (r, ti) {
		if (!r) return;
		var idx = members[ti];
		if (r.planeDistance > 0) planeDistances.push(r.planeDistance);
		if (r.warnings.some(function (w) { return w.code === "SIDE_ON"; })) sideOn = true;
		if (r.cell > 0) cell = r.cell;
		var gid = new Uint32Array(r.fragments.length + 1);
		r.fragments.forEach(function (f) {
			if (plan.inCore(ti, f.centroid[order[0]], f.centroid[order[1]])) { kept.push(f); gid[f.id] = kept.length; }
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
	return Object.assign(resultFields(out, spacing, given), { tiles: NT, threads: ran.threads });
}

// findFragments' own options: no function (it cannot go to a worker) and none of this module's
function strip(opts) {
	var o = {};
	Object.keys(opts).forEach(function (key) { if (key !== "onProgress" && key !== "threads" && key !== "tile" && key !== "overlap") o[key] = opts[key]; });
	return o;
}
