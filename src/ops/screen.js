// src/ops/screen.js
//==========================================================
// A camera's screen, for shapes drawn on it (selectScreen): a point
// through the view-projection matrix (column-major, as Three.js, in
// world coordinates minus localOrigin, as selectTiles), in Float64;
// on screen when it is inside the clip volume (OpenGL clip z in
// [-w, w], w > 0: in front of the camera, near to far, inside the
// view); its pixel from the view's top-left, y down, as a mouse
// event's offsetX / offsetY. A box is judged by its eight corners:
// all outside one clip plane, or its corners' pixel rectangle clear
// of the polygon, and none of it is selected; every corner inside
// and the rectangle inside the polygon, and all of it is.
// Internal: not exported from index.js.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { rectAgainstPolygon } from "./polygon.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

var CLIP_SLACK = 1e-9;   // of w: a corner this near a clip plane counts as on neither side

/**
 * A view checked and copied.
 * @param {{viewProjection: number[], width: number, height: number, localOrigin?: {x, y, z}}} view
 * @returns {{m: Float64Array, o: number[], width: number, height: number}}
 */
export function screenOf(view) {
	if (!view || typeof view !== "object") throw bad("selectScreen needs a view { viewProjection, width, height }");
	var m = view.viewProjection;
	if (!m || m.length !== 16 || !Array.prototype.every.call(m, function (x) { return typeof x === "number" && isFinite(x); })) throw bad("view.viewProjection must be 16 finite numbers (column-major, as Three.js)");
	["width", "height"].forEach(function (k) {
		if (typeof view[k] !== "number" || !isFinite(view[k]) || view[k] <= 0) throw bad("view." + k + " must be a positive number (pixels)");
	});
	var o = [0, 0, 0], lo = view.localOrigin;
	if (lo !== undefined && lo !== null) {
		["x", "y", "z"].forEach(function (k, i) {
			if (lo[k] === undefined) return;
			if (typeof lo[k] !== "number" || !isFinite(lo[k])) throw bad("view.localOrigin." + k + " must be a finite number");
			o[i] = lo[k];
		});
	}
	return { m: Float64Array.from(m), o: o, width: view.width, height: view.height };
}

/**
 * A point's pixel, when it is on screen.
 * @param {object} s - from screenOf
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Float64Array} out - [px, py], set when on screen
 * @returns {boolean} on screen
 */
export function toPixel(s, x, y, z, out) {
	var m = s.m;
	x -= s.o[0]; y -= s.o[1]; z -= s.o[2];
	var w = m[3] * x + m[7] * y + m[11] * z + m[15];
	if (!(w > 0)) return false;
	var cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cz = m[2] * x + m[6] * y + m[10] * z + m[14];
	if (cx < -w || cx > w || cy < -w || cy > w || cz < -w || cz > w) return false;
	out[0] = (cx / w + 1) / 2 * s.width;
	out[1] = (1 - cy / w) / 2 * s.height;
	return true;
}

/**
 * An open polyline drawn on the screen, checked and copied (selectScreenLine).
 * @param {number[]|TypedArray} line - pixels [x0, y0, x1, y1, ...], at least 2 vertices
 * @returns {Float64Array}
 */
export function checkLine(line) {
	if (!Array.isArray(line) && !(ArrayBuffer.isView(line) && !(line instanceof DataView))) throw bad("line must be an Array or typed array of pixels [x0, y0, x1, y1, ...]");
	if (line.length % 2 !== 0) throw bad("line has an odd length " + line.length + ": it holds x, y pairs");
	if (line.length < 4) throw bad("line needs at least 2 vertices (4 values), got " + line.length);
	var p = new Float64Array(line.length);
	for (var i = 0; i < line.length; i++) {
		if (typeof line[i] !== "number" || !isFinite(line[i])) throw bad("line[" + i + "] = " + String(line[i]) + " is not a finite number");
		p[i] = line[i];
	}
	return p;
}

