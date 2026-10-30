// src/tiles/storeOps.js
//==========================================================
// Whole-cloud edits on a tile store, on the parallel runs' work tiles
// (parallelStore.js: each worker opens the store and reads its tile and
// an overlap; this thread gathers the result and makes one edit, so the
// store has one writer and is never read whole):
// - dedupeStore: dedupe's rule (first point wins, within tolerance, XY
//   or 3D) over the whole store; the tiles agree on the winner because
//   every region lists its points in the store's own order.
// - smoothStore: denoisePoints over the whole store, each tile with an
//   overlap that gives its core points their neighbours, one sigma for
//   all (measured once). A store edit replaces node files, so nothing is
//   written while the workers read: each tile's moved points wait in
//   scratch beside the store (scratchBlobs.js), then setPositions writes
//   them in batches of batchPoints once every tile is read. A run over
//   more than one batch is not one edit; an abort before the writes
//   leaves the store untouched.
// - selectOutliersStore: selectOutliers' rule (PDAL statistical: a
//   point's mean distance to its k nearest above the cloud's mean plus
//   multiplier standard deviations); each tile measures its core points
//   with an overlap for their neighbours, the cloud's mean and spread
//   come from every tile's Welford sums combined, then one threshold.
// - selectSparseStore: selectSparse (fewer than minNeighbours within
//   radius), exact with an overlap of one radius.
// - roughnessStore: each point's plane residual (pointNormals), per node
//   and, with column, written to the store as an added f32 column.
// The selections are the store's own ({ deletes, count, tiles }), for
// store.deletePoints.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { layout, runAll, common } from "./parallelStore.js";
import { estimateNoise } from "../ops/normals.js";
import { suggestDoubleLayer, addDoubleLayerStats } from "../ops/doubleLayer.js";
import { scratchBlobs } from "./scratchBlobs.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
var BATCH_POINTS = 10000000;

/**
 * Drop the points within tolerance of a point kept before them, over a whole tile store.
 * @param {object} store - an open TileStore.
 * @param {number} tolerance - as dedupe (> 0).
 * @param {{z?: boolean, apply?: boolean, threads?: number, tile?: number, tilePoints?: number, onProgress?: function(number, number),
 *   signal?: AbortSignal}} [opts] - z: compare in 3D; apply (default true): delete them (one edit, where the store's
 *   edits run: a Worker for OPFS); false: only find them.
 * @returns {Promise<{removed: number, selection: {deletes: number, count: number, tiles: object}, tiles: number, threads: number}>}
 */
export async function dedupeStore(store, tolerance, opts) {
	var o = opts || {};
	if (!(typeof tolerance === "number" && tolerance > 0 && isFinite(tolerance))) throw bad("tolerance must be a distance > 0, not " + JSON.stringify(tolerance));
	var threads = await common(store, o, "dedupeStore");
	var L = await layout(store, o, threads, 2 * tolerance);
	var sel = { deletes: store.manifest.deletes, count: 0, tiles: {} };
	if (!L.n) return { removed: 0, selection: sel, tiles: 0, threads: 1 };
	var lists = L.nodes.keys.map(function () { return []; });
	var ran = await runAll(store, L, o, threads, "dedupeRegion", function (t) {
		return { which: t.which, axes: L.axes, box: t.box, core: t.core, origin: L.origin, tolerance: tolerance, z: !!o.z };
	}, function (r) { for (var q = 0; q < r.node.length; q++) lists[r.node[q]].push(r.index[q]); });
	lists.forEach(function (l, i) {
		if (!l.length) return;
		var a = Uint32Array.from(l).sort();
		sel.tiles[L.nodes.keys[i]] = a; sel.count += a.length;
	});
	if (o.apply !== false && sel.count) await store.deletePoints(sel);
	return { removed: sel.count, selection: sel, tiles: L.tiles.length, threads: ran };
}

