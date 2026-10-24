// src/tiles/select.js
//==========================================================
// selectTiles: the nodes a camera needs, within a point budget.
// Pure and synchronous on the manifest, so it runs every frame on the
// main thread while tiles load in a Worker.
//  - a node's box (its tight box, or its cube cell when it has no
//    points) is moved by the store transform, then minus localOrigin
//  - culled when wholly outside one of the six clip planes
//    (Gribb-Hartmann, from the matrix; OpenGL clip z in [-w, w], as
//    Three.js)
//  - its size on screen: the diagonal of its eight projected corners'
//    extent in pixels; a corner at or behind the eye (w <= 0) makes it
//    Infinity. Never from distance, so orthographic cameras work.
//  - from the root (always taken), the largest on screen first (ties
//    by key): taken when it fits the budget; its children become
//    candidates once it covers minPixels
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { nodeBox } from "./octree.js";
import { transformBounds } from "../ops/transform.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

function positive(v, name, dflt, allowZero) {
	if (v === undefined) return dflt;
	if (typeof v !== "number" || !isFinite(v) || v < 0 || (!allowZero && v === 0)) throw bad("view." + name + " must be a " + (allowZero ? "non-negative" : "positive") + " number");
	return v;
}

function checkView(view) {
	if (!view || typeof view !== "object") throw bad("selectTiles needs a view { viewProjection, width, height }");
	var m = view.viewProjection;
	if (!m || m.length !== 16 || !Array.prototype.every.call(m, function (x) { return typeof x === "number" && isFinite(x); })) throw bad("view.viewProjection must be 16 finite numbers (column-major, as Three.js)");
	var o = view.localOrigin, origin = [0, 0, 0];
	if (o !== undefined && o !== null) {
		["x", "y", "z"].forEach(function (k, i) {
			if (o[k] === undefined) return;
			if (typeof o[k] !== "number" || !isFinite(o[k])) throw bad("view.localOrigin." + k + " must be a finite number");
			origin[i] = o[k];
		});
	}
	return {
		m: m, origin: origin,
		width: positive(view.width, "width"), height: positive(view.height, "height"),
		budget: positive(view.pointBudget, "pointBudget", 10e6, true), minPixels: positive(view.minPixels, "minPixels", 100, true)
	};
}

// The six clip planes [a, b, c, d] from a column-major matrix: row 3 ± rows 0, 1, 2
function planesOf(m) {
	var r = [0, 1, 2, 3].map(function (i) { return [m[i], m[4 + i], m[8 + i], m[12 + i]]; }), out = [];
	for (var i = 0; i < 3; i++) {
		out.push([r[3][0] + r[i][0], r[3][1] + r[i][1], r[3][2] + r[i][2], r[3][3] + r[i][3]]);
		out.push([r[3][0] - r[i][0], r[3][1] - r[i][1], r[3][2] - r[i][2], r[3][3] - r[i][3]]);
	}
	return out;
}

/**
 * A node's box in world coordinates, moved by the store transform: its tight box, or its
 * cube cell when it holds no points.
 * @param {object} man - the manifest
 * @param {string} key
 * @returns {{minX, minY, minZ, maxX, maxY, maxZ}}
 */
export function nodeWorldBox(man, key) {
	var b = man.nodes[key].box, s = man.scale, off = man.offset, box;
	if (b) box = { minX: b[0], minY: b[1], minZ: b[2], maxX: b[3], maxY: b[4], maxZ: b[5] };
	else {
		var c = nodeBox(man.cube, key);
		box = { minX: c.min[0] * s.x + off.x, minY: c.min[1] * s.y + off.y, minZ: c.min[2] * s.z + off.z, maxX: c.max[0] * s.x + off.x, maxY: c.max[1] * s.y + off.y, maxZ: c.max[2] * s.z + off.z };
	}
	return man.transform ? transformBounds(man.transform, box) : box;
}

// What selectTiles needs from a manifest, made once per manifest object (an edit posts a new
// one): the nodes in key order (their index is the tie order), counts, moved world boxes and
// each node's children by index
var prepared = new WeakMap();
function prepare(man) {
	var p = prepared.get(man);
	if (p) return p;
	var keys = Object.keys(man.nodes).map(function (k) { return { key: k, k: k.split("-").map(Number) }; });
	keys.sort(function (a, b) { for (var i = 0; i < 4; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i]; return 0; });
	var n = keys.length, at = new Map(), count = new Float64Array(n), box = new Float64Array(6 * n), kids = new Int32Array(8 * n).fill(-1);
	keys.forEach(function (e, i) { at.set(e.key, i); });
	keys.forEach(function (e, i) {
		count[i] = man.nodes[e.key].count;
		var b = nodeWorldBox(man, e.key);
		box[6 * i] = b.minX; box[6 * i + 1] = b.minY; box[6 * i + 2] = b.minZ; box[6 * i + 3] = b.maxX; box[6 * i + 4] = b.maxY; box[6 * i + 5] = b.maxZ;
		if (e.k[0] > 0) {
			var parent = at.get((e.k[0] - 1) + "-" + Math.floor(e.k[1] / 2) + "-" + Math.floor(e.k[2] / 2) + "-" + Math.floor(e.k[3] / 2));
			if (parent !== undefined) kids[8 * parent + (e.k[1] % 2) + 2 * (e.k[2] % 2) + 4 * (e.k[3] % 2)] = i;
		}
	});
	p = { keys: keys, count: count, box: box, kids: kids, root: at.get("0-0-0-0") };
	prepared.set(man, p);
	return p;
}