/**
 * The squared distance of a pixel to an open polyline.
 * @param {Float64Array} line
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function lineDistance2(line, x, y) {
	var best = Infinity;
	for (var i = 0; i + 3 < line.length; i += 2) {
		var ax = line[i], ay = line[i + 1], dx = line[i + 2] - ax, dy = line[i + 3] - ay, L = dx * dx + dy * dy;
		var t = L > 0 ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
		if (t < 0) t = 0; else if (t > 1) t = 1;
		var ex = x - ax - t * dx, ey = y - ay - t * dy, d = ex * ex + ey * ey;
		if (d < best) best = d;
	}
	return best;
}

// does segment (ax, ay)-(bx, by) meet the rectangle? (Liang-Barsky)
function segmentMeetsRect(ax, ay, bx, by, x0, y0, x1, y1) {
	var t0 = 0, t1 = 1, dx = bx - ax, dy = by - ay, p = [-dx, dx, -dy, dy], q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
	for (var k = 0; k < 4; k++) {
		if (p[k] === 0) { if (q[k] < 0) return false; continue; }
		var r = q[k] / p[k];
		if (p[k] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
		else { if (r < t0) return false; if (r < t1) t1 = r; }
	}
	return true;
}

/**
 * Whether a box can hold a point near an open polyline drawn on the screen: -1 none of it can, 0 point by point
 * (never all of it: a line has no inside).
 * @param {object} s - from screenOf
 * @param {{minX, minY, minZ, maxX, maxY, maxZ}} box - world coordinates
 * @param {Float64Array} line - pixels
 * @param {number} margin - pixels (the tolerance and a little more)
 * @returns {-1|0}
 */
export function boxNearLine(s, box, line, margin) {
	var m = s.m, out = [0, 0, 0, 0, 0, 0], behind = false;
	var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (var q = 0; q < 8; q++) {
		var x = (q % 2 ? box.maxX : box.minX) - s.o[0], y = (q % 4 >= 2 ? box.maxY : box.minY) - s.o[1], z = (q >= 4 ? box.maxZ : box.minZ) - s.o[2];
		var w = m[3] * x + m[7] * y + m[11] * z + m[15];
		var cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cz = m[2] * x + m[6] * y + m[10] * z + m[14];
		var e = CLIP_SLACK * Math.abs(w), d = [w + cx, w - cx, w + cy, w - cy, w + cz, w - cz];
		for (var p = 0; p < 6; p++) if (d[p] < -e) out[p]++;
		if (!(w > 0)) { behind = true; continue; }
		var px = (cx / w + 1) / 2 * s.width, py = (1 - cy / w) / 2 * s.height;
		if (px < minX) minX = px; if (px > maxX) maxX = px;
		if (py < minY) minY = py; if (py > maxY) maxY = py;
	}
	for (var k = 0; k < 6; k++) if (out[k] === 8) return -1;
	if (behind) return 0;
	minX -= margin; minY -= margin; maxX += margin; maxY += margin;
	for (var i = 0; i + 3 < line.length; i += 2) if (segmentMeetsRect(line[i], line[i + 1], line[i + 2], line[i + 3], minX, minY, maxX, maxY)) return 0;
	return -1;
}

/**
 * Where a box lies against a polygon drawn on the screen: -1 none of it selected, 1 all of it, 0 point by point.
 * @param {object} s - from screenOf
 * @param {{minX, minY, minZ, maxX, maxY, maxZ}} box - world coordinates
 * @param {Float64Array} polygon - pixels
 * @param {number} margin - pixels (the tolerance and a little more)
 * @returns {-1|0|1}
 */
export function boxOnScreen(s, box, polygon, margin) {
	var m = s.m, out = [0, 0, 0, 0, 0, 0], inside = [0, 0, 0, 0, 0, 0], behind = false;
	var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (var q = 0; q < 8; q++) {
		var x = (q % 2 ? box.maxX : box.minX) - s.o[0], y = (q % 4 >= 2 ? box.maxY : box.minY) - s.o[1], z = (q >= 4 ? box.maxZ : box.minZ) - s.o[2];
		var w = m[3] * x + m[7] * y + m[11] * z + m[15];
		var cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cz = m[2] * x + m[6] * y + m[10] * z + m[14];
		var e = CLIP_SLACK * Math.abs(w), d = [w + cx, w - cx, w + cy, w - cy, w + cz, w - cz];
		for (var p = 0; p < 6; p++) { if (d[p] < -e) out[p]++; else if (d[p] > e) inside[p]++; }
		if (!(w > 0)) { behind = true; continue; }
		var px = (cx / w + 1) / 2 * s.width, py = (1 - cy / w) / 2 * s.height;
		if (px < minX) minX = px; if (px > maxX) maxX = px;
		if (py < minY) minY = py; if (py > maxY) maxY = py;
	}
	for (var k = 0; k < 6; k++) if (out[k] === 8) return -1;
	if (behind) return 0;
	var r = rectAgainstPolygon(polygon, minX, minY, maxX, maxY, margin);
	if (r < 0) return -1;
	return r > 0 && inside.every(function (c) { return c === 8; }) ? 1 : 0;
}
