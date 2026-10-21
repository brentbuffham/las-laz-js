// src/write/encodeRecords.js
//==========================================================
// PointColumns -> raw LAS point records, the inverse of
// read/decodeRecords.js: same field offsets (format/PointFormats),
// same bit layouts. Missing columns are written as 0. Bit packing
// acts on single field bytes (marked // bits-ok).
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { POINT_FORMATS } from "../format/PointFormats.js";

var LE = true;
var INT32_MAX = 2147483647, INT32_MIN = -2147483648;

function zero() { return 0; }
function col(cols, name) { var c = cols[name]; return c ? function (i) { return c[i]; } : zero; }

/**
 * Encode records into `out` (a DataView) starting at byte `at`.
 * @param {object} cols - PointColumns (world coordinates unless origin is given)
 * @param {number} pointFormat
 * @param {number} recordLength
 * @param {{scale:object, offset:object}} so
 * @param {{x?:number,y?:number,z?:number}} [origin] - added to x / y / z before encoding
 * @param {DataView} out
 * @param {number} at
 * @param {object} totals - updated: bounds (quantised world values) and byReturn counts
 * @param {number} [first=0] - the index of cols' first point in the caller's points (named in errors)
 */
export function encodeRecords(cols, pointFormat, recordLength, so, origin, out, at, totals, first) {
	var fmt = POINT_FORMATS[pointFormat];
	var F = fmt.fields;
	var ox = origin && isFinite(origin.x) ? origin.x : 0;
	var oy = origin && isFinite(origin.y) ? origin.y : 0;
	var oz = origin && isFinite(origin.z) ? origin.z : 0;
	var get = {};
	["intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scannerChannel", "scanAngle", "userData", "pointSourceId", "gpsTime", "red", "green", "blue", "nir"].forEach(function (n) { get[n] = col(cols, n); });
	var b = totals.bounds;
	for (var i = 0; i < cols.count; i++) {
		var p = at + i * recordLength;
		var X = Math.round((cols.x[i] + ox - so.offset.x) / so.scale.x);
		var Y = Math.round((cols.y[i] + oy - so.offset.y) / so.scale.y);
		var Z = Math.round(((cols.z ? cols.z[i] : 0) + oz - so.offset.z) / so.scale.z);
		if (X > INT32_MAX || X < INT32_MIN || Y > INT32_MAX || Y < INT32_MIN || Z > INT32_MAX || Z < INT32_MIN) {
			throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "point " + ((first || 0) + i) + " does not fit the scale and offset (int32 overflow); use a coarser scale");
		}
		out.setInt32(p, X, LE); out.setInt32(p + 4, Y, LE); out.setInt32(p + 8, Z, LE);
		var wx = X * so.scale.x + so.offset.x, wy = Y * so.scale.y + so.offset.y, wz = Z * so.scale.z + so.offset.z;
		if (wx < b.minX) b.minX = wx; if (wx > b.maxX) b.maxX = wx;
		if (wy < b.minY) b.minY = wy; if (wy > b.maxY) b.maxY = wy;
		if (wz < b.minZ) b.minZ = wz; if (wz > b.maxZ) b.maxZ = wz;
		out.setUint16(p + 12, get.intensity(i), LE);
		var ret = get.returnNumber(i), num = get.numberOfReturns(i);
		var dir = get.scanDirection(i) ? 1 : 0, edge = get.edgeOfFlightLine(i) ? 1 : 0;
		if (ret >= 1 && ret <= 15) totals.byReturn[ret - 1]++;
		if (fmt.extended) {
			out.setUint8(p + 14, (ret & 15) + (num & 15) * 16); // bits-ok
			out.setUint8(p + 15, (get.classificationFlags(i) & 15) + (get.scannerChannel(i) & 3) * 16 + dir * 64 + edge * 128); // bits-ok
			out.setUint8(p + 16, get.classification(i));
			out.setUint8(p + 17, get.userData(i));
			out.setInt16(p + 18, Math.max(-30000, Math.min(30000, Math.round(get.scanAngle(i) / 0.006))), LE);
		} else {
			out.setUint8(p + 14, (ret & 7) + (num & 7) * 8 + dir * 64 + edge * 128); // bits-ok
			out.setUint8(p + 15, (get.classification(i) & 31) + (get.classificationFlags(i) & 7) * 32); // bits-ok
			out.setInt8(p + 16, Math.max(-90, Math.min(90, Math.round(get.scanAngle(i)))));
			out.setUint8(p + 17, get.userData(i));
		}
		out.setUint16(p + F.pointSourceId.offset, get.pointSourceId(i), LE);
		if (F.gpsTime) out.setFloat64(p + F.gpsTime.offset, get.gpsTime(i), LE);
		if (F.red) {
			out.setUint16(p + F.red.offset, get.red(i), LE);
			out.setUint16(p + F.green.offset, get.green(i), LE);
			out.setUint16(p + F.blue.offset, get.blue(i), LE);
		}
		if (F.nir) out.setUint16(p + F.nir.offset, get.nir(i), LE);
	}
}
