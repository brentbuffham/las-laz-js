// src/format/ExtraBytes.js
//==========================================================
// The Extra Bytes VLR (LAS 1.4 R15, LASF_Spec record 4): one 192-byte
// descriptor per field of the bytes a record carries past its point
// format. data_type @2 (1-10 u8 ... f64; 11-30 the deprecated 2- and
// 3-value arrays; 0 undocumented, its byte count in options), options
// @3 (bits 0-4: no_data, min, max, scale, offset set), name @4,
// no_data @40, min @64, max @88 (raw values, 8 bytes: u64 for
// unsigned, i64 for signed, double for floats; array element j eight
// bytes on, the R13 layout), scale @112, offset @136, description @160.
//
// parseExtraBytes reads a file's fields; bytes past the descriptors
// (or every extra byte, with no VLR) are one undocumented "raw" field,
// and a VLR that cannot be right (it describes more bytes than the
// records have, a reserved type, a length that is not whole
// descriptors, two of them) becomes one raw field over all the extra
// bytes with the problem named, so a read never stops on it.
// layoutExtraBytes checks a writer's descriptors and places them;
// buildExtraBytes writes the VLR payload with the raw min / max seen.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { POINT_FORMATS } from "./PointFormats.js";
import { FIELD_TYPES } from "../read/decodeRecords.js";

var LE = true;

/** The Extra Bytes VLR's user id and record id. */
export var EXTRA_BYTES_USER_ID = "LASF_Spec";
export var EXTRA_BYTES_RECORD_ID = 4;

function t(name, code, size, get, set, kind, min, max) {
	return { name: name, code: code, size: size, get: get, set: set, kind: kind, min: min, max: max, int: kind !== "f", big: size === 8 && kind !== "f" };
}
var F32_MAX = 3.4028234663852886e38;
var BY_CODE = [null,
	t("u8", 1, 1, "getUint8", "setUint8", "u", 0, 255), t("i8", 2, 1, "getInt8", "setInt8", "s", -128, 127),
	t("u16", 3, 2, "getUint16", "setUint16", "u", 0, 65535), t("i16", 4, 2, "getInt16", "setInt16", "s", -32768, 32767),
	t("u32", 5, 4, "getUint32", "setUint32", "u", 0, 4294967295), t("i32", 6, 4, "getInt32", "setInt32", "s", -2147483648, 2147483647),
	t("u64", 7, 8, "getBigUint64", "setBigUint64", "u", 0n, 18446744073709551615n), t("i64", 8, 8, "getBigInt64", "setBigInt64", "s", -9223372036854775808n, 9223372036854775807n),
	t("f32", 9, 4, "getFloat32", "setFloat32", "f", -F32_MAX, F32_MAX), t("f64", 10, 8, "getFloat64", "setFloat64", "f", -Number.MAX_VALUE, Number.MAX_VALUE)];

/** Types 1-10 by name: { name, code, size, get, set (DataView methods), kind "u" | "s" | "f", min, max, int, big }. */
export var EXTRA_TYPES = Object.freeze(BY_CODE.slice(1).reduce(function (o, e) { o[e.name] = Object.freeze(e); return o; }, {}));

// Column names an extra field never reads into: the standard fields and these. A writer's column may be
// "extraBytes" (the reader's undocumented bytes go back under it). Built on first use: decodeRecords.js
// imports this module, so FIELD_TYPES is not there yet while it loads.
var MORE_RESERVED = ["count", "positions", "bounds", "stats", "colours", "normal", "extra", "extraBytes"];
function reserved(name, writing) {
	if (writing && name === "extraBytes") return false;
	return MORE_RESERVED.indexOf(name) >= 0 || Object.prototype.hasOwnProperty.call(FIELD_TYPES, name);
}

function text(bytes, at, max) {
	var s = "";
	for (var i = 0; i < max && bytes[at + i]; i++) s += String.fromCharCode(bytes[at + i]);
	return s;
}

// an upcast u64 / i64 as a Number when it is exact, else a BigInt
function exact(b) { return b >= -9007199254740991n && b <= 9007199254740991n ? Number(b) : b; }

