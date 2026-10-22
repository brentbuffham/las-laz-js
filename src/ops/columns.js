// src/ops/columns.js
//==========================================================
// Point columns and selections, the two shapes every operation in
// src/ops takes. Columns are the object readPoints returns (or any
// caller's object of the same shape): { count, <name>: TypedArray }.
// A property is a column when it is a typed array of length
// count * k, k a whole number >= 1 (k = 1 for x, classification;
// k = 3 for an interleaved positions or rgb). A selection is a
// Uint32Array of point indices, strictly ascending, each < count.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

var MAX_INDEX = 4294967295;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

function isTyped(v) { return ArrayBuffer.isView(v) && !(v instanceof DataView); }

/**
 * Check cols.count is a whole number >= 0 and return it.
 * @param {object} cols - point columns.
 * @returns {number}
 */
export function countOf(cols) {
	if (cols === null || typeof cols !== "object") throw bad("columns must be an object { count, <name>: TypedArray }");
	var n = cols.count;
	if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw bad("count " + String(n) + " is not a whole number ≥ 0");
	return n;
}

/**
 * The columns of a point-column object: own typed-array properties of
 * length count * k. With count 0, every typed array of length 0 is a
 * k = 1 column. Everything else (numbers, bounds, a typed array of any
 * other length) is skipped silently.
 * @param {object} cols
 * @returns {Array<{name: string, k: number}>}
 */
export function columnsOf(cols) {
	var n = countOf(cols);
	var out = [];
	Object.keys(cols).forEach(function (name) {
		var a = cols[name];
		if (!isTyped(a)) return;
		if (n === 0) {
			if (a.length === 0) out.push({ name: name, k: 1 });
			return;
		}
		var k = a.length / n;
		if (Number.isInteger(k) && k >= 1) out.push({ name: name, k: k });
	});
	return out;
}

/**
 * Validate a selection and return it as a Uint32Array. Accepts a
 * Uint32Array or a plain Array of whole numbers; it must be strictly
 * ascending with every index below count.
 * @param {Uint32Array|number[]} sel
 * @param {number} count - points in the columns (Infinity: no upper limit).
 * @param {string} [name] - how the message names it (default "selection").
 * @returns {Uint32Array}
 */
export function checkSelection(sel, count, name) {
	name = name || "selection";
	var isU32 = sel instanceof Uint32Array;
	if (!isU32 && !Array.isArray(sel)) throw bad(name + " must be a Uint32Array or an Array of whole numbers");
	var prev = -1;
	for (var i = 0; i < sel.length; i++) {
		var v = sel[i];
		var at = name + "[" + i + "] = " + v;
		if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw bad(at + " is not a whole number ≥ 0");
		if (v > MAX_INDEX) throw bad(at + " is not below " + (MAX_INDEX + 1));
		if (v <= prev) throw bad(at + " is not above " + name + "[" + (i - 1) + "] = " + prev);
		if (v >= count) throw bad(at + " is not below count " + count);
		prev = v;
	}
	return isU32 ? sel : Uint32Array.from(sel);
}

/**
 * The k = 1 column called name, or an error naming the function.
 * @param {object} cols
 * @param {string} name
 * @param {string} fn - the calling function, for the message.
 * @returns {TypedArray}
 */
export function needColumn(cols, name, fn) {
	var n = countOf(cols);
	var a = cols[name];
	if (!isTyped(a) || a.length !== n) throw bad(fn + " needs a " + name + " column");
	return a;
}
