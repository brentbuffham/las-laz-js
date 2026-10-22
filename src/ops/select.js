// src/ops/select.js
//==========================================================
// Making selections: a Uint32Array of point indices, strictly
// ascending, from point columns (see columns.js). Box, class and
// return selections mean what the reader's filters mean; thinSelection
// is the reader's maxPoints rule, exported, and thinStep is the one
// place that rule lives (decodeRecords calls it per passing record).
// Set operations are linear merges of two ascending selections.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { countOf, checkSelection, needColumn } from "./columns.js";
import { makePolygonTest } from "./polygon.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

function whole(v) { return typeof v === "number" && Number.isInteger(v) && v >= 0; }

// out[0..n) as a copy that does not pin the full-size buffer.
function trim(out, n) { return n === out.length ? out : out.slice(0, n); }

// A lookup table of 256 flags for a list of whole numbers 0..255.
function table(list, name) {
	if (!Array.isArray(list)) throw bad(name + " must be an Array of whole numbers");
	var t = new Uint8Array(256);
	list.forEach(function (v, i) {
		if (!whole(v) || v > 255) throw bad(name + "[" + i + "] = " + v + " is not a whole number 0 to 255");
		t[v] = 1;
	});
	return t;
}

function bound(box, key) {
	var v = box[key];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "number" || v !== v) throw bad(key + " must be a number");
	return v;
}

/**
 * Indices of the points inside a box, bounds inclusive. An omitted
 * (undefined) or null bound is no limit, as in the reader's bounds. Needs x and y; z only when minZ or
 * maxZ is given.
 * @param {object} cols - point columns.
 * @param {{minX?:number, maxX?:number, minY?:number, maxY?:number, minZ?:number, maxZ?:number}} box
 * @returns {Uint32Array}
 */
export function selectBox(cols, box) {
	var n = countOf(cols);
	if (box === null || typeof box !== "object") throw bad("box must be an object { minX, maxX, minY, maxY, minZ, maxZ }");
	var minX = bound(box, "minX"), maxX = bound(box, "maxX");
	var minY = bound(box, "minY"), maxY = bound(box, "maxY");
	var minZ = bound(box, "minZ"), maxZ = bound(box, "maxZ");
	var x = needColumn(cols, "x", "selectBox"), y = needColumn(cols, "y", "selectBox");
	var useZ = minZ !== undefined || maxZ !== undefined;
	var z = useZ ? needColumn(cols, "z", "selectBox") : null;
	if (minX === undefined) minX = -Infinity;
	if (maxX === undefined) maxX = Infinity;
	if (minY === undefined) minY = -Infinity;
	if (maxY === undefined) maxY = Infinity;
	if (minZ === undefined) minZ = -Infinity;
	if (maxZ === undefined) maxZ = Infinity;
	var out = new Uint32Array(n), m = 0;
	for (var i = 0; i < n; i++) {
		var vx = x[i];
		if (!(vx >= minX && vx <= maxX)) continue;
		var vy = y[i];
		if (!(vy >= minY && vy <= maxY)) continue;
		if (useZ) {
			var vz = z[i];
			if (!(vz >= minZ && vz <= maxZ)) continue;
		}
		out[m++] = i;
	}
	return trim(out, m);
}

/**
 * Indices of the points inside a polygon (even-odd rule), in the columns' own frame. A point on the
 * boundary (within tolerance of an edge or vertex, as the 2D distance to the segment in Float64) is
 * kept by boundary "touching" (default) and dropped by "inside", so the two differ by exactly the
 * boundary points. The boundary is decided before the crossing test. Needs x and y; z only when a Z
 * limit is given.
 * @param {object} cols - point columns.
 * @param {number[]|TypedArray} polygon - [x0, y0, x1, y1, ...], at least 3 vertices, implicitly closed.
 * @param {{boundary?: "touching"|"inside", tolerance?: number, minZ?: number, maxZ?: number}} [opts]
 * @returns {Uint32Array}
 */
export function selectPolygon(cols, polygon, opts) {
	var n = countOf(cols);
	if (opts === undefined || opts === null) opts = {};
	if (typeof opts !== "object") throw bad("options must be an object { boundary, tolerance, minZ, maxZ }");
	var poly = makePolygonTest(polygon, opts);
	var minZ = bound(opts, "minZ"), maxZ = bound(opts, "maxZ");
	var x = needColumn(cols, "x", "selectPolygon"), y = needColumn(cols, "y", "selectPolygon");
	var useZ = minZ !== undefined || maxZ !== undefined;
	var z = useZ ? needColumn(cols, "z", "selectPolygon") : null;
	if (minZ === undefined) minZ = -Infinity;
	if (maxZ === undefined) maxZ = Infinity;
	var test = poly.test;
	var out = new Uint32Array(n), m = 0;
	for (var i = 0; i < n; i++) {
		if (useZ) {
			var vz = z[i];
			if (!(vz >= minZ && vz <= maxZ)) continue;
		}
		if (test(x[i], y[i])) out[m++] = i;
	}
	return trim(out, m);
}

/**
 * Indices of the points whose classification is in the list.
 * @param {object} cols - point columns (needs classification).
 * @param {number[]} classes
 * @returns {Uint32Array}
 */
