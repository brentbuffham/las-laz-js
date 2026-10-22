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

/**
 * A new typed array of the same type as a (a Node Buffer gives a Uint8Array).
 * Internal; not exported from the package entry.
 * @param {TypedArray} a
 * @param {number} length
 * @returns {TypedArray}
 */
export function sameType(a, length) {
	var Ctor = globalThis[Object.prototype.toString.call(a).slice(8, -1)];
	return new Ctor(length);
}

/**
 * dst[i] = src[sel[i]] for each i (k values each; internal, not exported from the package entry).
 * dst may be src: i <= sel[i], so ascending writes never overwrite a value still to be read.
 * @param {TypedArray} src
 * @param {TypedArray} dst
 * @param {number} k
 * @param {Uint32Array} sel - strictly ascending.
 */
export function gather(src, dst, k, sel) {
	var n = sel.length;
	if (k === 1) {
		for (var i = 0; i < n; i++) dst[i] = src[sel[i]];
		return;
	}
	for (var p = 0; p < n; p++) {
		var from = sel[p] * k;
		var to = p * k;
		for (var j = 0; j < k; j++) dst[to + j] = src[from + j];
	}
}

/**
 * Throw INVALID_ARGUMENT when two of the named columns overlap in memory (internal; not exported
 * from the package entry). In-place compaction writes into every column's buffer, so two columns
 * whose byte ranges overlap would corrupt each other: refuse before any write.
 * @param {object} cols
 * @param {Array<{name: string}>} list - the columns to check, by name.
 */
export function checkNoSharedMemory(cols, list) {
	for (var i = 0; i < list.length; i++) {
		var a = cols[list[i].name];
		if (a.byteLength === 0) continue;
		for (var j = i + 1; j < list.length; j++) {
			var b = cols[list[j].name];
			if (b.byteLength === 0 || a.buffer !== b.buffer) continue;
			if (a.byteOffset < b.byteOffset + b.byteLength && b.byteOffset < a.byteOffset + a.byteLength) {
				throw bad("inPlace: columns \"" + list[i].name + "\" and \"" + list[j].name + "\" share memory");
			}
		}
	}
}

var FLOATS = { Float64Array: 8, Float32Array: 4 };
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

var INTS = {
	Int8Array: [1, true], Int16Array: [2, true], Int32Array: [4, true],
	Uint8Array: [1, false], Uint8ClampedArray: [1, false], Uint16Array: [2, false], Uint32Array: [4, false]
};
var BIGS = { BigInt64Array: true, BigUint64Array: true };

/**
 * The typed-array type a merge of columns of these types is stored in
 * (internal; not exported from the package entry). Float64 beats Float32
 * beats any integer type, except that Float32 with a 32-bit integer type
 * (Int32, Uint32) gives Float64, since Float32 holds integers exactly only
 * to 2^24. Among integers the widest wins, and mixed
 * signedness is allowed only when the widest is signed and strictly
 * wider than every unsigned one (Uint8 + Int16 gives Int16); Int16 +
 * Uint16 and Int8 + Uint16 throw, because the unsigned values would wrap.
 * Uint8ClampedArray counts as Uint8Array. A BigInt array only merges
 * with its own type.
 * @param {Function[]} types - typed-array constructors, at least one.
 * @param {string} name - the column, for the message.
 * @returns {Function}
 */
export function widestType(types, name) {
	var label = "column \"" + name + "\"";
	if (!Array.isArray(types) || types.length === 0) throw bad(label + " has no types to merge");
	var names = types.map(function (t) {
		var n = t && t.name;
		if (typeof n !== "string" || (!has(FLOATS, n) && !has(INTS, n) && !has(BIGS, n))) throw bad(label + " has a type that is not a typed-array constructor");
		return n === "Uint8ClampedArray" ? "Uint8Array" : n;
	});
	var first = names[0];
	if (has(BIGS, first)) {
		names.forEach(function (n) {
			if (n !== first) throw bad(label + " cannot merge " + first + " with " + n);
		});
		return globalThis[first];
	}
	names.forEach(function (n) {
		if (has(BIGS, n)) throw bad(label + " cannot merge " + n + " with " + first);
	});
	if (names.indexOf("Float64Array") >= 0) return Float64Array;
	if (names.indexOf("Float32Array") >= 0) {
		// Float32 holds integers exactly only to 2^24: 32-bit integers (an index column) go to Float64
		if (names.indexOf("Int32Array") >= 0 || names.indexOf("Uint32Array") >= 0) return Float64Array;
		return Float32Array;
	}
	var maxS = 0;
	var maxU = 0;
	names.forEach(function (n) {
		var b = INTS[n][0];
		if (INTS[n][1]) { if (b > maxS) maxS = b; } else if (b > maxU) maxU = b;
	});
	if (maxS > 0 && maxU > 0 && maxS <= maxU) {
		throw bad(label + " cannot merge signed Int" + maxS * 8 + "Array with unsigned Uint" + maxU * 8 + "Array (values would wrap)");
	}
	if (maxS > 0) return globalThis["Int" + maxS * 8 + "Array"];
	return globalThis["Uint" + maxU * 8 + "Array"];
}
