// src/ops/transform.js
//==========================================================
// Coordinate transforms (Kirra's pre-transform: register a raw
// scan into site coordinates). A transform is one plain row-major
// object { m: [m00, m01, m02, m10, m11, m12, m20, m21, m22],
// t: [tx, ty, tz] }, applied as p' = m·p + t in Float64. It covers
// shift, rotation, scale and any affine map. makeTransform builds one;
// transformPoints applies it to point columns; the reader applies it
// to each record while decoding (record -> world -> T -> minus
// localOrigin -> Float32), so raw coordinates never pass through
// Float32 at full magnitude.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { countOf } from "./columns.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

function isTyped(v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); }

// A list of exactly n finite numbers (Array or typed array, not BigInt).
function isNumbers(a, n) {
	if (!Array.isArray(a) && !(isTyped(a) && !(a instanceof BigInt64Array) && !(a instanceof BigUint64Array))) return false;
	if (a.length !== n) return false;
	for (var i = 0; i < n; i++) if (typeof a[i] !== "number" || !isFinite(a[i])) return false;
	return true;
}

/**
 * Check a transform is { m: 9 finite numbers, t: 3 finite numbers }
 * (arrays or typed arrays) and return it (internal; not exported from
 * the package entry).
 * @param {object} T
 * @param {string} name - how the message names it, e.g. "transform".
 * @returns {{m: number[]|TypedArray, t: number[]|TypedArray}}
 * @throws {LasError} INVALID_ARGUMENT naming name.m or name.t.
 */
export function checkTransform(T, name) {
	if (T === null || typeof T !== "object") throw bad(name + " must be an object { m, t }");
	if (!isNumbers(T.m, 9)) throw bad(name + ".m must be 9 finite numbers (a row-major 3×3)");
	if (!isNumbers(T.t, 3)) throw bad(name + ".t must be 3 finite numbers");
	return T;
}

/**
 * Apply a transform to one point in Float64: out = m·p + t (internal;
 * not exported from the package entry). The transform is not checked.
 * @param {{m: ArrayLike<number>, t: ArrayLike<number>}} T
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number[]|Float64Array} out - receives x', y', z' at 0..2.
 * @returns {number[]|Float64Array} out
 */
export function applyTransform(T, x, y, z, out) {
	var m = T.m, t = T.t;
	out[0] = m[0] * x + m[1] * y + m[2] * z + t[0];
	out[1] = m[3] * x + m[4] * y + m[5] * z + t[1];
	out[2] = m[6] * x + m[7] * y + m[8] * z + t[2];
	return out;
}

// A list of exactly n finite numbers, or an error naming the option.
function numbers(v, n, name) {
	if (!isNumbers(v, n)) throw bad(name + " must be " + n + " finite numbers");
	return Array.prototype.slice.call(v);
}