/**
 * denoisePoints over a whole tile store: the points move in the store (setPositions).
 * @param {object} store - an open TileStore (where its edits run: a Worker for OPFS).
 * @param {{method?: string, k?: number, maxDistance: number, sigma?: number, iterations?: number, batchPoints?: number,
 *   threads?: number, tile?: number, tilePoints?: number, onProgress?: function(number, number), signal?: AbortSignal}} opts -
 *   denoisePoints' options (sigma measured once on the store when not given); batchPoints (10 M): moved points a write.
 * @returns {Promise<{moved: number, sigma: number, batches: number, tiles: number, threads: number}>}
 */
export async function smoothStore(store, opts) {
	var o = opts || {};
	if (!(typeof o.maxDistance === "number" && o.maxDistance > 0 && isFinite(o.maxDistance))) throw bad("maxDistance must be a distance > 0, not " + JSON.stringify(o.maxDistance));
	var iterations = o.iterations === undefined ? 1 : o.iterations, k = o.k === undefined ? 16 : o.k, batch = o.batchPoints === undefined ? BATCH_POINTS : o.batchPoints;
	if (!(Number.isInteger(batch) && batch >= 1)) throw bad("batchPoints must be a whole number >= 1, not " + JSON.stringify(o.batchPoints));
	if (!(Number.isInteger(iterations) && iterations >= 1)) throw bad("iterations must be a whole number >= 1, not " + JSON.stringify(o.iterations));
	var threads = await common(store, o, "smoothStore");
	var L = await layout(store, o, threads, (iterations + 1) * o.maxDistance);
	if (!L.n) return { moved: 0, sigma: NaN, batches: 0, tiles: 0, threads: 1 };
	var sigma = o.sigma !== undefined ? o.sigma : estimateNoise(L.sample, { k: k, maxDistance: o.maxDistance });
	var den = { method: o.method, k: k, maxDistance: o.maxDistance, iterations: iterations };
	if (sigma > 0) den.sigma = sigma;
	var pending = [], held = 0, moved = 0, batches = 0, ox = L.origin.x, oy = L.origin.y, oz = L.origin.z, blobs = await scratchBlobs(store.where);
	async function flush() {
		if (!held) return;
		var parts = pending; pending = []; held = 0;
		var byNode = new Map();
		parts.forEach(function (r) { for (var q = 0; q < r.node.length; q++) { var l = byNode.get(r.node[q]); if (!l) byNode.set(r.node[q], l = []); l.push([r.index[q], r.x[q] + ox, r.y[q] + oy, r.z[q] + oz]); } });
		var value = {};
		byNode.forEach(function (l, nd) {
			l.sort(function (a, b) { return a[0] - b[0]; });
			var v = { index: new Uint32Array(l.length), x: new Float64Array(l.length), y: new Float64Array(l.length), z: new Float64Array(l.length) };
			l.forEach(function (e, i) { v.index[i] = e[0]; v.x[i] = e[1]; v.y[i] = e[2]; v.z[i] = e[3]; });
			value[L.nodes.keys[nd]] = v;
		});
		batches++;
		await store.setPositions(value);
	}
	try {
		// a tile's moved points to scratch: count, node, index (u32), x, y, z (f32, local)
		var ran = await runAll(store, L, o, threads, "smoothRegion", function (t) {
			return { which: t.which, axes: L.axes, box: t.box, core: t.core, origin: L.origin, denoise: den };
		}, function (r, i) {
			var m = r.node.length;
			if (!m) return;
			var buf = new ArrayBuffer(4 + 20 * m), head = new Uint32Array(buf, 0, 1);
			head[0] = m;
			new Uint32Array(buf, 4, m).set(r.node); new Uint32Array(buf, 4 + 4 * m, m).set(r.index);
			new Float32Array(buf, 4 + 8 * m, m).set(r.x); new Float32Array(buf, 4 + 12 * m, m).set(r.y); new Float32Array(buf, 4 + 16 * m, m).set(r.z);
			moved += m;
			return blobs.put("t" + i, new Uint8Array(buf));
		});
		// every tile read: the writes, a batch at a time
		for (var i = 0; i < L.tiles.length; i++) {
			var bytes = await blobs.get("t" + i).catch(function () { return null; });
			if (!bytes) continue;
			var b = bytes.slice().buffer, m = new Uint32Array(b, 0, 1)[0];
			pending.push({ node: new Uint32Array(b, 4, m), index: new Uint32Array(b, 4 + 4 * m, m), x: new Float32Array(b, 4 + 8 * m, m), y: new Float32Array(b, 4 + 12 * m, m), z: new Float32Array(b, 4 + 16 * m, m) });
			held += m;
			await blobs.remove("t" + i);
			if (held >= batch) await flush();
		}
		await flush();
	} finally {
		await blobs.close();
	}
	return { moved: moved, sigma: sigma, batches: batches, tiles: L.tiles.length, threads: ran };
}

