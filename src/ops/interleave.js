// src/ops/interleave.js
//==========================================================
// Interleaved positions for a renderer: x, y[, z] packed per point
// into one typed array (Kirra uploads these to Three.js). Values
// are written in Float64 and shifted by an optional origin before
// they are stored, so large world coordinates keep their decimals
// in a Float32 buffer.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { countOf, needColumn } from "./columns.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

// The origin axis as a number to subtract, or 0 when it is absent or not finite.
function shiftOf(origin, axis) {
	var v = origin[axis];
	if (v === undefined || v === null) return 0;
	if (typeof v !== "number") throw bad("origin." + axis + " must be a number");
	return Number.isFinite(v) ? v : 0;
}

/**
 * Pack point positions as interleaved values, x y z (stride 3) or x y
 * (stride 2). Each value is shifted by the origin in Float64, then
 * stored. An origin axis that is absent or not finite is not shifted,
 * so { x, y } keeps world Z.
 * @param {object} cols - point columns with x and y (and z for "xyz").
 * @param {{layout?: "xyz"|"xy", into?: Float32Array|Float64Array, at?: number,
 *   origin?: {x?: number, y?: number, z?: number}, float32?: boolean}} [options]
 *   layout: default "xyz". into: a caller's buffer, written from element at × stride
 *   (default: a new Float32Array when float32 is true or omitted, else a Float64Array).
 *   at: whole number ≥ 0, default 0.
 * @returns {Float32Array|Float64Array} into, or the new array.
 * @throws {LasError} INVALID_ARGUMENT when an argument is wrong or into is too short.
 */
export function interleavePositions(cols, options) {
	var opt = options === undefined ? {} : options;
	if (opt === null || typeof opt !== "object") throw bad("options must be an object");
	var n = countOf(cols);
	var layout = opt.layout === undefined ? "xyz" : opt.layout;
	if (layout !== "xyz" && layout !== "xy") throw bad("layout " + String(layout) + " is not \"xyz\" or \"xy\"");
	var stride = layout === "xyz" ? 3 : 2;
	var at = opt.at === undefined ? 0 : opt.at;
	if (typeof at !== "number" || !Number.isInteger(at) || at < 0) throw bad("at " + String(at) + " is not a whole number ≥ 0");
	var origin = opt.origin === undefined || opt.origin === null ? {} : opt.origin;
	if (typeof origin !== "object") throw bad("origin must be an object { x, y, z }");
	var sx = shiftOf(origin, "x");
	var sy = shiftOf(origin, "y");
	var sz = layout === "xyz" ? shiftOf(origin, "z") : 0;

	var x = needColumn(cols, "x", "interleavePositions");
	var y = needColumn(cols, "y", "interleavePositions");
	var z = layout === "xyz" ? needColumn(cols, "z", "interleavePositions") : null;

	var into = opt.into;
	if (into === undefined) {
		var f32 = opt.float32 === undefined ? true : opt.float32;
		into = f32 ? new Float32Array(n * stride) : new Float64Array(n * stride);
	} else if (!(into instanceof Float32Array) && !(into instanceof Float64Array)) {
		throw bad("into must be a Float32Array or a Float64Array");
	}
	if ((at + n) * stride > into.length) throw bad("into is too short: needs " + (at + n) * stride + " elements from " + at * stride + ", has " + into.length);

	var base = at * stride;
	if (stride === 3) {
		for (var i = 0; i < n; i++) {
			var o = base + i * 3;
			into[o] = x[i] - sx;
			into[o + 1] = y[i] - sy;
			into[o + 2] = z[i] - sz;
		}
	} else {
		for (var j = 0; j < n; j++) {
			var p = base + j * 2;
			into[p] = x[j] - sx;
			into[p + 1] = y[j] - sy;
		}
	}
	return into;
}
