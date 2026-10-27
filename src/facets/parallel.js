// src/facets/parallel.js
//==========================================================
// findFacetsParallel: findFacets on every core. Work tiles on the
// cloud's two widest axes (src/index/planTiles.js), each grown by an
// overlap, run in the LAZ worker pool with one planeDistance for all.
// A face wider than a tile is found in pieces, one a tile; pieces that
// share points in an overlap and lie within maxAngle of each other are
// joined (union-find), so a bench face or a wall stays one facet. Each
// point takes the facet of the tile whose core holds it; each joined
// facet is measured again on its own points (plane fit, orientation,
// outline), and one left under minPoints or minArea goes. Ids by area,
// largest first, as findFacets.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf } from "../index/grid.js";
import { planTiles, runTiles } from "../index/planTiles.js";
import { defaultThreads } from "../laz/pool.js";
import { estimateNoise, smallestEigen } from "../ops/normals.js";
import { findFacets, checkFacetOptions } from "./findFacets.js";
import { poleOf, orientationOf } from "./orientation.js";
import { facetOutline } from "./outline.js";

var MIN_TILE_POINTS = 200000, SHARED = 5, D = Math.PI / 180;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/**
 * findFacets split over tiles and run in parallel workers (browser Web Workers or Node worker_threads).
 * @param {object} cols - point columns, as findFacets.
 * @param {object} opts - findFacets' options, and: threads (default one fewer than the cores, at most 16; 1 runs
 *   here), tile (a core's side, m; default about two tiles a thread, at least 4 overlaps), overlap (m each side;
 *   default max(0.5, 5 x maxDistance)), onProgress(done, total) (tiles).
 * @returns {Promise<object>} findFacets' result (facet, facets, planeDistance) plus tiles and threads.
 */