// per node arrays from region results { node, index, value }
function perNode(L, Arr, fill) { return L.nodes.counts.map(function (c) { var a = new Arr(c); if (fill !== undefined) a.fill(fill); return a; }); }
function selectionOf(store, L, lists) {
	var sel = { deletes: store.manifest.deletes, count: 0, tiles: {} };
	lists.forEach(function (l, i) { if (!l.length) return; var a = Uint32Array.from(l).sort(); sel.tiles[L.nodes.keys[i]] = a; sel.count += a.length; });
	return sel;
}

/**
 * selectOutliers over a whole tile store.
 * @param {object} store - an open TileStore.
 * @param {{k?: number, multiplier?: number, overlap?: number, threads?: number, tile?: number, tilePoints?: number,
 *   onProgress?: function(number, number), signal?: AbortSignal}} [opts] - k 8, multiplier 2 (PDAL's); overlap
 *   (default 30 point spacings, at least 0.5): enough for a core point's k nearest across the seam.
 * @returns {Promise<{selection: object, count: number, mean: number, sd: number, threshold: number, tiles: number, threads: number}>}
 */
export async function selectOutliersStore(store, opts) {
	var o = opts || {}, k = o.k === undefined ? 8 : o.k, mult = o.multiplier === undefined ? 2 : o.multiplier;
	if (!(Number.isInteger(k) && k >= 1)) throw bad("k must be a whole number >= 1, not " + JSON.stringify(o.k));
	if (!(typeof mult === "number" && isFinite(mult))) throw bad("multiplier must be a finite number, not " + JSON.stringify(o.multiplier));
	var threads = await common(store, o, "selectOutliersStore");
	var L0 = await layout(store, Object.assign({}, o, { tile: 1e9 }), 1, 0);   // the spacing, for the overlap
	var M = o.overlap !== undefined ? o.overlap : Math.max(0.5, 30 * (L0.spacing > 0 ? L0.spacing : 0.05));
	var L = await layout(store, o, threads, M);
	if (!L.n) return { selection: selectionOf(store, L, []), count: 0, mean: NaN, sd: NaN, threshold: NaN, tiles: 0, threads: 1 };
	var means = perNode(L, Float32Array, NaN), n = 0, M1 = 0, M2 = 0;
	var ran = await runAll(store, L, o, threads, "outlierRegion", function (t) {
		return { which: t.which, axes: L.axes, box: t.box, core: t.core, origin: L.origin, k: k };
	}, function (r) {
		for (var q = 0; q < r.node.length; q++) means[r.node[q]][r.index[q]] = r.value[q];
		if (!r.n) return;
		// Chan's combination of two runs' mean and squared deviations
		var nn = n + r.n, d = r.M1 - M1;
		M1 += d * r.n / nn; M2 += r.M2 + d * d * n * r.n / nn; n = nn;
	});
	var sd = n > 1 ? Math.sqrt(M2 / (n - 1)) : NaN, threshold = M1 + mult * sd, lists = means.map(function () { return []; });
	means.forEach(function (a, i) { for (var j = 0; j < a.length; j++) if (a[j] > threshold) lists[i].push(j); });
	var sel = selectionOf(store, L, lists);
	return { selection: sel, count: sel.count, mean: M1, sd: sd, threshold: threshold, tiles: L.tiles.length, threads: ran };
}

