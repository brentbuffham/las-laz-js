// src/format/ClassLookup.js
//==========================================================
// The Classification Lookup VLR (LAS 1.4 R15: user ID "LASF_Spec",
// record ID 0): entries of 16 bytes, { uint8 ClassNumber; char
// Description[15] }, ASCII, NUL-padded. It names classes, the user's
// own (64-255) above all, so other LAS tools show them. Read into
// { [code]: name } (only entries with a non-empty name); written from
// the same shape, one entry per code, ascending.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

export var CLASS_LOOKUP_USER_ID = "LASF_Spec";
export var CLASS_LOOKUP_RECORD_ID = 0;
var ENTRY = 16, NAME = 15;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/**
 * The class names in the first Classification Lookup VLR among vlrs.
 * @param {Array<{userId: string, recordId: number, bytes: Uint8Array}>} vlrs
 * @returns {Object<number, string>} code -> name; {} when there is no such VLR.
 * @throws {LasError} BAD_VLR when its length is not a multiple of 16.
 */
export function parseClassLookup(vlrs) {
	var out = {};
	var r = vlrs.find(function (v) { return v.userId === CLASS_LOOKUP_USER_ID && v.recordId === CLASS_LOOKUP_RECORD_ID; });
	if (!r || !r.bytes) return out;
	var b = r.bytes;
	if (b.length % ENTRY !== 0) throw new LasError(ERROR_CODES.BAD_VLR, "the classification lookup VLR is " + b.length + " bytes, not a multiple of 16");
	for (var p = 0; p < b.length; p += ENTRY) {
		var name = "";
		for (var i = 1; i <= NAME && b[p + i] !== 0; i++) name += String.fromCharCode(b[p + i]);
		if (name && !(b[p] in out)) out[b[p]] = name;
	}
	return out;
}

/**
 * Check a classNames map and build the lookup VLR's bytes (internal; not exported from the
 * package entry).
 * @param {Object<number, string>} classNames - code (0-255) -> name (1-15 printable ASCII characters).
 * @returns {Uint8Array}
 * @throws {LasError} INVALID_ARGUMENT naming the bad code or name.
 */
export function buildClassLookup(classNames) {
	if (classNames === null || typeof classNames !== "object" || Array.isArray(classNames)) throw bad("classNames must be an object of class code -> name");
	var codes = Object.keys(classNames).map(function (key) {
		var code = Number(key);
		if (!Number.isInteger(code) || code < 0 || code > 255) throw bad("classNames: " + key + " is not a class code 0-255");
		var name = classNames[key];
		if (typeof name !== "string" || name.length < 1 || name.length > NAME) throw bad("classNames[" + code + "] must be a name of 1 to 15 characters");
		for (var i = 0; i < name.length; i++) {
			var ch = name.charCodeAt(i);
			if (ch < 0x20 || ch > 0x7E) throw bad("classNames[" + code + "] = \"" + name + "\" is not printable ASCII");
		}
		return code;
	}).sort(function (a, b) { return a - b; });
	var out = new Uint8Array(codes.length * ENTRY);
	codes.forEach(function (code, j) {
		var name = classNames[code], p = j * ENTRY;
		out[p] = code;
		for (var i = 0; i < name.length; i++) out[p + 1 + i] = name.charCodeAt(i);
	});
	return out;
}
