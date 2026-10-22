// src/ops/apply.js
//==========================================================
// Apply a selection to point columns: keepPoints, removePoints,
// splitPoints, and join clouds with mergePoints. Each carries every
// column, k values per point, and nothing else. Copy by default;
// { inPlace: true } slides the kept values down inside each column's
// own buffer and returns subarray views of it.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { columnsOf, checkSelection, countOf, widestType } from "./columns.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

// A new typed array of the same type as a (a Node Buffer gives a Uint8Array).
function sameType(a, length) {
	var Ctor = globalThis[Object.prototype.toString.call(a).slice(8, -1)];
	return new Ctor(length);
}

// dst[i] = src[sel[i]] (k values each). dst may be src: i <= sel[i], so
// ascending writes never overwrite a value still to be read.
function gather(src, dst, k, sel) {
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

// dst gets every point of src not in sel, in order. dst may be src: the
// write position never passes the read position.
function gatherComplement(src, dst, k, count, sel) {
	var p = 0;
	var w = 0;
	for (var i = 0; i < count; i++) {
		if (p < sel.length && sel[p] === i) { p++; continue; }
		var from = i * k;
		for (var j = 0; j < k; j++) dst[w + j] = src[from + j];
		w += k;
	}
}

// Shared body of keep / remove / split: validate once, then one pass per column.
function pick(cols, sel, keep, inPlace) {
	var count = countOf(cols);
	var s = checkSelection(sel, count);
	var n = keep ? s.length : count - s.length;
	var out = { count: n };
	columnsOf(cols).forEach(function (c) {
		var src = cols[c.name];
		var dst = inPlace ? src : sameType(src, n * c.k);
		if (keep) gather(src, dst, c.k, s);
		else gatherComplement(src, dst, c.k, count, s);
		out[c.name] = inPlace ? src.subarray(0, n * c.k) : dst;
	});
	return out;
}

/**
 * The selected points of every column, in order.
 * @param {object} cols - point columns { count, <name>: TypedArray }.
 * @param {Uint32Array|number[]} sel - strictly ascending indices below cols.count.
 * @param {{inPlace?: boolean}} [opts] - inPlace: slide the kept values down inside each column's own buffer and return subarray views of it (the input is overwritten). Default: new columns of the same types.
 * @returns {object} { count, <every column> } and nothing else.
 */
export function keepPoints(cols, sel, opts) {
	return pick(cols, sel, true, !!(opts && opts.inPlace));
}

/**
 * Every point except the selected ones, in order.
 * @param {object} cols - point columns { count, <name>: TypedArray }.
 * @param {Uint32Array|number[]} sel - strictly ascending indices below cols.count.
 * @param {{inPlace?: boolean}} [opts] - inPlace as keepPoints.
 * @returns {object} { count, <every column> } and nothing else.
 */
export function removePoints(cols, sel, opts) {
	return pick(cols, sel, false, !!(opts && opts.inPlace));
}

/**
 * Split into the selected points and the rest. Always copies; the input
 * is untouched and every point lands in exactly one result.
 * @param {object} cols - point columns { count, <name>: TypedArray }.
 * @param {Uint32Array|number[]} sel - strictly ascending indices below cols.count.
 * @returns {object[]} [inside, outside], each { count, <every column> }.
 */
export function splitPoints(cols, sel) {
	var count = countOf(cols);
	var s = checkSelection(sel, count);
	return [pick(cols, s, true, false), pick(cols, s, false, false)];
}

/**
 * Concatenate point columns in order. The column set is the union by name
 * in first-appearance order. A column missing from an input with points is
 * 0 for those points and its name is listed in `filled`. A column's k must
 * agree across inputs (a zero-point input has no k to disagree with); its
 * type is the widest across inputs, and merging signed with unsigned
 * integers that would wrap throws. Coordinates must already share a frame.
 * @param {object[]} list - point-column objects.
 * @returns {object} { count, <every column>, filled: string[] }.
 */
export function mergePoints(list) {
	if (!Array.isArray(list)) throw bad("list must be an Array of point columns");
	var total = 0;
	var info = {};
	var names = [];
	var perInput = list.map(function (cols, li) {
		var n = countOf(cols);
		var found = {};
		columnsOf(cols).forEach(function (c) {
			found[c.name] = true;
			var e = info[c.name];
			if (!e) { e = info[c.name] = { k: 0, types: [] }; names.push(c.name); }
			if (n > 0) {
				if (e.k !== 0 && e.k !== c.k) throw bad("column \"" + c.name + "\" has k = " + e.k + " in an earlier input but k = " + c.k + " in list[" + li + "]");
				e.k = c.k;
			}
			e.types.push(globalThis[Object.prototype.toString.call(cols[c.name]).slice(8, -1)]);
		});
		total += n;
		return { n: n, found: found };
	});
	var out = { count: total };
	var filled = [];
	names.forEach(function (name) {
		var e = info[name];
		var k = e.k || 1;
		var Type = widestType(e.types, name);
		var dst = new Type(total * k);
		var at = 0;
		perInput.forEach(function (inp, i) {
			if (inp.n > 0) {
				if (inp.found[name]) dst.set(list[i][name], at * k);
				else if (filled.indexOf(name) < 0) filled.push(name);
			}
			at += inp.n;
		});
		out[name] = dst;
	});
	out.filled = names.filter(function (name) { return filled.indexOf(name) >= 0; });
	return out;
}