/**
 * selectSparse over a whole tile store.
 * @param {object} store - an open TileStore.
 * @param {{radius: number, minNeighbours?: number, xy?: boolean, threads?: number, tile?: number, tilePoints?: number,
 *   onProgress?: function(number, number), signal?: AbortSignal}} opts - as selectSparse.
 * @returns {Promise<{selection: object, count: number, tiles: number, threads: number}>}
 */
export async function selectSparseStore(store, opts) {
	var o = opts || {};
	if (!(typeof o.radius === "number" && o.radius > 0 && isFinite(o.radius))) throw bad("radius must be a distance > 0, not " + JSON.stringify(o.radius));
	var threads = await common(store, o, "selectSparseStore");
	var L = await layout(store, o, threads, o.radius * 1.01);
	var lists = L.n ? L.nodes.keys.map(function () { return []; }) : [];
	var ran = L.n ? await runAll(store, L, o, threads, "sparseRegion", function (t) {
		return { which: t.which, axes: L.axes, box: t.box, core: t.core, origin: L.origin, sparse: { radius: o.radius, minNeighbours: o.minNeighbours, xy: o.xy } };
	}, function (r) { for (var q = 0; q < r.node.length; q++) lists[r.node[q]].push(r.index[q]); }) : 1;
	var sel = selectionOf(store, L, lists);
	return { selection: sel, count: sel.count, tiles: L.n ? L.tiles.length : 0, threads: ran };
}

/**
 * Roughness over a whole tile store: each point's RMS distance from the plane of its neighbours (pointNormals'
 * residual; NaN where they do not span a plane).
 * @param {object} store - an open TileStore.
 * @param {{k?: number, maxDistance: number, column?: string, threads?: number, tile?: number, tilePoints?: number,
 *   onProgress?: function(number, number), signal?: AbortSignal}} opts - k 16; column: write it to the store as an
 *   added f32 column (where its edits run: a Worker for OPFS).
 * @returns {Promise<{byTile: object, tiles: number, threads: number}>} byTile { key: Float32Array }, the node's point order
 */
export async function roughnessStore(store, opts) {
	var o = opts || {};
	if (!(typeof o.maxDistance === "number" && o.maxDistance > 0 && isFinite(o.maxDistance))) throw bad("maxDistance must be a distance > 0, not " + JSON.stringify(o.maxDistance));
	var threads = await common(store, o, "roughnessStore");
	var L = await layout(store, o, threads, o.maxDistance * 1.01);
	if (!L.n) return { byTile: {}, tiles: 0, threads: 1 };
	var rough = perNode(L, Float32Array, NaN);
	var ran = await runAll(store, L, o, threads, "roughRegion", function (t) {
		return { which: t.which, axes: L.axes, box: t.box, core: t.core, origin: L.origin, normals: { k: o.k, maxDistance: o.maxDistance } };
	}, function (r) { for (var q = 0; q < r.node.length; q++) rough[r.node[q]][r.index[q]] = r.value[q]; });
	var byTile = {};
	L.nodes.keys.forEach(function (key, i) { byTile[key] = rough[i]; });
	if (o.column) {
		var has = store.manifest.columns.filter(function (c) { return c.name === o.column; })[0];
		if (has && has.type !== "f32") throw bad("column " + o.column + " is taken by an added " + has.type + " column; give another name");
		if (!has) await store.addColumn(o.column, "f32", 0);
		var sel = { deletes: store.manifest.deletes, count: 0, tiles: {} };
		Object.keys(byTile).forEach(function (key) { var idx = new Uint32Array(byTile[key].length); for (var j = 0; j < idx.length; j++) idx[j] = j; sel.tiles[key] = idx; sel.count += idx.length; });
		await store.setColumn(sel, o.column, byTile);
	}
	return { byTile: byTile, tiles: L.tiles.length, threads: ran };
}

