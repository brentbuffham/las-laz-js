// src/read/decodeRecords.js
//==========================================================
// Raw LAS point records -> one typed array per field. Works on a
// window of whole records (a Uint8Array), so the reader can feed
// a 30 GB file through it 64 MB at a time.
//
// Bit fields: legacy formats (0-5) pack returns 3+3 bits and the
// class 5 bits + 3 flag bits; extended formats (6-10) pack returns
// 4+4 bits, flags 4 bits + 2-bit scanner channel, and keep the
// class in its own byte. These masks act on single BYTES of field
// data, never on positions (marked // bits-ok for the guard test).
//
// opts.keep(view, recordOffset) rejects a record before it is
// decoded (filters, see filter/filters.js). opts.thin
// { total, target, acc } then keeps exactly target of the total
// records that pass, spread evenly: an integer accumulator gains
// target per passing record and keeps the record each time it
// reaches total (Bresenham), so record ceil(j * total / target) - 1
// is the j-th kept. acc is carried from window to window. The rule
// itself is thinStep in ops/select.js (thinSelection uses it too).
//
// opts.transform { m, t } registers the points while reading: per kept
// record, world = raw * scale + offset, then the transform (Float64),
// then minus localOrigin, then Float32 when asked. Filters (keep) see
// the raw record, so they work in file coordinates. With a transform
// all three world coordinates are computed whichever of x / y / z are
// wanted. Without one, the offset and origin fold into one constant.
//
// opts.extraBytes (reader.extraBytes, format/ExtraBytes.js) adds the
// file's extra-bytes columns: k values a point, interleaved; a scaled
// field as Float64 (raw x scale + offset, its no-data value NaN), an
// unscaled one in its stored type, raw bytes as Uint8Array.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { POINT_FORMATS } from "../format/PointFormats.js";
import { thinStep } from "../ops/select.js";
import { checkTransform } from "../ops/transform.js";
import { EXTRA_TYPES } from "../format/ExtraBytes.js";

/** Fields decoded when opts.fields is not given (colour added when the format has it). */
export var DEFAULT_FIELDS = Object.freeze(["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "classification"]);

/** Every field name decodeRecords understands, with its column type. */
export var FIELD_TYPES = Object.freeze({
	x: Float64Array, y: Float64Array, z: Float64Array,
	intensity: Uint16Array,
	returnNumber: Uint8Array, numberOfReturns: Uint8Array,
	scanDirection: Uint8Array, edgeOfFlightLine: Uint8Array,
	classification: Uint8Array, classificationFlags: Uint8Array,
	scannerChannel: Uint8Array,
	scanAngle: Float32Array,
	userData: Uint8Array, pointSourceId: Uint16Array,
	gpsTime: Float64Array,
	red: Uint16Array, green: Uint16Array, blue: Uint16Array, nir: Uint16Array,
	index: Uint32Array   // not a record field: the record number in the file (Float64 above 4294967295 points, see columnType)
});

var LE = true;

// Which fields a point format can supply.
function available(fmt) {
	var f = fmt.fields;
	var out = { x: 1, y: 1, z: 1, intensity: 1, returnNumber: 1, numberOfReturns: 1, scanDirection: 1, edgeOfFlightLine: 1, classification: 1, classificationFlags: 1, scanAngle: 1, userData: 1, pointSourceId: 1, index: 1 };
	if (fmt.extended) out.scannerChannel = 1;
	if (f.gpsTime) out.gpsTime = 1;
	if (f.red) { out.red = 1; out.green = 1; out.blue = 1; }
	if (f.nir) out.nir = 1;
	return out;
}

/**
 * The field list a read will produce for a header.
 * @param {object} header
 * @param {string[]} [fields] - "extra" stands for every extra column
 * @param {object[]} [extra] - the file's extra-bytes fields (reader.extraBytes)
 * @returns {string[]}
 */
export function resolveFields(header, fields, extra) {
	var fmt = POINT_FORMATS[header.pointFormat];
	var have = available(fmt);
	var named = (extra || []).map(function (f) { return f.column; });
	var want = [];
	(fields ? fields : DEFAULT_FIELDS.concat(fmt.fields.red ? ["red", "green", "blue"] : [])).forEach(function (name) {
		var list = name === "extra" ? named : [name];
		list.forEach(function (n) { if (want.indexOf(n) < 0) want.push(n); });
	});
	want.forEach(function (name) {
		if (!FIELD_TYPES[name] && named.indexOf(name) < 0) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "unknown field \"" + name + "\"" + (named.length ? " (this file's extra columns: " + named.join(", ") + ")" : ""));
	});
	return want.filter(function (name) { return have[name] || named.indexOf(name) >= 0; });
}

function extraOf(name, opts) {
	var list = opts && opts.extraBytes;
	if (!list) return null;
	for (var i = 0; i < list.length; i++) if (list[i].column === name) return list[i];
	return null;
}
function isSet(v) { return v !== null && v !== undefined; }
function scaledField(f) { return f.type !== "raw" && (isSet(f.scale) || isSet(f.offset)); }
var EXTRA_ARRAYS = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, i32: Int32Array, u64: BigUint64Array, i64: BigInt64Array, f32: Float32Array, f64: Float64Array };

