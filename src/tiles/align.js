// src/tiles/align.js
//==========================================================
// Align a stored cloud: alignCloud on thinned copies of tile stores.
// An additive octree's top levels are an even thinning of the whole
// cloud, so storeSample reads whole levels from the root down while
// they fit maxPoints (at least the root). ICP samples the moving cloud
// anyway and fits planes on the fixed one, so a few million fixed
// points keep its accuracy. The copies are local to their store box's
// centre (no Float32 loss at UTM scale); the transform is world to
// world, and apply composes it onto the moving store in one edit
// (where the store's edits run: a Worker for OPFS).
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { alignCloud } from "../register/align.js";
import { storeNodes } from "./region.js";

var MOVING_POINTS = 1000000, FIXED_POINTS = 4000000;
var MIN = ["minX", "minY", "minZ"], MAX = ["maxX", "maxY", "maxZ"];

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function isStore(x) { return !!x && typeof x === "object" && !!x.manifest && typeof x.readTile === "function"; }

/**
 * An even thinning of a tile store: whole octree levels from the root down while they fit maxPoints.
 * @param {object} store - an open TileStore.
 * @param {number} maxPoints
 * @param {{x: number, y: number, z: number}} [origin] - default the store box's centre.
 * @returns {Promise<{count: number, x: Float32Array, y: Float32Array, z: Float32Array, origin: {x, y, z}, levels: number, of: number}>}
 *   of: the store's points
 */
export async function storeSample(store, maxPoints, origin) {
	if (!(maxPoints >= 1)) throw bad("maxPoints must be 1 or more, not " + JSON.stringify(maxPoints));
	var nodes = storeNodes(store.manifest), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], of = 0, byDepth = [];
	nodes.keys.forEach(function (k, i) {
		var d = parseInt(k, 10), b = nodes.boxes[i];
		(byDepth[d] = byDepth[d] || []).push(i);
		of += nodes.counts[i];
		for (var a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b[MIN[a]]); hi[a] = Math.max(hi[a], b[MAX[a]]); }
	});
	var o = origin || { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 }, take = [], total = 0, levels = 0;
	for (var d = 0; d < byDepth.length; d++) {
		var lv = byDepth[d] || [], n = 0;
		lv.forEach(function (i) { n += nodes.counts[i]; });
		if (levels && total + n > maxPoints) break;
		take = take.concat(lv); total += n; levels++;
	}
	var x = new Float32Array(total), y = new Float32Array(total), z = new Float32Array(total), q = 0;
	for (var t = 0; t < take.length; t++) {
		var p = await store.readTile(nodes.keys[take[t]], { fields: ["x", "y", "z"], localOrigin: o, float32: true });
		x.set(p.x, q); y.set(p.y, q); z.set(p.z, q); q += p.count;
	}
	return { count: q, x: x, y: y, z: z, origin: o, levels: levels, of: of };
}

/**
 * alignCloud with either side a tile store (read as storeSample) or point columns.
 * @param {object} moving - an open TileStore, or { cols, origin: [x, y, z] }.
 * @param {object} fixed - the same.
 * @param {object} opts - alignCloud's options (pairs, model, icp, onProgress) and: movingPoints (default 1 M),
 *   fixedPoints (4 M), apply (true: the transform is composed onto the moving store).
 * @returns {Promise<object>} alignCloud's result, plus moving / fixed { count, of, levels } (the samples).
 */
export async function alignStores(moving, fixed, opts) {
	if (!opts || typeof opts !== "object") throw bad("alignStores needs options: { pairs, icp?, … }");
	if (opts.apply && !isStore(moving)) throw bad("apply needs the moving cloud to be a tile store");
	async function side(s, n, what) {
		if (isStore(s)) { var sm = await storeSample(s, n); return { cols: sm, origin: [sm.origin.x, sm.origin.y, sm.origin.z], info: { count: sm.count, of: sm.of, levels: sm.levels } }; }
		if (!s || !s.cols) throw bad(what + " must be a tile store or { cols, origin }");
		return { cols: s.cols, origin: s.origin || [0, 0, 0], info: { count: s.cols.count, of: s.cols.count, levels: null } };
	}
	var m = await side(moving, opts.movingPoints || MOVING_POINTS, "moving"), f = await side(fixed, opts.fixedPoints || FIXED_POINTS, "fixed");
	var o = {};
	Object.keys(opts).forEach(function (k) { if (["apply", "movingPoints", "fixedPoints"].indexOf(k) < 0) o[k] = opts[k]; });
	o.movingOrigin = m.origin; o.fixedOrigin = f.origin;
	var res = alignCloud(m.cols, f.cols, o);
	if (opts.apply) await moving.transform(res.transform);
	return Object.assign(res, { moving: m.info, fixed: f.info });
}