// the chunks' points grouped by node, ascending by index: one { index, x, y, z, dz, dom } per node number (null when empty)
function groupByNode(L, chunks) {
	var counts = new Uint32Array(L.nodes.keys.length), out = [];
	chunks.forEach(function (c) { for (var q = 0; q < c.node.length; q++) counts[c.node[q]]++; });
	counts.forEach(function (m) {
		out.push(m ? { index: new Uint32Array(m), x: new Float32Array(m), y: new Float32Array(m), z: new Float32Array(m), dz: new Float32Array(m), dom: new Float32Array(m) } : null);
	});
	var at = new Uint32Array(counts.length);
	chunks.forEach(function (c) {
		for (var q = 0; q < c.node.length; q++) {
			var g = out[c.node[q]], w = at[c.node[q]]++;
			g.index[w] = c.index[q]; g.x[w] = c.x[q]; g.y[w] = c.y[q]; g.z[w] = c.z[q]; g.dz[w] = c.dz[q]; g.dom[w] = c.dom[q];
		}
	});
	return out.map(function (g) {
		if (!g) return g;
		var m = g.index.length, perm = new Uint32Array(m), s = {};
		for (var i = 0; i < m; i++) perm[i] = i;
		perm.sort(function (a, b) { return g.index[a] - g.index[b]; });
		Object.keys(g).forEach(function (k) { var src = g[k], dst = new src.constructor(m); for (var j = 0; j < m; j++) dst[j] = src[perm[j]]; s[k] = dst; });
		return s;
	});
}

var MIN_KEYS = ["minX", "minY", "minZ"], MAX_KEYS = ["maxX", "maxY", "maxZ"];

// the work tiles whose core meets the limit box
function tilesMeeting(L, limit) {
	return L.tiles.filter(function (t) { return [0, 1].every(function (q) { var lo = limit[MIN_KEYS[L.axes[q]]], hi = limit[MAX_KEYS[L.axes[q]]]; return !(t.core[2 * q + 1] < lo || t.core[2 * q] > hi); }); });
}

// a limit box { minX, maxX, ... } (world coordinates, any side may be left out) checked, with the missing sides open
function limitBox(b) {
	if (b === undefined || b === null) return null;
	if (typeof b !== "object") throw bad("box must be { minX, maxX, minY, maxY, minZ, maxZ } (any may be left out)");
	var out = {};
	MIN_KEYS.concat(MAX_KEYS).forEach(function (k) {
		var v = b[k];
		if (v === undefined) { out[k] = k[1] === "i" ? -Infinity : Infinity; return; }
		if (typeof v !== "number" || Number.isNaN(v)) throw bad("box." + k + " must be a number, not " + JSON.stringify(v));
		out[k] = v;
	});
	if (out.minX > out.maxX || out.minY > out.maxY || out.minZ > out.maxZ) throw bad("box has a minimum above its maximum");
	return out;
}

/**
 * selectDoubleLayer over a whole tile store, or over the part of it inside opts.box. Cells sit on one grid anchored at the store's corner, and each tile reads an
 * overlap of (smooth + 2 + the bridge in cells) cells, so the cells give the answer a single run over the whole cloud gives (minArea judges
 * a patch inside one work tile: keep it well under a tile's area, a few hundred square metres at most). The points that
 * would move are kept here (about 24 bytes a ghost point, and as many more for partner), for snapToLayerStore.
 * @param {object} store - an open TileStore.
 * @param {{cell: number, minGap: number, maxGap?: number, keep?: string, minPoints?: number, smooth?: number, partner?: boolean,
 *   minArea?: number, coherence?: number, bridge?: number, box?: {minX?, maxX?, minY?, maxY?, minZ?, maxZ?},
 *   threads?: number, tile?: number, tilePoints?: number, onProgress?: function(number, number), signal?: AbortSignal}} opts -
 *   selectDoubleLayer's options; box: only points inside it (world coordinates, any side open) are found, and only the
 *   tiles it meets are read; partner: also keep the kept-layer points beside a ghost, which the "average" mode moves.
 * @returns {Promise<{selection: object, count: number, stats: object, ghost: Array, partner: Array|null, keys: string[], origin: object, tiles: number, threads: number}>}
 *   selection: the store's own ({ deletes, count, tiles }); stats: selected, kept (with partner), min, p05, median, p95, max of dz.
 */