// How to read one extra column: where, with which getter, and per value its scale, offset and no-data
function extraPlan(f) {
	var e = f.type === "raw" ? null : EXTRA_TYPES[f.type], scaled = scaledField(f), k = f.k;
	function per(v, fill) { var out = []; for (var j = 0; j < k; j++) { var x = Array.isArray(v) ? v[j] : v; out.push(isSet(x) ? x : fill); } return out; }
	return {
		column: f.column, at: f.at, k: k, raw: !e, get: e && e.get, size: e ? e.size : 1, scaled: scaled,
		mul: per(f.scale, 1), add: per(f.offset, 0),
		// no-data compared with the raw value, in its own kind (BigInt for 64-bit integers)
		nd: per(scaled ? f.noData : null, null).map(function (x) { return x === null ? null : e.big ? BigInt(x) : x; })
	};
}

/**
 * Decode a window of whole point records.
 * @param {Uint8Array} bytes - whole records, the first at bytes[0].
 * @param {object} header - from parseHeader.
 * @param {object} [opts] - { fields, keep, thin, localOrigin, float32, transform, into, firstIndex, extraBytes }
 *   extraBytes: the file's extra fields (reader.extraBytes), so fields may name their columns
 *   transform: { m, t } applied in Float64 to the world coordinates before localOrigin is subtracted
 *   into: { cols, at } decodes straight into existing columns from index at
 *   (each sized for every record that can be kept) and returns only { count }
 *   firstIndex: the file record number of bytes[0] (default 0); the index column holds
 *   firstIndex + the record's place in bytes
 * @returns {object} PointColumns: { count, <field>: TypedArray, ... }
 */
