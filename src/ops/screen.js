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