export async function selectDoubleLayerStore(store, opts) {
	var o = opts || {}, smooth = o.smooth === undefined ? 1 : o.smooth;
	if (!(typeof o.cell === "number" && o.cell > 0 && isFinite(o.cell))) throw bad("cell must be a distance > 0, not " + JSON.stringify(o.cell));
	if (!(typeof o.minGap === "number" && o.minGap > 0 && isFinite(o.minGap))) throw bad("minGap must be a distance > 0, not " + JSON.stringify(o.minGap));
	if (!(Number.isInteger(smooth) && smooth >= 0)) throw bad("smooth must be a whole number >= 0, not " + JSON.stringify(o.smooth));
	var threads = await common(store, o, "selectDoubleLayerStore"), partner = !!o.partner;
	var bridgeCells = o.bridge > 0 ? Math.ceil(o.bridge / o.cell) : 0;
	var L = await layout(store, o, threads, o.cell * (smooth + 2 + bridgeCells));
	if (!L.n) return { selection: { deletes: store.manifest.deletes, count: 0, tiles: {} }, count: 0, ghost: [], partner: null, keys: [], origin: { x: 0, y: 0, z: 0 }, tiles: 0, threads: 1,
		stats: { selected: 0, kept: 0, min: NaN, p05: NaN, median: NaN, p95: NaN, max: NaN } };
	var ax = Infinity, ay = Infinity;
	L.nodes.boxes.forEach(function (b) { ax = Math.min(ax, b.minX); ay = Math.min(ay, b.minY); });
	var dbl = { cell: o.cell, minGap: o.minGap, maxGap: o.maxGap, keep: o.keep, minPoints: o.minPoints, smooth: smooth, minArea: o.minArea, coherence: o.coherence, bridge: o.bridge };
	var limit = limitBox(o.box);
	// only the work tiles whose core meets the box run; the cells stay on the store's grid, so a point inside the box
	// gets the same answer as in a run over the whole store
	if (limit) L.tiles = tilesMeeting(L, limit);
	var ghosts = [], partners = [];
	var ran = await runAll(store, L, o, threads, "doubleRegion", function (t) {
		return { which: t.which, axes: L.axes, box: t.box, core: t.core, origin: L.origin, double: dbl, anchor: { x: ax - L.origin.x, y: ay - L.origin.y }, partner: partner, limit: limit };
	}, function (r) {
		if (!r.node.length) return;
		var q, ng = 0;
		for (q = 0; q < r.kind.length; q++) if (r.kind[q] === 1) ng++;
		if (ng === r.kind.length) { ghosts.push(r); return; }
		var gh = [], pa = [];
		for (q = 0; q < r.kind.length; q++) (r.kind[q] === 1 ? gh : pa).push(q);
		[[gh, ghosts], [pa, partners]].forEach(function (e) {
			if (!e[0].length) return;
			var c = { node: new Uint32Array(e[0].length) }, names = ["index", "x", "y", "z", "dz", "dom"];
			names.forEach(function (n) { c[n] = new r[n].constructor(e[0].length); });
			e[0].forEach(function (src, i) { c.node[i] = r.node[src]; names.forEach(function (n) { c[n][i] = r[n][src]; }); });
			e[1].push(c);
		});
	});
	var g = groupByNode(L, ghosts), p = partner ? groupByNode(L, partners) : null;
	var sel = { deletes: store.manifest.deletes, count: 0, tiles: {} }, all = [], kept = 0;
	g.forEach(function (n, i) { if (!n) return; sel.tiles[L.nodes.keys[i]] = n.index; sel.count += n.index.length; all.push(n.dz); });
	if (p) p.forEach(function (n) { if (n) kept += n.index.length; });
	var dz = new Float32Array(sel.count), at = 0;
	all.forEach(function (a) { dz.set(a, at); at += a.length; });
	dz.sort();
	function pct(f) { return dz.length ? dz[Math.min(dz.length - 1, Math.floor(f * (dz.length - 1) + 0.5))] : NaN; }
	var stats = { selected: sel.count, kept: kept, min: dz.length ? dz[0] : NaN, p05: pct(0.05), median: pct(0.5), p95: pct(0.95), max: dz.length ? dz[dz.length - 1] : NaN };
	return { selection: sel, count: sel.count, stats: stats, ghost: g, partner: p, keys: L.nodes.keys, origin: L.origin, tiles: L.tiles.length, threads: ran };
}