/**
 * The nodes to draw for a camera.
 * @param {object} storeOrManifest - a TileStore, or its manifest (e.g. posted from a Worker)
 * @param {{viewProjection: number[], width: number, height: number, pointBudget?: number,
 *   minPixels?: number, localOrigin?: {x, y, z}}} view - viewProjection: 16 numbers,
 *   column-major (Three.js camera.projectionMatrix × camera.matrixWorldInverse), in world
 *   coordinates minus localOrigin; pointBudget 10,000,000; minPixels 100
 * @returns {Array<{key: string, depth: number, count: number, box: {minX, minY, minZ, maxX, maxY, maxZ}}>}
 *   most important first, a node's parent always before it; boxes in the view's coordinates
 * @throws {LasError} INVALID_ARGUMENT naming the bad view field
 */
export function selectTiles(storeOrManifest, view) {
	var man = storeOrManifest && storeOrManifest.manifest ? storeOrManifest.manifest : storeOrManifest;
	var v = checkView(view), m = v.m, pl = [].concat.apply([], planesOf(m)), P = prepare(man);
	var o = v.origin, B = P.box, W = v.width / 2, H = v.height / 2;
	var cx = new Float64Array(8), cy = new Float64Array(8), cz = new Float64Array(8);
	// -1 when culled, else the size on screen in pixels (Infinity when a corner is at or behind the eye)
	function measure(i) {
		var x0 = B[6 * i] - o[0], y0 = B[6 * i + 1] - o[1], z0 = B[6 * i + 2] - o[2], x1 = B[6 * i + 3] - o[0], y1 = B[6 * i + 4] - o[1], z1 = B[6 * i + 5] - o[2];
		for (var q = 0; q < 8; q++) { cx[q] = q % 2 ? x1 : x0; cy[q] = q % 4 >= 2 ? y1 : y0; cz[q] = q >= 4 ? z1 : z0; }
		for (var p = 0; p < 24; p += 4) {
			var any = false;
			for (var c = 0; c < 8; c++) if (pl[p] * cx[c] + pl[p + 1] * cy[c] + pl[p + 2] * cz[c] + pl[p + 3] >= 0) { any = true; break; }
			if (!any) return -1;
		}
		var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (var k = 0; k < 8; k++) {
			var x = cx[k], y = cy[k], z = cz[k], w = m[3] * x + m[7] * y + m[11] * z + m[15];
			if (w <= 0) return Infinity;
			var sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w * W, sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * H;
			if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
			if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
		}
		var dx = maxX - minX, dy = maxY - minY;
		return Math.sqrt(dx * dx + dy * dy);
	}
	// a max-heap of node indices on size, ties to the lower index (key order)
	var heap = new Int32Array(P.keys.length), hn = 0, size = new Float64Array(P.keys.length);
	function above(a, b) { return size[a] > size[b] || (size[a] === size[b] && a < b); }
	function push(i) {
		var j = hn++;
		heap[j] = i;
		while (j > 0) {
			var up = (j - 1 - (j - 1) % 2) / 2;
			if (!above(heap[j], heap[up])) break;
			var t = heap[j]; heap[j] = heap[up]; heap[up] = t; j = up;
		}
	}
	function pop() {
		var top = heap[0];
		heap[0] = heap[--hn];
		var j = 0;
		for (;;) {
			var l = 2 * j + 1, r = l + 1, best = j;
			if (l < hn && above(heap[l], heap[best])) best = l;
			if (r < hn && above(heap[r], heap[best])) best = r;
			if (best === j) break;
			var t = heap[j]; heap[j] = heap[best]; heap[best] = t; j = best;
		}
		return top;
	}
	var out = [], used = 0;
	function take(i) {
		var e = P.keys[i];
		out.push({ key: e.key, depth: e.k[0], count: P.count[i], box: { minX: B[6 * i] - o[0], minY: B[6 * i + 1] - o[1], minZ: B[6 * i + 2] - o[2], maxX: B[6 * i + 3] - o[0], maxY: B[6 * i + 4] - o[1], maxZ: B[6 * i + 5] - o[2] } });
		used += P.count[i];
		if (!(size[i] >= v.minPixels)) return;
		for (var c = 0; c < 8; c++) {
			var ch = P.kids[8 * i + c];
			if (ch < 0) continue;
			var s = measure(ch);
			if (s >= 0) { size[ch] = s; push(ch); }
		}
	}
	size[P.root] = measure(P.root);
	take(P.root);
	while (hn) {
		var next = pop();
		if (used + P.count[next] <= v.budget) take(next);
	}
	return out;
}