// Rotation by deg anticlockwise about +Z as 9 row-major values, exact 0 / ±1 for whole quarter turns.
function rotationZ(deg) {
	var a = ((deg % 360) + 360) % 360;
	var c, s;
	if (a === 0) { c = 1; s = 0; }
	else if (a === 90) { c = 0; s = 1; }
	else if (a === 180) { c = -1; s = 0; }
	else if (a === 270) { c = 0; s = -1; }
	else {
		var r = (a * Math.PI) / 180;
		c = Math.cos(r); s = Math.sin(r);
	}
	return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/**
 * Build a transform: p' = scale · R · (p − about) + about + shift,
 * where R is `rotate` or the rotation by `rotateZ` degrees anticlockwise
 * about +Z. Result: m = scale · R, t = about + shift − m · about.
 * @param {{shift?: number[], rotateZ?: number, rotate?: number[], scale?: number, about?: number[]}} [options]
 *   shift, about: [x, y, z] (default 0). rotate: a row-major 3×3 (9 numbers).
 *   rotateZ and rotate are exclusive; the default is no rotation. scale: a number (default 1).
 * @returns {{m: number[], t: number[]}}
 * @throws {LasError} INVALID_ARGUMENT when an option is wrong or both rotations are given.
 */
export function makeTransform(options) {
	var o = options === undefined ? {} : options;
	if (o === null || typeof o !== "object") throw bad("options must be an object");
	if (o.rotate !== undefined && o.rotateZ !== undefined) throw bad("give rotate or rotateZ, not both");
	var R;
	if (o.rotate !== undefined) R = numbers(o.rotate, 9, "rotate");
	else if (o.rotateZ !== undefined) {
		if (typeof o.rotateZ !== "number" || !isFinite(o.rotateZ)) throw bad("rotateZ must be a finite number of degrees");
		R = rotationZ(o.rotateZ);
	} else R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	var scale = 1;
	if (o.scale !== undefined) {
		if (typeof o.scale !== "number" || !isFinite(o.scale)) throw bad("scale must be a finite number");
		scale = o.scale;
	}
	var shift = o.shift !== undefined ? numbers(o.shift, 3, "shift") : [0, 0, 0];
	var about = o.about !== undefined ? numbers(o.about, 3, "about") : [0, 0, 0];
	var m = R.map(function (v) { return scale * v + 0; });     // + 0: no negative zero
	var t = [0, 0, 0];
	for (var r = 0; r < 3; r++) {
		t[r] = about[r] + shift[r] - (m[r * 3] * about[0] + m[r * 3 + 1] * about[1] + m[r * 3 + 2] * about[2]) + 0;
	}
	return { m: m, t: t };
}

// A new typed array of the same type as a (a Node Buffer gives a Uint8Array).
function sameType(a, length) {
	var Ctor = globalThis[Object.prototype.toString.call(a).slice(8, -1)];
	return new Ctor(length);
}

/**
 * Transform the x, y and z columns of point columns. Each point is
 * computed in Float64 from the columns' values and stored into the
 * column's own type. Copy by default (new x, y, z; every other column
 * shared by reference; bounds and stats are not carried, they would be
 * stale); inPlace writes into the input's x, y and z.
 * @param {object} cols - point columns with x, y and z (k = 1).
 * @param {{m: ArrayLike<number>, t: ArrayLike<number>}} T - from makeTransform, or any affine map.
 * @param {{inPlace?: boolean}} [options]
 * @returns {object} PointColumns
 * @throws {LasError} INVALID_ARGUMENT when T is not a transform or x, y or z is missing.
 */
export function transformPoints(cols, T, options) {
	var opt = options === undefined ? {} : options;
	if (opt === null || typeof opt !== "object") throw bad("options must be an object");
	var n = countOf(cols);
	checkTransform(T, "transform");
	var a = [cols.x, cols.y, cols.z];
	for (var j = 0; j < 3; j++) {
		if (!isTyped(a[j]) || a[j].length !== n) throw bad("transformPoints needs x, y and z");
	}
	var inPlace = !!opt.inPlace;
	var x = a[0], y = a[1], z = a[2];
	var ox = inPlace ? x : sameType(x, n);
	var oy = inPlace ? y : sameType(y, n);
	var oz = inPlace ? z : sameType(z, n);
	var m = T.m, t = T.t;
	var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
	var t0 = t[0], t1 = t[1], t2 = t[2];
	for (var i = 0; i < n; i++) {
		var px = x[i], py = y[i], pz = z[i];
		ox[i] = m0 * px + m1 * py + m2 * pz + t0;
		oy[i] = m3 * px + m4 * py + m5 * pz + t1;
		oz[i] = m6 * px + m7 * py + m8 * pz + t2;
	}
	if (inPlace) return cols;
	var out = { count: n };
	Object.keys(cols).forEach(function (name) {
		if (name === "count" || name === "bounds" || name === "stats") return;
		if (isTyped(cols[name])) Object.defineProperty(out, name, { value: cols[name], enumerable: true, writable: true, configurable: true });
	});
	out.x = ox; out.y = oy; out.z = oz;
	return out;
}