export function decodeRecords(bytes, header, opts) {
	opts = opts || {};
	var fmt = POINT_FORMATS[header.pointFormat];
	var fields = resolveFields(header, opts.fields, opts.extraBytes);
	var len = header.recordLength;
	var n = Math.floor(bytes.length / len);
	var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var thin = opts.thin && opts.thin.target < opts.thin.total ? opts.thin : null;
	var keep = typeof opts.keep === "function" ? opts.keep : null;
	var origin = opts.localOrigin || null;
	var ox = origin && isFinite(origin.x) ? origin.x : 0;
	var oy = origin && isFinite(origin.y) ? origin.y : 0;
	var oz = origin && isFinite(origin.z) ? origin.z : 0;
	var f32 = !!(opts.float32 && origin);
	var first = opts.firstIndex > 0 ? opts.firstIndex : 0;
	var T = opts.transform ? checkTransform(opts.transform, "transform") : null;
	var m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0, m5 = 0, m6 = 0, m7 = 0, m8 = 0, t0 = 0, t1 = 0, t2 = 0;
	if (T) { m0 = T.m[0]; m1 = T.m[1]; m2 = T.m[2]; m3 = T.m[3]; m4 = T.m[4]; m5 = T.m[5]; m6 = T.m[6]; m7 = T.m[7]; m8 = T.m[8]; t0 = T.t[0]; t1 = T.t[1]; t2 = T.t[2]; }

	var into = opts.into || null;
	var cols = into ? into.cols : {};
	if (!into) fields.forEach(function (name) { cols[name] = new (columnType(name, opts, header))(n * columnWidth(name, opts)); });
	var xs = fields.map(function (name) { var f = extraOf(name, opts); return f ? extraPlan(f) : null; }).filter(Boolean);
	var F = fmt.fields;
	var sx = header.scale.x, sy = header.scale.y, sz = header.scale.z;
	var tx = header.offset.x - ox, ty = header.offset.y - oy, tz = header.offset.z - oz;
	var ext = fmt.extended;
	var want = {};
	fields.forEach(function (name) { want[name] = true; });
	var wantPos = !!(T && (want.x || want.y || want.z));
	var wx = header.offset.x, wy = header.offset.y, wz = header.offset.z;

	var k = into ? into.at : 0;
	for (var i = 0; i < n; i++) {
		var at = i * len;
		if (keep && !keep(view, at)) continue;
		if (thin && !thinStep(thin)) continue;
		if (want.index) cols.index[k] = first + i;
		if (wantPos) {
			var px = view.getInt32(at, LE) * sx + wx;
			var py = view.getInt32(at + 4, LE) * sy + wy;
			var pz = view.getInt32(at + 8, LE) * sz + wz;
			if (want.x) cols.x[k] = m0 * px + m1 * py + m2 * pz + t0 - ox;
			if (want.y) cols.y[k] = m3 * px + m4 * py + m5 * pz + t1 - oy;
			if (want.z) cols.z[k] = m6 * px + m7 * py + m8 * pz + t2 - oz;
		} else {
			if (want.x) cols.x[k] = view.getInt32(at, LE) * sx + tx;
			if (want.y) cols.y[k] = view.getInt32(at + 4, LE) * sy + ty;
			if (want.z) cols.z[k] = view.getInt32(at + 8, LE) * sz + tz;
		}
		if (want.intensity) cols.intensity[k] = view.getUint16(at + 12, LE);
		var rb = view.getUint8(at + 14);
		if (ext) {
			var fb = view.getUint8(at + 15);
			if (want.returnNumber) cols.returnNumber[k] = rb & 15; // bits-ok
			if (want.numberOfReturns) cols.numberOfReturns[k] = (rb >> 4) & 15; // bits-ok
			if (want.classificationFlags) cols.classificationFlags[k] = fb & 15; // bits-ok
			if (want.scannerChannel) cols.scannerChannel[k] = (fb >> 4) & 3; // bits-ok
			if (want.scanDirection) cols.scanDirection[k] = (fb >> 6) & 1; // bits-ok
			if (want.edgeOfFlightLine) cols.edgeOfFlightLine[k] = (fb >> 7) & 1; // bits-ok
			if (want.classification) cols.classification[k] = view.getUint8(at + 16);
			if (want.scanAngle) cols.scanAngle[k] = view.getInt16(at + 18, LE) * 0.006;
		} else {
			var cb = view.getUint8(at + 15);
			if (want.returnNumber) cols.returnNumber[k] = rb & 7; // bits-ok
			if (want.numberOfReturns) cols.numberOfReturns[k] = (rb >> 3) & 7; // bits-ok
			if (want.scanDirection) cols.scanDirection[k] = (rb >> 6) & 1; // bits-ok
			if (want.edgeOfFlightLine) cols.edgeOfFlightLine[k] = (rb >> 7) & 1; // bits-ok
			if (want.classification) cols.classification[k] = cb & 31; // bits-ok
			if (want.classificationFlags) cols.classificationFlags[k] = (cb >> 5) & 7; // bits-ok
			if (want.scanAngle) cols.scanAngle[k] = view.getInt8(at + 16);
		}
		if (want.userData) cols.userData[k] = view.getUint8(at + 17);
		if (want.pointSourceId) cols.pointSourceId[k] = view.getUint16(at + F.pointSourceId.offset, LE);
		if (want.gpsTime) cols.gpsTime[k] = view.getFloat64(at + F.gpsTime.offset, LE);
		if (want.red) cols.red[k] = view.getUint16(at + F.red.offset, LE);
		if (want.green) cols.green[k] = view.getUint16(at + F.green.offset, LE);
		if (want.blue) cols.blue[k] = view.getUint16(at + F.blue.offset, LE);
		if (want.nir) cols.nir[k] = view.getUint16(at + F.nir.offset, LE);
		for (var x = 0; x < xs.length; x++) {
			var X = xs[x], col = cols[X.column], o = k * X.k, base = at + X.at;
			if (X.raw) { for (var j = 0; j < X.k; j++) col[o + j] = bytes[base + j]; continue; }
			for (j = 0; j < X.k; j++) {
				var r = view[X.get](base + j * X.size, LE);
				col[o + j] = !X.scaled ? r : r === X.nd[j] ? NaN : Number(r) * X.mul[j] + X.add[j];
			}
		}
		k++;
	}
	if (into) return { count: k - into.at };
	if (k < n) fields.forEach(function (name) { cols[name] = cols[name].slice(0, k * columnWidth(name, opts)); });
	cols.count = k;
	return cols;
}

/**
 * The typed-array type a field is decoded into (x / y / z are Float32
 * when float32 is asked for with a local origin).
 * @param {string} name
 * @param {{float32?:boolean, localOrigin?:object, extraBytes?:object[]}} [opts] - extraBytes: the file's extra fields
 * @param {{pointCount?:number}} [header] - index is Float64 when the file holds more than 4294967295 points
 * @returns {Function}
 */
export function columnType(name, opts, header) {
	var f = FIELD_TYPES[name] ? null : extraOf(name, opts);
	if (f) return f.type === "raw" ? Uint8Array : scaledField(f) ? Float64Array : EXTRA_ARRAYS[f.type];
	if (name === "index") return header && header.pointCount > 4294967295 ? Float64Array : Uint32Array;
	var f32 = !!(opts && opts.float32 && opts.localOrigin);
	return f32 && (name === "x" || name === "y" || name === "z") ? Float32Array : FIELD_TYPES[name];
}

/**
 * Values a point in a field's column: 1, or k for an extra-bytes field (2 or 3 for the array
 * types, the byte count for raw).
 * @param {string} name
 * @param {{extraBytes?: object[]}} [opts]
 * @returns {number}
 */
export function columnWidth(name, opts) {
	var f = FIELD_TYPES[name] ? null : extraOf(name, opts);
	return f ? f.k : 1;
}
