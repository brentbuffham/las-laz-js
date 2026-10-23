// test/helpers/extraBytes.js
//==========================================================
// Extra Bytes test files, written with this helper's own DataView
// code (LAS 1.4 R15 "Extra Bytes": data_type @2, options @3, name @4,
// no_data @40, min @64, max @88, scale @112, offset @136, description
// @160; array elements j > 0 eight bytes on), so the library is
// checked against bytes it did not write.
//==========================================================
/* prettier-ignore-file */
import { buildLas } from "./buildLas.js";

// codes 1-10: [size, kind] — kind u (unsigned, upcast u64), s (signed, i64), f (double)
var BASE = [null, [1, "u"], [1, "s"], [2, "u"], [2, "s"], [4, "u"], [4, "s"], [8, "u"], [8, "s"], [4, "f"], [8, "f"]];

/** The base type (1-10) and value count of a code 1-30. */
export function baseOf(code) { return code <= 10 ? { base: code, k: 1 } : code <= 20 ? { base: code - 10, k: 2 } : { base: code - 20, k: 3 }; }

function put(v, at, kind, value) {
	if (kind === "f") v.setFloat64(at, value, true);
	else if (kind === "u") v.setBigUint64(at, BigInt(value), true);
	else v.setBigInt64(at, BigInt(value), true);
}

function text(d, at, s) { for (var i = 0; i < s.length; i++) d[at + i] = s.charCodeAt(i); }

/**
 * One 192-byte descriptor. Values set their options bit; arrays of k for codes 11-30.
 * @param {{code: number, name?: string, size?: number, noData?: *, min?: *, max?: *, scale?: *, offset?: *, description?: string, options?: number}} o
 */
export function descriptorBytes(o) {
	var d = new Uint8Array(192), v = new DataView(d.buffer), opt = 0;
	d[2] = o.code;
	text(d, 4, o.name || "");
	text(d, 160, o.description || "");
	if (o.code === 0) opt = o.size;
	else if (o.code <= 30) {
		var b = baseOf(o.code), kind = BASE[b.base][1];
		[["noData", 40, 1, kind], ["min", 64, 2, kind], ["max", 88, 4, kind], ["scale", 112, 8, "f"], ["offset", 136, 16, "f"]].forEach(function (f) {
			var val = o[f[0]];
			if (val === undefined || val === null) return;
			opt += f[2];
			var vals = Array.isArray(val) ? val : [val];
			vals.forEach(function (x, j) { put(v, f[1] + 8 * j, f[3], x); });
		});
	}
	d[3] = o.options !== undefined ? o.options : opt;
	return d;
}

/** Bytes a code takes in a record. */
export function sizeOf(code, size) { if (code === 0) return size; var b = baseOf(code); return BASE[b.base][0] * b.k; }

/**
 * A LAS file whose records carry extra bytes.
 * @param {{version?: string, pointFormat?: number, points: object[], descriptors?: Uint8Array[], extraSize: number,
 *   vlr?: boolean, vlrs?: object[], fill?: function(number, DataView, number, number)}} o - fill(i, view, recordStart,
 *   formatSize) writes point i's extra bytes; vlr: false leaves the Extra Bytes VLR out
 */
export function lasWithExtra(o) {
	var vlrs = (o.vlrs || []).slice();
	if (o.vlr !== false && o.descriptors && o.descriptors.length) {
		var all = new Uint8Array(192 * o.descriptors.length);
		o.descriptors.forEach(function (d, i) { all.set(d, 192 * i); });
		vlrs.push({ userId: "LASF_Spec", recordId: 4, description: "Extra Bytes", bytes: all });
	}
	var bytes = buildLas({ version: o.version || "1.4", pointFormat: o.pointFormat || 0, points: o.points, vlrs: vlrs, extraBytes: o.extraSize, scale: o.scale, offset: o.offset });
	if (o.fill) {
		var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		var start = v.getUint32(96, true), len = v.getUint16(105, true);
		for (var i = 0; i < o.points.length; i++) o.fill(i, v, start + i * len, len - o.extraSize);
	}
	return bytes;
}