function rawField(name, at, size) {
	return { name: name, column: "", type: "raw", code: 0, k: size, size: size, at: at, scale: null, offset: null, noData: null, min: null, max: null, description: "" };
}

// give each field a column: a reserved name gains "_extra", an empty raw one is "extraBytes", repeats "_2", "_3", …
function columns(fields) {
	var used = {};
	fields.forEach(function (f) {
		var base = f.name === "" ? "extraBytes" : reserved(f.name, false) ? f.name + "_extra" : f.name;
		var c = base;
		for (var n = 2; used[c]; n++) c = base + "_" + n;
		used[c] = true;
		f.column = c;
	});
	return fields;
}

/**
 * The extra-bytes fields of a file.
 * @param {Array<{userId: string, recordId: number, bytes: Uint8Array|null}>} vlrs - VLRs then EVLRs.
 * @param {{pointFormat: number, recordLength: number}} header
 * @returns {{fields: Array<{name: string, column: string, type: string, code: number, k: number, size: number,
 *   at: number, scale: *, offset: *, noData: *, min: *, max: *, description: string}>, problem: string|null}}
 *   type "u8" … "f64" or "raw"; k values a point (2 or 3 for the array types; the byte count for raw);
 *   at the field's first byte in the record; scale … max a number (a BigInt past 2^53, an array of k for
 *   the array types) or null when not set; noData, min, max raw. problem: why the VLR was not used, or null
 */
export function parseExtraBytes(vlrs, header) {
	var base = POINT_FORMATS[header.pointFormat].size, extra = header.recordLength - base;
	var found = vlrs.filter(function (r) { return r.userId === EXTRA_BYTES_USER_ID && r.recordId === EXTRA_BYTES_RECORD_ID; });
	function fallback(problem) { return { fields: extra > 0 ? columns([rawField("", base, extra)]) : [], problem: problem }; }
	if (!found.length) return fallback(null);
	if (found.length > 1) return fallback("the file has two Extra Bytes VLRs (one is allowed), so neither is used");
	var b = found[0].bytes;
	if (!b) return fallback("the Extra Bytes VLR was not read");
	if (b.length % 192) return fallback("the Extra Bytes VLR is " + b.length + " bytes, not a whole number of 192-byte descriptors");
	var v = new DataView(b.buffer, b.byteOffset, b.byteLength), fields = [], at = base;
	for (var d = 0; d < b.length; d += 192) {
		var code = b[d + 2], opt = b[d + 3], name = text(b, d + 4, 32);
		if (code === 0) {
			if (!opt) return fallback("Extra Bytes descriptor " + (d / 192 + 1) + " is undocumented bytes of size 0");
			fields.push(rawField(name, at, opt));
			fields[fields.length - 1].description = text(b, d + 160, 32);
			at += opt;
			continue;
		}
		if (code > 30) return fallback("Extra Bytes descriptor " + (d / 192 + 1) + " has type " + code + ", which is reserved (1-30 are defined)");
		var k = code <= 10 ? 1 : code <= 20 ? 2 : 3, e = BY_CODE[code - (k - 1) * 10];
		var read = function (off, bit, kind) {
			if (!(opt & bit)) return null; // bits-ok
			var out = [];
			for (var j = 0; j < k; j++) {
				var p = d + off + 8 * j;
				out.push(kind === "f" ? v.getFloat64(p, LE) : exact(kind === "u" ? v.getBigUint64(p, LE) : v.getBigInt64(p, LE)));
			}
			return k === 1 ? out[0] : out;
		};
		fields.push({
			name: name, column: "", type: e.name, code: code, k: k, size: e.size * k, at: at,
			scale: noZero(read(112, 8, "f")), offset: read(136, 16, "f"),
			noData: possible(e, read(40, 1, e.kind)), min: read(64, 2, e.kind), max: read(88, 4, e.kind),
			description: text(b, d + 160, 32)
		});
		at += e.size * k;
	}
	var described = at - base;
	if (described > extra) return fallback("the Extra Bytes VLR describes " + described + " bytes but records have " + Math.max(0, extra));
	if (described < extra) fields.push(rawField("", at, extra - described));
	return { fields: columns(fields), problem: null };
}

