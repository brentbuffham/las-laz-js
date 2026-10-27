// src/tiles/storeOps.js
//==========================================================
// Whole-cloud edits on a tile store, on the parallel runs' work tiles
// (parallelStore.js: each worker opens the store and reads its tile and
// an overlap; this thread gathers the result and makes one edit, so the
// store has one writer and is never read whole):
// - dedupeStore: dedupe's rule (first point wins, within tolerance, XY
//   or 3D) over the whole store; the tiles agree on the winner because
//   every region lists its points in the store's own order.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { layout, runAll, common } from "./parallelStore.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

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
