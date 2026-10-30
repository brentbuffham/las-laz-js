// src/tiles/regionJobs.js
//==========================================================
// One work tile of a parallel run on a tile store, as a worker runs it
// (or this thread, for a store no worker can open): its region read at
// full density (region.js), findFragments or findFacets on it, and only
// what the stitch needs back, keyed by (node, index in node), so the
// main thread never holds the cloud:
// - fragments: the fragments whose centroid is in the tile's core, the
//   points they claim (any in the region), and the core's plan cells
//   (held: a point in a fragment) on the run's grid;
// - facets: each facet's points in the core (the owner claims), its core
//   part's plane sums, area and outline, and its points along each core
//   edge binned in seam cells (their mean), so pieces of one face in
//   neighbouring tiles can be joined without the points.
// Positions are local (minus origin); seam and grid cells are world.
//==========================================================

import { readRegion } from "./region.js";
import { findFragments } from "../fragments/findFragments.js";
import { findFacets } from "../facets/findFacets.js";
import { facetOutline } from "../facets/outline.js";
import { dedupeSelection } from "../filter/dedupe.js";
import { denoisePoints } from "../ops/denoise.js";
import { meanDistances } from "../ops/outliers.js";
import { selectSparse } from "../ops/sparse.js";
import { selectDoubleLayer } from "../ops/doubleLayer.js";
import { pointNormals } from "../ops/normals.js";

// the core points of a region, in region order, and a per-point value of them (Float32) as { node, index, value }
function coreValues(reg, L, a, value) {
	var U = reg[AXES[a[0]]], V = reg[AXES[a[1]]], keep = [], j;
	for (j = 0; j < reg.count; j++) if (inCore(L.core, U[j], V[j])) keep.push(j);
	var m = keep.length, out = { count: reg.count, node: new Uint32Array(m), index: new Uint32Array(m), value: new Float32Array(m) };
	keep.forEach(function (p, q) { out.node[q] = reg.node[p]; out.index[q] = reg.index[p]; out.value[q] = value[p]; });
	return out;
}
// the core points among a region selection, as { node, index }
function coreSelection(reg, L, a, sel) {
	var U = reg[AXES[a[0]]], V = reg[AXES[a[1]]], keep = [];
	for (var q = 0; q < sel.length; q++) { var p = sel[q]; if (inCore(L.core, U[p], V[p])) keep.push(p); }
	var out = { count: reg.count, node: new Uint32Array(keep.length), index: new Uint32Array(keep.length) };
	keep.forEach(function (p, i) { out.node[i] = reg.node[p]; out.index[i] = reg.index[p]; });
	return out;
}

/**
 * One tile of selectOutliersStore: each core point's mean distance to its k nearest (the overlap gives it its
 * neighbours across the seam), and the core's Welford sums for the cloud's mean and spread.
 * @returns {Promise<{count, node, index, value: Float32Array, n: number, M1: number, M2: number}>}
 */
export async function outlierRegion(store, t) {
	var reg = await readRegion(store, t.keys, t.which, t.axes, t.box, t.origin), L = local(t);
	var r = reg.count > t.k ? meanDistances({ count: reg.count, x: reg.x, y: reg.y, z: reg.z }, t.k, t.onProgress) : { means: new Float64Array(reg.count).fill(NaN) };
	var out = coreValues(reg, L, t.axes, r.means), n = 0, M1 = 0, M2 = 0, U = reg[AXES[t.axes[0]]], V = reg[AXES[t.axes[1]]];
	// the sums from the Float64 means (the Float32 values are for keeping)
	for (var q = 0; q < reg.count; q++) { var v = r.means[q]; if (!(v === v) || !inCore(L.core, U[q], V[q])) continue; n++; var d = v - M1; M1 += d / n; M2 += d * (v - M1); }
	return Object.assign(out, { n: n, M1: M1, M2: M2 });
}