// a scale of 0 would make every value the offset: a writer's slip, read as no scale
function noZero(v) {
	if (Array.isArray(v)) return v.map(function (x) { return x === 0 ? null : x; });
	return v === 0 ? null : v;
}

// a no-data value no raw value of the type can equal (u8 300) means nothing: none
function possible(e, v) {
	if (v === null || !e.int) return v;
	if (Array.isArray(v)) return v.map(function (x) { return fitsInt(e, x) ? x : null; });
	return fitsInt(e, v) ? v : null;
}

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
// names and descriptions are char[32]: one byte a character (a file's own may use Latin-1 bytes)
function bytewise(s) { return !/[^\x01-\xff]/.test(s); }
function set(v) { return v !== undefined && v !== null; }

// a value fits an integer type: a whole Number (exact) or a BigInt, within range
function fitsInt(e, x) {
	if (typeof x === "bigint") return x >= BigInt(e.min) && x <= BigInt(e.max);
	return typeof x === "number" && Number.isInteger(x) && Number.isSafeInteger(x) && x >= Number(e.min) && x <= Number(e.max);
}

/**
 * Check a writer's extra-bytes descriptors and place them after the point format.
 * @param {object[]} descriptors - { name, type ("u8" … "f64", 1-10, "raw" / 0), column?, size? (raw),
 *   scale?, offset?, noData? (raw), description? }; a reader's fields are taken as they are (at, min, max ignored)
 * @param {number} formatSize - the point format's record size
 * @returns {{fields: Array<{name: string, column: string, code: number, size: number, at: number, elem: object|null,
 *   scaled: boolean, scale: number|null, offset: number|null, noData: *, description: string}>, recordLength: number}}
 *   elem: the EXTRA_TYPES entry (null for raw)
 * @throws {LasError} INVALID_ARGUMENT naming the field
 */
export function layoutExtraBytes(descriptors, formatSize) {
	if (!Array.isArray(descriptors)) throw bad("extraBytes must be an array of field descriptors ({ name, type, … })");
	var fields = [], at = formatSize, cols = {};
	descriptors.forEach(function (d) {
		if (!d || typeof d !== "object") throw bad("extraBytes: each field is an object { name, type, … }");
		var name = d.name, label = "extra bytes field \"" + name + "\"";
		var raw = d.type === "raw" || d.type === 0;
		var e = raw ? null : typeof d.type === "number" ? BY_CODE[d.type] : EXTRA_TYPES[d.type];
		if (!raw && (!e || (typeof d.type === "number" && !Number.isInteger(d.type)))) throw bad(label + ": type " + JSON.stringify(d.type) + " is not one of u8 i8 u16 i16 u32 i32 u64 i64 f32 f64 (1-10) or raw (0)");
		if (typeof name !== "string") throw bad("extra bytes field: a name is needed (a string of up to 32 characters)");
		if (name.length > 32) throw bad(label + ": the name is over 32 characters");
		if (!bytewise(name)) throw bad(label + ": the name must be one byte a character (ASCII, or Latin-1)");
		if (!raw && set(d.k) && d.k !== 1) throw bad(label + ": " + d.type + " × " + d.k + " is a " + d.k + "-value array type: read, not written; write " + d.k + " scalar fields");
		var desc = set(d.description) ? d.description : "";
		if (typeof desc !== "string" || desc.length > 32 || !bytewise(desc)) throw bad(label + ": the description must be up to 32 characters, one byte each");
		var size;
		if (raw) {
			size = d.size;
			if (!Number.isInteger(size) || size < 1 || size > 65535) throw bad(label + ": a raw field needs size, a whole number of bytes from 1 to 65535 (got " + size + ")");
		} else {
			size = e.size;
			if (set(d.size) && d.size !== e.size) throw bad(label + ": size " + d.size + " is not " + e.name + "'s " + e.size + " bytes (size is for raw fields)");
		}
		var column = set(d.column) ? d.column : name === "" ? "extraBytes" : name;
		if (typeof column !== "string" || column === "") throw bad(label + ": column must be a non-empty string");
		// a file may repeat a name (the reader then reads it into name_2): the columns must differ
		if (cols[column]) throw bad(label + ": column \"" + column + "\" is used twice");
		if (reserved(column, true)) throw bad(label + ": column \"" + column + "\" is a standard field; name another, e.g. column: \"" + column + "_extra\"");
		cols[column] = true;
		var scale = null, offset = null, noData = null;
		if (!raw) {
			if (set(d.scale)) { if (typeof d.scale !== "number" || !isFinite(d.scale) || d.scale === 0) throw bad(label + ": scale must be a finite number other than 0, not " + d.scale); scale = d.scale; }
			if (set(d.offset)) { if (typeof d.offset !== "number" || !isFinite(d.offset)) throw bad(label + ": offset must be a finite number, not " + d.offset); offset = d.offset; }
			if (set(d.noData)) {
				var nd = d.noData;
				var ok = e.int ? fitsInt(e, nd) : typeof nd === "number" && (nd !== nd || (isFinite(nd) && Math.abs(nd) <= e.max));
				if (!ok) throw bad(label + ": noData " + nd + " is not a raw " + e.name + " value");
				// as the record holds it: a Number below 64 bits, f32 rounded as f32 stores it
				noData = e.int && !e.big ? Number(nd) : e.name === "f32" ? Math.fround(nd) : nd;
			}
		}
		fields.push({ name: name, column: column, code: raw ? 0 : e.code, size: size, at: at, elem: e, scaled: set(scale) || set(offset), scale: scale, offset: offset, noData: noData, description: desc });
		at += size;
	});
	if (at > 65535) throw bad("extra bytes: the record would be " + at + " bytes; a LAS record holds at most 65,535");
	return { fields: fields, recordLength: at };
}