export function selectClasses(cols, classes) {
	var n = countOf(cols);
	var cls = needColumn(cols, "classification", "selectClasses");
	var t = table(classes, "classes");
	var out = new Uint32Array(n), m = 0;
	for (var i = 0; i < n; i++) if (cls[i] < 256 && t[cls[i]] === 1) out[m++] = i;
	return trim(out, m);
}

/**
 * Indices of the points matching any of the return criteria given:
 * returns (returnNumber in the list), first (returnNumber 1), last
 * (returnNumber equals numberOfReturns), single (numberOfReturns 1).
 * @param {object} cols - point columns (returnNumber; numberOfReturns for last / single).
 * @param {{returns?:number[], first?:boolean, last?:boolean, single?:boolean}} criteria
 * @returns {Uint32Array}
 */
export function selectReturns(cols, criteria) {
	var n = countOf(cols);
	if (criteria === null || typeof criteria !== "object") throw bad("criteria must be an object { returns, first, last, single }");
	var hasList = criteria.returns !== undefined;
	var first = !!criteria.first, last = !!criteria.last, single = !!criteria.single;
	if (!hasList && !first && !last && !single) throw bad("selectReturns needs returns, first, last or single");
	var t = hasList ? table(criteria.returns, "returns") : null;
	var rn = needColumn(cols, "returnNumber", "selectReturns");
	var nr = (last || single) ? needColumn(cols, "numberOfReturns", "selectReturns") : null;
	var out = new Uint32Array(n), m = 0;
	for (var i = 0; i < n; i++) {
		var r = rn[i];
		var hit = (hasList && r < 256 && t[r] === 1) || (first && r === 1) || (last && r === nr[i]) || (single && nr[i] === 1);
		if (hit) out[m++] = i;
	}
	return trim(out, m);
}

/**
 * One step of the reader's even-thinning rule. thin is
 * { total, target, acc }: acc gains target per record and the record
 * is kept each time acc reaches total (then acc -= total). The j-th
 * kept record is number ceil(j * total / target) - 1.
 * @param {{total:number, target:number, acc:number}} thin - updated in place.
 * @returns {boolean} true when this record is kept.
 */
export function thinStep(thin) {
	thin.acc += thin.target;
	if (thin.acc < thin.total) return false;
	thin.acc -= thin.total;
	return true;
}

/**
 * The reader's maxPoints rule as a selection: exactly min(count, target)
 * indices spread evenly over 0..count-1. readPoints({ maxPoints: target })
 * keeps the same points.
 * @param {number} count - points to choose from.
 * @param {number} target - points to keep.
 * @returns {Uint32Array}
 */
export function thinSelection(count, target) {
	if (!whole(count)) throw bad("count " + String(count) + " is not a whole number ≥ 0");
	if (!whole(target)) throw bad("target " + String(target) + " is not a whole number ≥ 0");
	var out, i;
	if (target >= count) {
		out = new Uint32Array(count);
		for (i = 0; i < count; i++) out[i] = i;
		return out;
	}
	out = new Uint32Array(target);
	var thin = { total: count, target: target, acc: 0 }, m = 0;
	for (i = 0; i < count && m < target; i++) if (thinStep(thin)) out[m++] = i;
	return out;
}

/**
 * Indices in a or in b.
 * @param {Uint32Array|number[]} a - ascending selection.
 * @param {Uint32Array|number[]} b - ascending selection.
 * @returns {Uint32Array}
 */
export function unionSelections(a, b) {
	a = checkSelection(a, Infinity, "a");
	b = checkSelection(b, Infinity, "b");
	var out = new Uint32Array(a.length + b.length), i = 0, j = 0, m = 0;
	while (i < a.length && j < b.length) {
		if (a[i] < b[j]) out[m++] = a[i++];
		else if (a[i] > b[j]) out[m++] = b[j++];
		else { out[m++] = a[i++]; j++; }
	}
	while (i < a.length) out[m++] = a[i++];
	while (j < b.length) out[m++] = b[j++];
	return trim(out, m);
}

/**
 * Indices in both a and b.
 * @param {Uint32Array|number[]} a - ascending selection.
 * @param {Uint32Array|number[]} b - ascending selection.
 * @returns {Uint32Array}
 */
export function intersectSelections(a, b) {
	a = checkSelection(a, Infinity, "a");
	b = checkSelection(b, Infinity, "b");
	var out = new Uint32Array(Math.min(a.length, b.length)), i = 0, j = 0, m = 0;
	while (i < a.length && j < b.length) {
		if (a[i] < b[j]) i++;
		else if (a[i] > b[j]) j++;
		else { out[m++] = a[i++]; j++; }
	}
	return trim(out, m);
}

/**
 * Indices in a that are not in b.
 * @param {Uint32Array|number[]} a - ascending selection.
 * @param {Uint32Array|number[]} b - ascending selection.
 * @returns {Uint32Array}
 */
export function subtractSelections(a, b) {
	a = checkSelection(a, Infinity, "a");
	b = checkSelection(b, Infinity, "b");
	var out = new Uint32Array(a.length), i = 0, j = 0, m = 0;
	while (i < a.length) {
		while (j < b.length && b[j] < a[i]) j++;
		if (j < b.length && b[j] === a[i]) { i++; continue; }
		out[m++] = a[i++];
	}
	return trim(out, m);
}