/** One tile of selectSparseStore: selectSparse on the region (an overlap of one radius makes it exact), its core points. */
export async function sparseRegion(store, t) {
	var reg = await readRegion(store, t.keys, t.which, t.axes, t.box, t.origin), L = local(t);
	var sel = reg.count ? selectSparse({ count: reg.count, x: reg.x, y: reg.y, z: reg.z }, t.sparse) : new Uint32Array(0);
	if (t.onProgress) t.onProgress(1, 1);
	return coreSelection(reg, L, t.axes, sel);
}

/** One tile of roughnessStore: pointNormals' residual (each point's RMS distance from its neighbours' plane), its core points. */
export async function roughRegion(store, t) {
	var reg = await readRegion(store, t.keys, t.which, t.axes, t.box, t.origin), L = local(t);
	var res = reg.count ? pointNormals({ count: reg.count, x: reg.x, y: reg.y, z: reg.z }, Object.assign({}, t.normals, t.onProgress ? { onProgress: t.onProgress } : {})).residual : new Float32Array(0);
	return coreValues(reg, L, t.axes, res);
}

var AXES = ["x", "y", "z"];

function inCore(core, u, v) { return u >= core[0] && u < core[1] && v >= core[2] && v < core[3]; }
function local(t) {
	var o = [t.origin.x, t.origin.y, t.origin.z], a = t.axes;
	return { o: o, core: [t.core[0] - o[a[0]], t.core[1] - o[a[0]], t.core[2] - o[a[1]], t.core[3] - o[a[1]]] };
}

/**
 * One tile of findFragmentsParallel on a store.
 * @param {object} store - an open TileStore.
 * @param {{keys: string[], which: number[], axes: number[], box: number[], core: number[], origin: object, opts: object,
 *   grid: {px: number, u0: number, v0: number, W: number, H: number}, onProgress?: function(number, number)}} t
 * @returns {Promise<object>} { count, kept, node, index, gid, prio (1 = a core point), win, planeDistance, cell, sideOn }
 */
export async function fragmentsRegion(store, t) {
	var reg = await readRegion(store, t.keys, t.which, t.axes, t.box, t.origin), L = local(t), a = t.axes;
	var empty = { count: reg.count, kept: [], node: new Uint32Array(0), index: new Uint32Array(0), gid: new Uint32Array(0), core: new Uint8Array(0), win: null, planeDistance: NaN, cell: NaN, sideOn: false };
	if (reg.count < 9) return empty;
	var r = findFragments({ count: reg.count, x: reg.x, y: reg.y, z: reg.z }, Object.assign({}, t.opts, t.onProgress ? { onProgress: t.onProgress } : {}));
	var U = reg[AXES[a[0]]], V = reg[AXES[a[1]]], keptId = new Uint32Array(r.fragments.length + 1), kept = [], j;
	r.fragments.forEach(function (f) {
		if (!inCore(L.core, f.centroid[a[0]], f.centroid[a[1]])) return;
		var g = Object.assign({}, f);
		delete g.facets; delete g.sheet;
		kept.push(g); keptId[f.id] = kept.length;
	});
	var m = 0;
	for (j = 0; j < reg.count; j++) if (keptId[r.fragment[j]]) m++;
	var node = new Uint32Array(m), index = new Uint32Array(m), gid = new Uint32Array(m), core = new Uint8Array(m), q = 0;
	for (j = 0; j < reg.count; j++) {
		var k = keptId[r.fragment[j]];
		if (!k) continue;
		node[q] = reg.node[j]; index[q] = reg.index[j]; gid[q] = k; core[q] = inCore(L.core, U[j], V[j]) ? 1 : 0; q++;
	}
	// the core's plan cells on the run's grid (world), clipped to it
	var G = t.grid, ou = L.o[a[0]], ov = L.o[a[1]];
	var wu0 = Math.max(0, Math.floor((Math.max(t.core[0], G.u0) - G.u0) / G.px)), wu1 = Math.min(G.W - 1, Math.floor((Math.min(t.core[1], G.u0 + G.W * G.px) - G.u0) / G.px));
	var wv0 = Math.max(0, Math.floor((Math.max(t.core[2], G.v0) - G.v0) / G.px)), wv1 = Math.min(G.H - 1, Math.floor((Math.min(t.core[3], G.v0 + G.H * G.px) - G.v0) / G.px));
	var win = null;
	if (wu1 >= wu0 && wv1 >= wv0) {
		var WW = wu1 - wu0 + 1, WH = wv1 - wv0 + 1, hit = new Uint8Array(WW * WH), held = new Uint8Array(WW * WH);
		for (j = 0; j < reg.count; j++) {
			if (!inCore(L.core, U[j], V[j])) continue;
			var cu = Math.floor((U[j] + ou - G.u0) / G.px) - wu0, cv = Math.floor((V[j] + ov - G.v0) / G.px) - wv0;
			if (cu < 0 || cv < 0 || cu >= WW || cv >= WH) continue;
			hit[cv * WW + cu] = 1; if (r.fragment[j]) held[cv * WW + cu] = 1;
		}
		win = { u0: wu0, v0: wv0, W: WW, H: WH, hit: hit, held: held };
	}
	return { count: reg.count, kept: kept, node: node, index: index, gid: gid, core: core, win: win, planeDistance: r.planeDistance, cell: r.cell,
		sideOn: r.warnings.some(function (w) { return w.code === "SIDE_ON"; }) };
}

