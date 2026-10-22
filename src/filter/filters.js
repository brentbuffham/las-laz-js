// src/filter/filters.js
//==========================================================
// Record filters that run on the RAW record, before decoding, so
// rejected points cost one or two byte reads (Kirra's classFilter
// trick, generalised): classification codes, return numbers, a
// 3D box and a polygon (crop on read). Filters combine with AND.
// maxPoints thinning is NOT Kirra's floor-stride-and-cap rule, which
// kept only the start of the file and, run before the filters,
// could leave nothing: decodeRecords thins the records that PASS,
// evenly over the whole file (countKept supplies their number).
//==========================================================

import { POINT_FORMATS } from "../format/PointFormats.js";
import { makePolygonTest } from "../ops/polygon.js";

var LE = true;

function limit(v, open) { return v === undefined ? open : v; }

/**
 * Build a keep(view, recordOffset) test for decodeRecords.
 * @param {object} [filter] - { classes?: number[], returns?: number[], bounds?: {minX,maxX,minY,maxY,minZ,maxZ} (an omitted limit is open),
 *   polygon?: number[] [x0, y0, x1, y1, ...] with boundary ("touching" | "inside") and tolerance as selectPolygon, in the file's world coordinates }
 * @param {object} header - from parseHeader.
 * @returns {function(DataView, number): boolean|null} null when there is nothing to filter
 */
export function makeKeep(filter, header) {
	filter = filter || {};
	var tests = [];
	var ext = POINT_FORMATS[header.pointFormat].extended;
	if (Array.isArray(filter.classes) && filter.classes.length) {
		var cls = new Uint8Array(256);
		filter.classes.forEach(function (c) { cls[c] = 1; });
		tests.push(ext
			? function (v, at) { return cls[v.getUint8(at + 16)] === 1; }
			: function (v, at) { return cls[v.getUint8(at + 15) & 31] === 1; }); // bits-ok
	}
	if (Array.isArray(filter.returns) && filter.returns.length) {
		var ret = new Uint8Array(16);
		filter.returns.forEach(function (r) { ret[r] = 1; });
		tests.push(ext
			? function (v, at) { return ret[v.getUint8(at + 14) & 15] === 1; } // bits-ok
			: function (v, at) { return ret[v.getUint8(at + 14) & 7] === 1; }); // bits-ok
	}
	var sc = header.scale, of = header.offset;
	if (filter.bounds) {
		// an omitted limit is open
		var b = filter.bounds;
		var minX = limit(b.minX, -Infinity), maxX = limit(b.maxX, Infinity);
		var minY = limit(b.minY, -Infinity), maxY = limit(b.maxY, Infinity);
		var minZ = limit(b.minZ, -Infinity), maxZ = limit(b.maxZ, Infinity);
		tests.push(function (v, at) {
			var x = v.getInt32(at, LE) * sc.x + of.x;
			if (x < minX || x > maxX) return false;
			var y = v.getInt32(at + 4, LE) * sc.y + of.y;
			if (y < minY || y > maxY) return false;
			var z = v.getInt32(at + 8, LE) * sc.z + of.z;
			return z >= minZ && z <= maxZ;
		});
	}
	if (filter.polygon !== undefined) {
		// the file's world x, y of the raw record, as the bounds test computes them; boundary and tolerance as selectPolygon
		var poly = makePolygonTest(filter.polygon, { boundary: filter.boundary, tolerance: filter.tolerance });
		var inPoly = poly.test;
		tests.push(function (v, at) {
			var x = v.getInt32(at, LE) * sc.x + of.x;
			var y = v.getInt32(at + 4, LE) * sc.y + of.y;
			return inPoly(x, y);   // rejects outside its box before any edge work
		});
	}
	if (!tests.length) return null;
	if (tests.length === 1) return tests[0];
	return function (v, at) {
		for (var i = 0; i < tests.length; i++) if (!tests[i](v, at)) return false;
		return true;
	};
}

/**
 * Count the records in a window of whole records that pass keep.
 * @param {Uint8Array} bytes
 * @param {number} recordLength
 * @param {function(DataView, number): boolean} keep
 * @returns {number}
 */
export function countKept(bytes, recordLength, keep) {
	var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var n = Math.floor(bytes.length / recordLength), k = 0;
	for (var i = 0; i < n; i++) if (keep(view, i * recordLength)) k++;
	return k;
}
