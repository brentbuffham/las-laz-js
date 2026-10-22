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
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { POINT_FORMATS } from "../format/PointFormats.js";
import { thinStep } from "../ops/select.js";

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
 * @param {string[]} [fields]
 * @returns {string[]}
 */
export function resolveFields(header, fields) {
	var fmt = POINT_FORMATS[header.pointFormat];
	var have = available(fmt);
	var want = fields ? fields.slice() : DEFAULT_FIELDS.concat(fmt.fields.red ? ["red", "green", "blue"] : []);
	want.forEach(function (name) {
		if (!FIELD_TYPES[name]) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "unknown field \"" + name + "\"");
	});
	return want.filter(function (name) { return have[name]; });
}

/**
 * Decode a window of whole point records.
 * @param {Uint8Array} bytes - whole records, the first at bytes[0].
 * @param {object} header - from parseHeader.
 * @param {object} [opts] - { fields, keep, thin, localOrigin, float32, into, firstIndex }
 *   into: { cols, at } decodes straight into existing columns from index at
 *   (each sized for every record that can be kept) and returns only { count }
 *   firstIndex: the file record number of bytes[0] (default 0); the index column holds
 *   firstIndex + the record's place in bytes
 * @returns {object} PointColumns: { count, <field>: TypedArray, ... }
 */
export function decodeRecords(bytes, header, opts) {
	opts = opts || {};
	var fmt = POINT_FORMATS[header.pointFormat];
	var fields = resolveFields(header, opts.fields);
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

	var into = opts.into || null;
	var cols = into ? into.cols : {};
	if (!into) fields.forEach(function (name) { cols[name] = new (columnType(name, opts, header))(n); });
	var F = fmt.fields;
	var sx = header.scale.x, sy = header.scale.y, sz = header.scale.z;
	var tx = header.offset.x - ox, ty = header.offset.y - oy, tz = header.offset.z - oz;
	var ext = fmt.extended;
	var want = {};
	fields.forEach(function (name) { want[name] = true; });

	var k = into ? into.at : 0;
	for (var i = 0; i < n; i++) {
		var at = i * len;
		if (keep && !keep(view, at)) continue;
		if (thin && !thinStep(thin)) continue;
		if (want.index) cols.index[k] = first + i;
		if (want.x) cols.x[k] = view.getInt32(at, LE) * sx + tx;
		if (want.y) cols.y[k] = view.getInt32(at + 4, LE) * sy + ty;
		if (want.z) cols.z[k] = view.getInt32(at + 8, LE) * sz + tz;
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
		k++;
	}
	if (into) return { count: k - into.at };
	if (k < n) fields.forEach(function (name) { cols[name] = cols[name].slice(0, k); });
	cols.count = k;
	return cols;
}

/**
 * The typed-array type a field is decoded into (x / y / z are Float32
 * when float32 is asked for with a local origin).
 * @param {string} name
 * @param {{float32?:boolean, localOrigin?:object}} [opts]
 * @param {{pointCount?:number}} [header] - index is Float64 when the file holds more than 4294967295 points
 * @returns {Function}
 */
export function columnType(name, opts, header) {
	if (name === "index") return header && header.pointCount > 4294967295 ? Float64Array : Uint32Array;
	var f32 = !!(opts && opts.float32 && opts.localOrigin);
	return f32 && (name === "x" || name === "y" || name === "z") ? Float32Array : FIELD_TYPES[name];
}