/**
 * One tile of dedupeStore: dedupe (first point wins) on the region, whose points come in the store's own order
 * (node, then index in node) in every tile, so neighbouring tiles agree on which of two points stays; the points
 * it drops that lie in the core.
 * @param {object} store - an open TileStore.
 * @param {{keys: string[], which: number[], axes: number[], box: number[], core: number[], origin: object, tolerance: number,
 *   z?: boolean}} t
 * @returns {Promise<{count: number, node: Uint32Array, index: Uint32Array}>} the dropped core points
 */
export async function dedupeRegion(store, t) {
	var reg = await readRegion(store, t.keys, t.which, t.axes, t.box, t.origin), L = local(t), a = t.axes;
	if (!reg.count) return { count: 0, node: new Uint32Array(0), index: new Uint32Array(0) };
	var keep = dedupeSelection({ count: reg.count, x: reg.x, y: reg.y, z: reg.z }, t.tolerance, { z: !!t.z }).keep;
	var kept = new Uint8Array(reg.count), U = reg[AXES[a[0]]], V = reg[AXES[a[1]]], out = [], j;
	for (j = 0; j < keep.length; j++) kept[keep[j]] = 1;
	for (j = 0; j < reg.count; j++) if (!kept[j] && inCore(L.core, U[j], V[j])) out.push(j);
	var node = new Uint32Array(out.length), index = new Uint32Array(out.length);
	out.forEach(function (p, q) { node[q] = reg.node[p]; index[q] = reg.index[p]; });
	if (t.onProgress) t.onProgress(1, 1);
	return { count: reg.count, node: node, index: index };
}

/**
 * One tile of smoothStore: denoisePoints on the region (the overlap gives the core points their neighbours); the core
 * points that moved, with their new positions (local).
 * @param {object} store - an open TileStore.
 * @param {{keys: string[], which: number[], axes: number[], box: number[], core: number[], origin: object, denoise: object}} t
 * @returns {Promise<{count: number, node: Uint32Array, index: Uint32Array, x: Float64Array, y: Float64Array, z: Float64Array}>}
 */
export async function smoothRegion(store, t) {
	var reg = await readRegion(store, t.keys, t.which, t.axes, t.box, t.origin), L = local(t), a = t.axes, j;
	var none = { count: reg.count, node: new Uint32Array(0), index: new Uint32Array(0), x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) };
	if (reg.count < 3) return none;
	var out = denoisePoints({ count: reg.count, x: reg.x, y: reg.y, z: reg.z }, Object.assign({}, t.denoise, t.onProgress ? { onProgress: t.onProgress } : {}));
	var U = reg[AXES[a[0]]], V = reg[AXES[a[1]]], moved = [];
	for (j = 0; j < reg.count; j++) if (inCore(L.core, U[j], V[j]) && (out.x[j] !== reg.x[j] || out.y[j] !== reg.y[j] || out.z[j] !== reg.z[j])) moved.push(j);
	var m = moved.length, r = { count: reg.count, node: new Uint32Array(m), index: new Uint32Array(m), x: new Float64Array(m), y: new Float64Array(m), z: new Float64Array(m) };
	moved.forEach(function (p, q) { r.node[q] = reg.node[p]; r.index[q] = reg.index[p]; r.x[q] = out.x[p]; r.y[q] = out.y[p]; r.z[q] = out.z[p]; });
	return r;
}


