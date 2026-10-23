// src/write/encodeRecords.js
//==========================================================
// PointColumns -> raw LAS point records, the inverse of
// read/decodeRecords.js: same field offsets (format/PointFormats),
// same bit layouts. Missing columns are written as 0. Bit packing
// acts on single field bytes (marked // bits-ok).
// Extra-bytes fields (a layout from format/ExtraBytes.js) come from
// their columns, which must be there: every value of a batch is checked
// (and its raw min / max taken) before any byte is written, so a refused
// batch changes nothing; then each is quantised again as it is written.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { POINT_FORMATS } from "../format/PointFormats.js";

var LE = true;
var INT32_MAX = 2147483647, INT32_MIN = -2147483648;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

// One extra field's raw value for point i of col: a Number, or a BigInt for a 64-bit integer type
function rawOf(f, col, i, first) {
	var e = f.elem, v = col[i], r, label = "extra bytes field \"" + f.name + "\": point " + (first + i);
	if (f.scaled) {
		v = Number(v);
		if (v !== v) {
			if (f.noData === null) throw bad(label + " is NaN and the field has no noData to write it as");
			return e.big ? BigInt(f.noData) : f.noData;
		}
		r = (v - (f.offset === null ? 0 : f.offset)) / (f.scale === null ? 1 : f.scale);
		if (e.int) {
			r = Math.round(r);
			if (!Number.isSafeInteger(r)) throw bad(label + ": " + v + " is " + r + " raw, outside " + e.name + "'s range (" + e.min + " to " + e.max + ")");
		}
	} else if (e.int) {
		if (typeof v === "bigint") r = v;
		else if (typeof v !== "number" || !Number.isInteger(v)) throw bad(label + ": " + v + " is not a whole number (" + e.name + ")");
		else if (!Number.isSafeInteger(v)) throw bad(label + ": " + v + " is past 2^53, where Numbers are not exact; give 64-bit values as a BigInt64Array / BigUint64Array");
		else r = v;
	} else r = Number(v);
	if (e.big) {
		r = BigInt(r);
		if (r < e.min || r > e.max) throw bad(label + ": " + v + " is outside " + e.name + "'s range (" + e.min + " to " + e.max + ")");
	} else if (r === r && isFinite(r) && (r < e.min || r > e.max)) {
		throw bad(label + ": " + v + (f.scaled ? " is " + r + " raw," : " is") + " outside " + e.name + "'s range (" + e.min + " to " + e.max + ")");
	}
	return r;
}

// Check every extra value of the batch; per field its raw { min, max } (no-data and NaN left out), or null
function checkExtra(cols, extra, first) {
	return extra.map(function (f) {
		var col = cols[f.column], label = "extra bytes field \"" + f.name + "\"", w = f.code === 0 ? f.size : 1;
		if (col === undefined || col === null) throw bad(label + ": column \"" + f.column + "\" is missing from the points");
		if (!(ArrayBuffer.isView(col) || Array.isArray(col))) throw bad(label + ": column \"" + f.column + "\" must be a typed array or an array");
		if (col.length !== cols.count * w) throw bad(label + ": column \"" + f.column + "\" has length " + col.length + ", not " + cols.count * w + " (" + w + " a point)");
		if (f.code === 0) {
			if (!(col instanceof Uint8Array)) for (var j = 0; j < col.length; j++) if (!(Number.isInteger(col[j]) && col[j] >= 0 && col[j] <= 255)) throw bad(label + ": byte " + j + " of the raw column is " + col[j] + ", not 0-255");
			return null;
		}
		var nd = f.noData === null ? null : f.elem.big ? BigInt(f.noData) : f.noData, lo = null, hi = null;
		for (var i = 0; i < cols.count; i++) {
			var r = rawOf(f, col, i, first);
			if (r !== r || r === nd) continue;
			if (lo === null || r < lo) lo = r;
			if (hi === null || r > hi) hi = r;
		}
		return lo === null ? null : { min: lo, max: hi };
	});
}

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
 * @param {object[]} [extra] - extra-bytes fields (layoutExtraBytes(...).fields); totals.extra gains their raw min / max
 */
export function encodeRecords(cols, pointFormat, recordLength, so, origin, out, at, totals, first, extra) {
	first = first || 0;
	var fmt = POINT_FORMATS[pointFormat];
	var F = fmt.fields;
	var ox = origin && isFinite(origin.x) ? origin.x : 0;
	var oy = origin && isFinite(origin.y) ? origin.y : 0;
	var oz = origin && isFinite(origin.z) ? origin.z : 0;
	var get = {};
	["intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scannerChannel", "scanAngle", "userData", "pointSourceId", "gpsTime", "red", "green", "blue", "nir"].forEach(function (n) { get[n] = col(cols, n); });
	// Formats 0-5 store a class in 5 bits: refuse a higher one before anything (totals included) is touched
	if (!fmt.extended) {
		for (var c = 0; c < cols.count; c++) {
			var cls = get.classification(c);
			if (cls > 31) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "point " + ((first || 0) + c) + " has class " + cls + "; point formats 0-5 hold classes 0-31 — write point format 6 or higher");
		}
	}
	var xs = extra && extra.length ? extra : null;
	var ranges = xs ? checkExtra(cols, xs, first) : null;
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
			out.setUint8(p + 15, get.classification(i) + (get.classificationFlags(i) & 7) * 32); // bits-ok (checked 0-31 above)
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
		if (xs) {
			for (var x = 0; x < xs.length; x++) {
				var xf = xs[x], xc = cols[xf.column];
				if (xf.code === 0) { for (var j = 0; j < xf.size; j++) out.setUint8(p + xf.at + j, xc[i * xf.size + j]); }
				else out[xf.elem.set](p + xf.at, rawOf(xf, xc, i, first), LE);
			}
		}
	}
	// the batch is written: its ranges join the totals
	if (ranges) ranges.forEach(function (r, k) {
		var t = totals.extra[k];
		if (!r) return;
		if (!t) totals.extra[k] = { min: r.min, max: r.max };
		else { if (r.min < t.min) t.min = r.min; if (r.max > t.max) t.max = r.max; }
	});
}
