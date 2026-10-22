// src/ops/polygon.js
//==========================================================
// The point-in-polygon test behind selectPolygon and the reader's
// polygon crop (filters.js). Internal: not exported from index.js.
// The boundary decision comes first (a point within tolerance of an
// edge or vertex, measured in Float64), so an edge point never
// depends on crossing-test rounding; only a point clear of every
// edge goes to the even-odd crossing test (W. Randolph Franklin's
// PNPOLY).
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

// Validate a flat polygon [x0, y0, x1, y1, ...] and copy it to a Float64Array
function checkPolygon(polygon) {
	if (!Array.isArray(polygon) && !(ArrayBuffer.isView(polygon) && !(polygon instanceof DataView))) throw bad("polygon must be an Array or typed array [x0, y0, x1, y1, ...]");
	var n = polygon.length;
	if (n % 2 !== 0) throw bad("polygon has an odd length " + n + ": it holds x, y pairs");
	if (n < 6) throw bad("polygon needs at least 3 vertices (6 values), got " + n);
	var p = new Float64Array(n);
	for (var i = 0; i < n; i++) {
		var v = polygon[i];
		if (typeof v !== "number" || !Number.isFinite(v)) throw bad("polygon[" + i + "] = " + String(v) + " is not a finite number");
		p[i] = v;
	}
	return p;
}

/**
 * Build a point-in-polygon test.
 * @param {number[]|TypedArray} polygon - [x0, y0, x1, y1, ...], at least 3 vertices, implicitly closed.
 * @param {{boundary?: string, tolerance?: number}} [opts] - boundary "touching" (default: points on the
 *   boundary are in) or "inside" (they are out); tolerance (default 0): within this distance of an edge
 *   or vertex is on the boundary.
 * @returns {{test: function(number, number): boolean, minX: number, maxX: number, minY: number, maxY: number}}
 *   test(x, y) decides a point (false outside the box at once); the box is the polygon's grown by tolerance.
 */
export function makePolygonTest(polygon, opts) {
	if (opts === undefined || opts === null) opts = {};
	if (typeof opts !== "object") throw bad("options must be an object { boundary, tolerance }");
	var p = checkPolygon(polygon);
	var boundary = opts.boundary === undefined ? "touching" : opts.boundary;
	if (boundary !== "touching" && boundary !== "inside") throw bad("boundary must be \"touching\" or \"inside\", got " + String(boundary));
	var tol = opts.tolerance === undefined ? 0 : opts.tolerance;
	if (typeof tol !== "number" || !Number.isFinite(tol) || tol < 0) throw bad("tolerance must be a finite number ≥ 0, got " + String(tol));
	var touching = boundary === "touching", tol2 = tol * tol;
	var n = p.length / 2;
	var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (var k = 0; k < n; k++) {
		if (p[2 * k] < minX) minX = p[2 * k];
		if (p[2 * k] > maxX) maxX = p[2 * k];
		if (p[2 * k + 1] < minY) minY = p[2 * k + 1];
		if (p[2 * k + 1] > maxY) maxY = p[2 * k + 1];
	}
	minX -= tol; maxX += tol; minY -= tol; maxY += tol;

	// Squared distance from (px, py) to the segment (ax, ay)-(bx, by); 0 when the point is exactly on it
	function dist2(px, py, ax, ay, bx, by) {
		var ex = bx - ax, ey = by - ay;
		var wx = px - ax, wy = py - ay;
		var len2 = ex * ex + ey * ey;
		if (len2 === 0) return wx * wx + wy * wy;
		if (ex * wy - ey * wx === 0 && px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by)) return 0;
		var t = (wx * ex + wy * ey) / len2;
		if (t < 0) t = 0; else if (t > 1) t = 1;
		var dx = px - (ax + t * ex), dy = py - (ay + t * ey);
		return dx * dx + dy * dy;
	}

	function test(px, py) {
		if (!(px >= minX && px <= maxX && py >= minY && py <= maxY)) return false;
		var inside = false;
		for (var i = 0, j = n - 1; i < n; j = i++) {
			var ax = p[2 * j], ay = p[2 * j + 1], bx = p[2 * i], by = p[2 * i + 1];
			if (dist2(px, py, ax, ay, bx, by) <= tol2) return touching;
			if ((by > py) !== (ay > py) && px < (ax - bx) * (py - by) / (ay - by) + bx) inside = !inside;
		}
		return inside;
	}
	return { test: test, minX: minX, maxX: maxX, minY: minY, maxY: maxY };
}