export async function findFacetsParallel(cols, opts) {
	if (opts === undefined || opts === null || typeof opts !== "object") throw bad("findFacetsParallel needs options: { maxDistance, … }");
	var o = checkFacetOptions(cols, opts), n = cols.count;
	var threads = opts.threads === undefined ? await defaultThreads() : opts.threads;
	if (!Number.isInteger(threads) || threads < 1) throw bad("threads must be a whole number >= 1, not " + JSON.stringify(opts.threads));
	var M = opts.overlap === undefined ? Math.max(0.5, 5 * o.maxDistance) : opts.overlap;
	if (!(typeof M === "number" && M >= 0 && isFinite(M))) throw bad("overlap must be a distance >= 0, not " + JSON.stringify(opts.overlap));
	if (opts.tile !== undefined && !(typeof opts.tile === "number" && opts.tile > 0 && isFinite(opts.tile))) throw bad("tile must be a positive distance, not " + JSON.stringify(opts.tile));
	// precomputed normals are per point of the whole cloud; a small cloud: findFacets as it is
	if (o.normals || n < 2 * MIN_TILE_POINTS && opts.tile === undefined) return Object.assign(findFacets(cols, strip(opts)), { tiles: 1, threads: 1 });

	// one plane distance for every tile
	var pd = o.planeDistance;
	if (pd === undefined) { var noise = estimateNoise(cols, { k: o.k, maxDistance: o.maxDistance }); pd = noise > 0 ? 3 * noise : o.maxDistance / 10; }
	var plan = planTiles(cols, opts.tile !== undefined ? opts.tile : function (du, dv) { return Math.max(4 * M, Math.sqrt(du * dv / (2 * threads))); }, M, "findFacetsParallel");
	var tileOpts = Object.assign(strip(opts), { planeDistance: pd });
	if (plan.NT === 1 || threads === 1 && opts.tile === undefined) return Object.assign(findFacets(cols, tileOpts), { tiles: 1, threads: 1 });
	var ran = await runTiles(plan, threads, function (pool, task) { return pool.facets(Object.assign(task, { opts: tileOpts })); },
		function (tc) { return findFacets(tc, tileOpts); }, opts.onProgress);
	var results = ran.results, members = plan.members, i, j, t;

	// a node per (tile, facet); each point's owner is its core tile's facet
	var base = new Uint32Array(plan.NT + 1);
	for (t = 0; t < plan.NT; t++) base[t + 1] = base[t] + (results[t] ? results[t].facets.length : 0);
	var nodes = base[plan.NT], parent = new Uint32Array(nodes + 1), normal = new Float64Array(3 * (nodes + 1)), owner = new Uint32Array(n);
	var piece = new Array(nodes + 1), cells = [];
	for (i = 0; i <= nodes; i++) parent[i] = i;
	function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
	results.forEach(function (r, ti) {
		if (!r) return;
		if (r.outlineCell > 0) cells.push(r.outlineCell);
		r.facets.forEach(function (f) { var q = base[ti] + f.id; piece[q] = f; normal[3 * q] = f.normal[0]; normal[3 * q + 1] = f.normal[1]; normal[3 * q + 2] = f.normal[2]; });
		var idx = members[ti];
		for (j = 0; j < idx.length; j++) if (r.facet[j] && plan.coreTile(idx[j]) === ti) owner[idx[j]] = base[ti] + r.facet[j];
	});
	// pieces of one face: points shared in an overlap, normals within maxAngle
	var shared = new Map(), cosA = Math.cos(o.maxAngle * D);
	results.forEach(function (r, ti) {
		if (!r) return;
		var idx = members[ti];
		for (j = 0; j < idx.length; j++) {
			var a = owner[idx[j]], b = r.facet[j] ? base[ti] + r.facet[j] : 0;
			if (!a || !b || a === b) continue;
			var key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
			shared.set(key, (shared.get(key) || 0) + 1);
		}
	});
	shared.forEach(function (c, key) {
		if (c < SHARED) return;
		var a = Math.floor(key / 4294967296), b = key - a * 4294967296;
		if (Math.abs(normal[3 * a] * normal[3 * b] + normal[3 * a + 1] * normal[3 * b + 1] + normal[3 * a + 2] * normal[3 * b + 2]) < cosA) return;
		var ra = find(a), rb = find(b);
		if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
	});

	// the joined facets, measured again on their own points
	// a facet in one piece holding the same points as in its tile is that tile's facet, as it is
	var root = new Uint32Array(n), counts = new Map(), owners = new Map();
	for (i = 0; i < n; i++) if (owner[i]) {
		var rt = find(owner[i]); root[i] = rt; counts.set(rt, (counts.get(rt) || 0) + 1);
		var os = owners.get(rt);
		if (!os) owners.set(rt, os = new Set());
		os.add(owner[i]);
	}
	var keys = Array.from(counts.keys()).filter(function (k) { return counts.get(k) >= o.minPoints; }), slot = new Map();
	keys.forEach(function (k, s) { slot.set(k, s); });
	var start = new Uint32Array(keys.length + 1);
	keys.forEach(function (k, s) { start[s + 1] = start[s] + counts.get(k); });
	var order = new Uint32Array(start[keys.length]), at = start.slice();
	for (i = 0; i < n; i++) if (root[i] && slot.has(root[i])) order[at[slot.get(root[i])]++] = i;
	var co = coordsOf(cols, "findFacetsParallel"), X = co.x, Y = co.y, Z = co.z, st = co.stride;
	cells.sort(function (p, q) { return p - q; });
	var cell = o.outlineCell || (cells.length ? cells[Math.floor((cells.length - 1) / 2)] : o.maxDistance), cov = new Float64Array(6), eig = new Float64Array(5), found = [];
	keys.forEach(function (k, s) {
		var pts = order.subarray(start[s], start[s + 1]), c = pts.length, p0 = pts[0] * st, sx = X[p0], sy = Y[p0], sz = Z[p0];
		var os = owners.get(k);
		if (os.size === 1) {
			var whole = piece[os.values().next().value];
			if (whole && whole.count === c) { found.push(Object.assign({ k: k }, whole)); return; }
		}
		var s1 = 0, s2 = 0, s3 = 0, s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0;
		for (var q = 0; q < c; q++) {
			var p = pts[q] * st, dx = X[p] - sx, dy = Y[p] - sy, dz = Z[p] - sz;
			s1 += dx; s2 += dy; s3 += dz; s11 += dx * dx; s12 += dx * dy; s13 += dx * dz; s22 += dy * dy; s23 += dy * dz; s33 += dz * dz;
		}
		var cx = s1 / c, cy = s2 / c, cz = s3 / c;
		cov[0] = s11 / c - cx * cx; cov[1] = s12 / c - cx * cy; cov[2] = s13 / c - cx * cz; cov[3] = s22 / c - cy * cy; cov[4] = s23 / c - cy * cz; cov[5] = s33 / c - cz * cz;
		if (!smallestEigen(cov, eig)) return;
		var nrm = poleOf([eig[0], eig[1], eig[2]]), centroid = [sx + cx, sy + cy, sz + cz];
		var shape = facetOutline(X, Y, Z, st, pts, centroid, nrm, cell);
		if (shape.area < o.minArea) return;
		var or = orientationOf(nrm);
		found.push({ k: k, count: c, normal: nrm, centroid: centroid, dip: or.dip, dipDirection: or.dipDirection, area: shape.area, rms: Math.sqrt(Math.max(0, eig[3])), outline: shape.outline });
	});
	found.sort(function (a, b) { return b.area - a.area || a.k - b.k; });
	var idOf = new Map(), facets = found.map(function (f, w) {
		idOf.set(f.k, w + 1);
		return { id: w + 1, count: f.count, normal: f.normal, centroid: f.centroid, dip: f.dip, dipDirection: f.dipDirection, area: f.area, rms: f.rms, outline: f.outline };
	});
	var facet = new Uint32Array(n);
	for (i = 0; i < n; i++) if (root[i]) facet[i] = idOf.get(root[i]) || 0;
	return { facet: facet, facets: facets, planeDistance: pd, tiles: plan.NT, threads: ran.threads };
}

// findFacets' own options: no function (it cannot go to a worker) and none of this module's
function strip(opts) {
	var o = {};
	Object.keys(opts).forEach(function (key) { if (key !== "onProgress" && key !== "threads" && key !== "tile" && key !== "overlap") o[key] = opts[key]; });
	return o;
}