function putText(bytes, at, s) { for (var i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); }
function put(v, at, kind, x) {
	if (kind === "f") v.setFloat64(at, Number(x), LE);
	else if (kind === "u") v.setBigUint64(at, BigInt(x), LE);
	else v.setBigInt64(at, BigInt(x), LE);
}

/**
 * The Extra Bytes VLR payload for a layout: 192 bytes a descriptor (a raw field over 255 bytes as
 * several undocumented ones of up to 255, the first under its name).
 * @param {{fields: object[]}} layout - from layoutExtraBytes
 * @param {Array<{min: *, max: *}|null>} ranges - per field, the raw min / max written (null: none)
 * @returns {Uint8Array}
 */
export function buildExtraBytes(layout, ranges) {
	var list = [];
	layout.fields.forEach(function (f, i) {
		if (f.code === 0) {
			for (var left = f.size, first = true; left > 0; left -= 255, first = false) list.push({ raw: Math.min(255, left), name: first ? f.name : "", description: first ? f.description : "" });
		} else list.push({ f: f, range: ranges && ranges[i] });
	});
	var out = new Uint8Array(192 * list.length), v = new DataView(out.buffer);
	list.forEach(function (d, i) {
		var p = 192 * i;
		if (d.raw) {
			out[p + 2] = 0; out[p + 3] = d.raw;
			putText(out, p + 4, d.name); putText(out, p + 160, d.description);
			return;
		}
		var f = d.f, kind = f.elem.kind, opt = 0;
		out[p + 2] = f.code;
		putText(out, p + 4, f.name); putText(out, p + 160, f.description);
		if (set(f.noData)) { opt += 1; put(v, p + 40, kind, f.noData); }
		if (d.range) { opt += 6; put(v, p + 64, kind, d.range.min); put(v, p + 88, kind, d.range.max); }
		if (set(f.scale)) { opt += 8; v.setFloat64(p + 112, f.scale, LE); }
		if (set(f.offset)) { opt += 16; v.setFloat64(p + 136, f.offset, LE); }
		out[p + 3] = opt;
	});
	return out;
}
