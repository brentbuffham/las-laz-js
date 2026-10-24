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
import { parseKey, childKey, nodeBox } from "./octree.js";
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

function keyLess(a, b) {
	var p = parseKey(a), q = parseKey(b);
	for (var i = 0; i < 4; i++) if (p[i] !== q[i]) return p[i] < q[i];
	return false;
}

// a max-heap on { size, key }
function Heap() { this.a = []; }
Heap.prototype.above = function (x, y) { return x.size > y.size || (x.size === y.size && keyLess(x.key, y.key)); };
Heap.prototype.push = function (x) {
	var a = this.a, i = a.length;
	a.push(x);
	while (i > 0) {
		var p = Math.floor((i - 1) / 2);
		if (!this.above(a[i], a[p])) break;
		var t = a[i]; a[i] = a[p]; a[p] = t; i = p;
	}
};
Heap.prototype.pop = function () {
	var a = this.a, top = a[0], last = a.pop();
	if (a.length) {
		a[0] = last;
		var i = 0;
		for (;;) {
			var l = 2 * i + 1, r = l + 1, m = i;
			if (l < a.length && this.above(a[l], a[m])) m = l;
			if (r < a.length && this.above(a[r], a[m])) m = r;
			if (m === i) break;
			var t = a[i]; a[i] = a[m]; a[m] = t; i = m;
		}
	}
	return top;
};

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
	var v = checkView(view), m = v.m, planes = planesOf(m), nodes = man.nodes, T = man.transform;
	var s = man.scale, off = man.offset, o = v.origin;
	function boxOf(key) {
		var b = nodes[key].box, box;
		if (b) box = { minX: b[0], minY: b[1], minZ: b[2], maxX: b[3], maxY: b[4], maxZ: b[5] };
		else {
			var c = nodeBox(man.cube, key);
			box = { minX: c.min[0] * s.x + off.x, minY: c.min[1] * s.y + off.y, minZ: c.min[2] * s.z + off.z, maxX: c.max[0] * s.x + off.x, maxY: c.max[1] * s.y + off.y, maxZ: c.max[2] * s.z + off.z };
		}
		if (T) box = transformBounds(T, box);
		return { minX: box.minX - o[0], minY: box.minY - o[1], minZ: box.minZ - o[2], maxX: box.maxX - o[0], maxY: box.maxY - o[1], maxZ: box.maxZ - o[2] };
	}
	function measure(box) {
		var visible = true, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, behind = false;
		var corners = [];
		for (var i = 0; i < 8; i++) corners.push([i % 2 ? box.maxX : box.minX, Math.floor(i / 2) % 2 ? box.maxY : box.minY, Math.floor(i / 4) ? box.maxZ : box.minZ]);
		for (var p = 0; p < 6 && visible; p++) {
			var pl = planes[p], any = false;
			for (var c = 0; c < 8 && !any; c++) if (pl[0] * corners[c][0] + pl[1] * corners[c][1] + pl[2] * corners[c][2] + pl[3] >= 0) any = true;
			if (!any) visible = false;
		}
		for (var k = 0; k < 8; k++) {
			var x = corners[k][0], y = corners[k][1], z = corners[k][2];
			var w = m[3] * x + m[7] * y + m[11] * z + m[15];
			if (w <= 0) { behind = true; continue; }
			var sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2 * v.width;
			var sy = ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w + 1) / 2 * v.height;
			if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
			if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
		}
		return { visible: visible, size: behind ? Infinity : Math.hypot(maxX - minX, maxY - minY) };
	}
	var out = [], used = 0, heap = new Heap();
	function take(key, box, size) {
		out.push({ key: key, depth: parseKey(key)[0], count: nodes[key].count, box: box });
		used += nodes[key].count;
		if (!(size >= v.minPixels)) return;
		for (var c = 0; c < 8; c++) {
			var ck = childKey(key, c);
			if (!nodes[ck]) continue;
			var cb = boxOf(ck), me = measure(cb);
			if (me.visible) heap.push({ key: ck, size: me.size, box: cb });
		}
	}
	var root = "0-0-0-0", rb = boxOf(root);
	take(root, rb, measure(rb).size);
	while (heap.a.length) {
		var next = heap.pop();
		if (used + nodes[next.key].count <= v.budget) take(next.key, next.box, next.size);
	}
	return out;
}
