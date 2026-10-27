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
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { layout, runAll, common } from "./parallelStore.js";
import { estimateNoise } from "../ops/normals.js";
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
	var iterations = o.iterations === undefined ? 1 : o.iterations, k = o.k === undefined ? 16 : o.k, batch = o.batchPoints || BATCH_POINTS;
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