/**
 * One tile of selectDoubleLayerStore: selectDoubleLayer on the region (the overlap gives the core's cells their
 * neighbours; the anchor keeps every tile on one grid). The ghost points in the core and, with partner, the kept-layer
 * points beside them, together: node, index, local x, y, z, the offset dz, the kept layer's height dom (local), and kind
 * (1 a ghost point, 2 a kept-layer point).
 * @returns {Promise<{count: number, node: Uint32Array, index: Uint32Array, x: Float32Array, y: Float32Array, z: Float32Array, dz: Float32Array, dom: Float32Array, kind: Uint8Array}>}
 */
export async function doubleRegion(store, t) {
	var reg = await readRegion(store, t.keys, t.which, t.axes, t.box, t.origin), L = local(t), a = t.axes;
	var U = reg[AXES[a[0]]], V = reg[AXES[a[1]]], keep = [];
	var f = reg.count >= 2 * (t.double.minPoints || 5) ? selectDoubleLayer({ count: reg.count, x: reg.x, y: reg.y, z: reg.z }, Object.assign({}, t.double, { anchor: t.anchor })) : null;
	if (t.onProgress) t.onProgress(1, 1);
	var lim = t.limit, o = t.origin;
	function inLimit(p) {
		return !lim || (reg.x[p] + o.x >= lim.minX && reg.x[p] + o.x <= lim.maxX && reg.y[p] + o.y >= lim.minY && reg.y[p] + o.y <= lim.maxY && reg.z[p] + o.z >= lim.minZ && reg.z[p] + o.z <= lim.maxZ);
	}
	function take(sel, dz, dom, kind) {
		for (var q = 0; q < sel.length; q++) if (inCore(L.core, U[sel[q]], V[sel[q]]) && inLimit(sel[q])) keep.push({ p: sel[q], dz: dz[q], dom: dom ? dom[q] : NaN, kind: kind });
	}
	if (f) { take(f.selection, f.dz, f.dominantZ, 1); if (t.partner) take(f.partner.selection, f.partner.dz, null, 2); }
	var m = keep.length, r = { count: reg.count, node: new Uint32Array(m), index: new Uint32Array(m), x: new Float32Array(m), y: new Float32Array(m), z: new Float32Array(m),
		dz: new Float32Array(m), dom: new Float32Array(m), kind: new Uint8Array(m) };
	keep.forEach(function (k, i) {
		r.node[i] = reg.node[k.p]; r.index[i] = reg.index[k.p]; r.x[i] = reg.x[k.p]; r.y[i] = reg.y[k.p]; r.z[i] = reg.z[k.p]; r.dz[i] = k.dz; r.dom[i] = k.dom; r.kind[i] = k.kind;
	});
	return r;
}

/** The region jobs by name (the worker's op). */
export var REGION_JOBS = { fragmentsRegion: fragmentsRegion, facetsRegion: facetsRegion, dedupeRegion: dedupeRegion, smoothRegion: smoothRegion,
	outlierRegion: outlierRegion, sparseRegion: sparseRegion, roughRegion: roughRegion, doubleRegion: doubleRegion };

/**
 * One tile of findFacetsParallel on a store.
 * @param {object} store - an open TileStore.
 * @param {{keys: string[], which: number[], axes: number[], box: number[], core: number[], origin: object, opts: object,
 *   seam: number, onProgress?: function(number, number)}} t - seam: the seam cells' width (world, maxDistance).
 * @returns {Promise<object>} { count, facets (findFacets' own), parts (per facet id), node, index, fid (the core's
 *   claims), planeDistance, outlineCell }; a part { count, sums [s1 s2 s3 s11 s12 s13 s22 s23 s33] (local), whole (no
 *   point outside the core), area, outline (the core part's, when not whole), seams { u0, u1, v0, v1: [cell, mx, my,
 *   mz, n, ...] } }
 */
