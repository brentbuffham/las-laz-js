// src/tiles/tileFile.js
//==========================================================
// One octree node's file: a 32-byte header, the node's LAS records
// (raw, or one LAZ chunk), then each added column as a little-endian
// typed array, 8-byte aligned, in manifest order.
//   @0  magic "LLZT"        @4  layout version u16   @6  flags u16 (bit 0: compressed)
//   @8  point count u32     @12 records byte length u32
//   @16 added-column count u16; zero to @32
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { LAYOUT_VERSION } from "./manifest.js";

var HEADER = 32;
var MAGIC = "LLZT";

/** Added-column types, by the Extra Bytes names. */
export var COLUMN_TYPES = Object.freeze({
	u8: Uint8Array, i8: Int8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, i32: Int32Array,
	u64: BigUint64Array, i64: BigInt64Array, f32: Float32Array, f64: Float64Array
});

function up8(n) { return Math.ceil(n / 8) * 8; }

/**
 * Encode a node.
 * @param {{count: number, records: Uint8Array, compressed: boolean, columns: TypedArray[]}} t
 * @returns {Uint8Array}
 */
export function encodeTile(t) {
	var columns = t.columns || [];
	var total = up8(HEADER + t.records.length);
	columns.forEach(function (c) { total = up8(total + c.byteLength); });
	var out = new Uint8Array(total), v = new DataView(out.buffer);
	for (var i = 0; i < 4; i++) out[i] = MAGIC.charCodeAt(i);
	v.setUint16(4, LAYOUT_VERSION, true);
	v.setUint16(6, t.compressed ? 1 : 0, true);
	v.setUint32(8, t.count, true);
	v.setUint32(12, t.records.length, true);
	v.setUint16(16, columns.length, true);
	out.set(t.records, HEADER);
	var at = up8(HEADER + t.records.length);
	columns.forEach(function (c) {
		out.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), at);
		at = up8(at + c.byteLength);
	});
	return out;
}

/**
 * Decode a node. The records are a view on bytes; the columns are copies.
 * @param {Uint8Array} bytes
 * @param {string[]} columnTypes - the manifest's added-column types, in order
 * @param {string} name - the node file, named in errors
 * @returns {{count: number, records: Uint8Array, compressed: boolean, columns: TypedArray[]}}
 * @throws {LasError} BAD_STORE when the bytes are not a node of this layout
 */
export function decodeTile(bytes, columnTypes, name) {
	function bad(why) { return new LasError(ERROR_CODES.BAD_STORE, "tile file " + name + " is damaged: " + why); }
	if (!bytes || bytes.length < HEADER) throw bad("shorter than its header");
	var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (var i = 0; i < 4; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) throw bad("not a tile file");
	var version = v.getUint16(4, true);
	if (version !== LAYOUT_VERSION) throw bad("layout version " + version + ", not " + LAYOUT_VERSION);
	var count = v.getUint32(8, true), recBytes = v.getUint32(12, true), ncols = v.getUint16(16, true);
	if (ncols !== columnTypes.length) throw bad(ncols + " added columns, the manifest has " + columnTypes.length);
	if (HEADER + recBytes > bytes.length) throw bad("its records run past the file");
	var at = up8(HEADER + recBytes), columns = [];
	for (var c = 0; c < ncols; c++) {
		var T = COLUMN_TYPES[columnTypes[c]];
		var n = count * T.BYTES_PER_ELEMENT;
		if (at + n > bytes.length) throw bad("column " + c + " runs past the file");
		columns.push(new T(bytes.slice(at, at + n).buffer));
		at = up8(at + n);
	}
	return { count: count, records: bytes.subarray(HEADER, HEADER + recBytes), compressed: (v.getUint16(6, true) & 1) === 1, columns: columns }; // bits-ok
}