/**
 * snapToLayer over a whole tile store: move the ghost points selectDoubleLayerStore found (setPositions).
 * @param {object} store - the open TileStore the run was on, not edited since.
 * @param {object} found - selectDoubleLayerStore's result.
 * @param {{mode?: string, blend?: number, batchPoints?: number}} [opts] - as snapToLayer; "average" needs the run's partner: true;
 *   batchPoints (10 M): moved points a write.
 * @returns {Promise<{moved: number, batches: number}>}
 */
export async function snapToLayerStore(store, found, opts) {
	var o = opts || {}, mode = o.mode === undefined ? "offset" : o.mode, blend = o.blend === undefined ? 0.5 : o.blend;
	if (mode !== "offset" && mode !== "surface" && mode !== "average") throw bad("mode must be \"offset\", \"surface\" or \"average\", not " + JSON.stringify(o.mode));
	if (!(typeof blend === "number" && blend >= 0 && blend <= 1)) throw bad("blend must be a number from 0 to 1, not " + JSON.stringify(o.blend));
	if (!found || !found.ghost || !found.keys || !found.origin) throw bad("snapToLayerStore needs the result of selectDoubleLayerStore");
	if (mode === "average" && blend > 0 && !found.partner) throw bad("mode \"average\" needs selectDoubleLayerStore to run with partner: true");
	var batch = o.batchPoints || BATCH_POINTS, org = found.origin, move = mode === "average" ? 1 - blend : 1;
	var moved = 0, batches = 0, held = 0, value = {};
	async function flush() {
		if (!held) return;
		var v = value; value = {}; held = 0; batches++;
		await store.setPositions(v);
	}
	for (var i = 0; i < found.keys.length; i++) {
		var g = found.ghost[i], p = mode === "average" && blend > 0 && found.partner ? found.partner[i] : null;
		if (!g && !p) continue;
		var m = (g ? g.index.length : 0) + (p ? p.index.length : 0), entries = [], a;
		if (g) for (a = 0; a < g.index.length; a++) entries.push([g.index[a], g.x[a], g.y[a], mode === "surface" ? g.dom[a] : g.z[a] + g.dz[a] * move]);
		if (p) for (a = 0; a < p.index.length; a++) entries.push([p.index[a], p.x[a], p.y[a], p.z[a] - p.dz[a] * blend]);
		entries.sort(function (u, w) { return u[0] - w[0]; });
		var v = { index: new Uint32Array(m), x: new Float64Array(m), y: new Float64Array(m), z: new Float64Array(m) };
		entries.forEach(function (e, q) { v.index[q] = e[0]; v.x[q] = e[1] + org.x; v.y[q] = e[2] + org.y; v.z[q] = e[3] + org.z; });
		value[found.keys[i]] = v; held += m; moved += m;
		if (held >= batch) await flush();
	}
	await flush();
	return { moved: moved, batches: batches };
}

var SAMPLE_TILES = 8;

/**
 * The selectDoubleLayerStore options for a store, or for the part of it inside opts.box, worked out from its points (suggestDoubleLayer).
 * Without a box, a sample of work tiles spread over the store is measured.
 * @param {object} store - an open TileStore.
 * @param {{box?: object, strength?: string, threads?: number, tile?: number, tilePoints?: number, onProgress?: function(number, number),
 *   signal?: AbortSignal}} [opts] - box and strength as selectDoubleLayerStore and suggestDoubleLayer.
 * @returns {Promise<object>} suggestDoubleLayer's result, with tiles and threads.
 */
