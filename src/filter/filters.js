// src/filter/filters.js
//==========================================================
// Record filters that run on the RAW record, before decoding, so
// rejected points cost one or two byte reads (Kirra's classFilter
// trick, generalised): classification codes, return numbers and a
// 3D box. Filters combine with AND.
// maxPoints thinning is NOT Kirra's floor-stride-and-cap rule, which
// kept only the start of the file and, run before the filters,
// could leave nothing: decodeRecords thins the records that PASS,
// evenly over the whole file (countKept supplies their number).
//==========================================================

import { POINT_FORMATS } from "../format/PointFormats.js";

var LE = true;

/**
 * Build a keep(view, recordOffset) test for decodeRecords.
 * @param {object} [filter] - { classes?: number[], returns?: number[], bounds?: {minX,maxX,minY,maxY,minZ,maxZ} }
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
	if (filter.bounds) {
		var b = filter.bounds, s = header.scale, o = header.offset;
		tests.push(function (v, at) {
			var x = v.getInt32(at, LE) * s.x + o.x;
			if (x < b.minX || x > b.maxX) return false;
			var y = v.getInt32(at + 4, LE) * s.y + o.y;
			if (y < b.minY || y > b.maxY) return false;
			var z = v.getInt32(at + 8, LE) * s.z + o.z;
			return z >= b.minZ && z <= b.maxZ;
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