export async function facetsRegion(store, t) {
	var reg = await readRegion(store, t.keys, t.which, t.axes, t.box, t.origin), L = local(t), a = t.axes;
	if (reg.count < 9) return { count: reg.count, facets: [], parts: [], node: new Uint32Array(0), index: new Uint32Array(0), fid: new Uint32Array(0), planeDistance: NaN, outlineCell: NaN };
	var r = findFacets({ count: reg.count, x: reg.x, y: reg.y, z: reg.z }, Object.assign({}, t.opts, t.onProgress ? { onProgress: t.onProgress } : {}));
	var U = reg[AXES[a[0]]], V = reg[AXES[a[1]]], X = reg.x, Y = reg.y, Z = reg.z, F = r.facets.length, j;
	var parts = [], members = [], m = 0, d = t.seam, ou = L.o[a[0]], ov = L.o[a[1]], C = L.core;
	for (var f = 0; f <= F; f++) { parts.push(f ? { count: 0, sums: [0, 0, 0, 0, 0, 0, 0, 0, 0], whole: true, area: 0, outline: null, seams: { u0: new Map(), u1: new Map(), v0: new Map(), v1: new Map() } } : null); members.push([]); }
	function seamAdd(map, cell, j) { var s = map.get(cell); if (!s) map.set(cell, s = [0, 0, 0, 0]); s[0] += X[j]; s[1] += Y[j]; s[2] += Z[j]; s[3]++; }
	for (j = 0; j < reg.count; j++) {
		var id = r.facet[j];
		if (!id) continue;
		var p = parts[id], u = U[j], v = V[j];
		if (!inCore(C, u, v)) { p.whole = false; continue; }
		m++; members[id].push(j);
		var x = X[j], y = Y[j], z = Z[j], s = p.sums;
		p.count++; s[0] += x; s[1] += y; s[2] += z; s[3] += x * x; s[4] += x * y; s[5] += x * z; s[6] += y * y; s[7] += y * z; s[8] += z * z;
		// along the core's edges, in world seam cells along the edge
		if (u - C[0] < d) seamAdd(p.seams.u0, Math.floor((v + ov) / d), j);
		if (C[1] - u <= d) seamAdd(p.seams.u1, Math.floor((v + ov) / d), j);
		if (v - C[2] < d) seamAdd(p.seams.v0, Math.floor((u + ou) / d), j);
		if (C[3] - v <= d) seamAdd(p.seams.v1, Math.floor((u + ou) / d), j);
	}
	var node = new Uint32Array(m), index = new Uint32Array(m), fid = new Uint32Array(m), q = 0;
	for (j = 0; j < reg.count; j++) { var k = r.facet[j]; if (k && inCore(C, U[j], V[j])) { node[q] = reg.node[j]; index[q] = reg.index[j]; fid[q] = k; q++; } }
	var cell = r.outlineCell > 0 ? r.outlineCell : t.opts.maxDistance;
	for (f = 1; f <= F; f++) {
		var pt = parts[f], fc = r.facets[f - 1];
		if (pt.whole) { pt.area = fc.area; }
		else if (pt.count) {
			var c = pt.count, cen = [pt.sums[0] / c, pt.sums[1] / c, pt.sums[2] / c];
			var shape = facetOutline(X, Y, Z, 1, Uint32Array.from(members[f]), cen, fc.normal, cell);
			pt.area = shape.area; pt.outline = shape.outline;
		}
		var flat = {};
		["u0", "u1", "v0", "v1"].forEach(function (e) {
			var out = [];
			pt.seams[e].forEach(function (s, cellId) { out.push(cellId, s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3]); });
			flat[e] = out;
		});
		pt.seams = flat;
	}
	return { count: reg.count, facets: r.facets, parts: parts, node: node, index: index, fid: fid, planeDistance: r.planeDistance, outlineCell: r.outlineCell };
}