export async function suggestDoubleLayerStore(store, opts) {
	var o = opts || {}, threads = await common(store, o, "suggestDoubleLayerStore");
	var L = await layout(store, o, threads, 0), limit = limitBox(o.box);
	if (!L.n) return { ok: false, reason: "the store holds no points", tiles: 0, threads: 1 };
	if (limit) L.tiles = tilesMeeting(L, limit);
	else if (L.tiles.length > SAMPLE_TILES) L.tiles = Array.from({ length: SAMPLE_TILES }, function (_, i) { return L.tiles[Math.floor((i + 0.5) * L.tiles.length / SAMPLE_TILES)]; });
	if (!L.tiles.length) return { ok: false, reason: "the box holds no points", tiles: 0, threads: 1 };
	var parts = [];
	var ran = await runAll(store, L, o, threads, "doubleStatsRegion", function (t) {
		return { which: t.which, axes: L.axes, box: t.box, core: t.core, origin: L.origin, limit: limit };
	}, function (r) { parts.push(r.stats); });
	var stats = addDoubleLayerStats(parts);
	if (!stats.points) return { ok: false, reason: "the box holds no points", tiles: L.tiles.length, threads: ran };   // an edge tile's core reaches past the store
	return Object.assign(suggestDoubleLayer(stats, { strength: o.strength }), { tiles: L.tiles.length, threads: ran });
}

/**
 * Find the ghost in a store (or inside opts.box) with settings worked out from its points, and move it onto the layer
 * with most points; again until nothing is left (the first pass joins a sparse sheet's pieces, so a second pass usually
 * finds nothing). One edit per pass. Loose single cells that do not join into a patch are left, as selectDoubleLayer leaves them.
 * @param {object} store - an open TileStore.
 * @param {{box?: object, strength?: string, mode?: string, keep?: string, maxPasses?: number, settings?: object, dryRun?: boolean,
 *   threads?: number, tile?: number, tilePoints?: number, onProgress?: function(number, number), onPass?: function(object),
 *   signal?: AbortSignal}} [opts] - strength: as suggestDoubleLayer; mode: snapToLayer's (default "offset"); keep: default
 *   "auto"; maxPasses (default 4); settings: selectDoubleLayer options laid over the suggested ones; dryRun: find, move nothing
 *   (one pass); onPass: called with each pass's { pass, found, moved }.
 * @returns {Promise<{ok: boolean, reason?: string, settings?: object, passes: object[], found: number, moved: number}>} found: the
 *   ghost points of the first pass (what a dry run reports); moved: the points moved over all passes.
 */
export async function fixDoubleLayerStore(store, opts) {
	var o = opts || {}, maxPasses = o.maxPasses === undefined ? 4 : o.maxPasses;
	if (!(Number.isInteger(maxPasses) && maxPasses >= 1)) throw bad("maxPasses must be a whole number >= 1, not " + JSON.stringify(o.maxPasses));
	var s = await suggestDoubleLayerStore(store, o);
	if (!s.ok) return { ok: false, reason: s.reason, passes: [], found: 0, moved: 0 };
	var settings = Object.assign({ cell: s.cell, minGap: s.minGap, minPoints: s.minPoints, minArea: s.minArea, bridge: s.bridge, maxGap: s.maxGap, keep: o.keep || "auto" }, o.settings || {});
	var run = Object.assign({}, settings, { box: o.box, threads: o.threads, tile: o.tile, tilePoints: o.tilePoints, signal: o.signal, onProgress: o.onProgress });
	var passes = [], moved = 0, found = 0, last = Infinity;
	for (var pass = 1; pass <= maxPasses; pass++) {
		var f = await selectDoubleLayerStore(store, run), p = { pass: pass, found: f.count, moved: 0 };
		if (pass === 1) found = f.count;
		if (!f.count || o.dryRun) { passes.push(p); if (o.onPass) o.onPass(p); break; }
		var r = await snapToLayerStore(store, f, { mode: o.mode });
		p.moved = r.moved; moved += r.moved; passes.push(p);
		if (o.onPass) o.onPass(p);
		if (f.count >= 0.9 * last) break;      // no longer getting smaller: stop
		last = f.count;
	}
	return { ok: true, settings: settings, passes: passes, found: found, moved: moved };
}
