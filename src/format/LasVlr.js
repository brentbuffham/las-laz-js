// src/format/LasVlr.js
//==========================================================
// Variable length records (54-byte header, u16 data length) that
// follow the public header, and LAS 1.4 extended VLRs (60-byte
// header, u64 data length) after the point records. Each record's
// bytes are COPIED, so they outlive the window they were read from.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { readU64, readAscii } from "../io/ByteSource.js";

var LE = true;

/**
 * @param {object} src - sync source holding the records.
 * @param {number} start - offset of the first record in src.
 * @param {number} count
 * @param {number} [limit] - records must end at or before this offset (default: end of src).
 * @returns {Array<{userId:string, recordId:number, description:string, start:number, length:number, bytes:Uint8Array}>}
 */
export function parseVlrs(src, start, count, limit) {
	var end = typeof limit === "number" ? limit : src.length();
	var out = [];
	var pos = start;
	for (var i = 0; i < count; i++) {
		if (pos + 54 > end) throw new LasError(ERROR_CODES.BAD_VLR, "VLR " + (i + 1) + " of " + count + " starts past the end of the VLR area", pos);
		var len = src.getUint16(pos + 20, LE);
		if (pos + 54 + len > end) throw new LasError(ERROR_CODES.BAD_VLR, "VLR " + (i + 1) + " (" + len + " bytes) runs past the end of the VLR area", pos);
		out.push({
			userId: readAscii(src, pos + 2, 16),
			recordId: src.getUint16(pos + 18, LE),
			description: readAscii(src, pos + 22, 32),
			start: pos + 54,
			length: len,
			bytes: new Uint8Array(src.slice(pos + 54, pos + 54 + len))
		});
		pos += 54 + len;
	}
	return out;
}

/**
 * LAS 1.4 extended VLRs.
 * @param {object} src - sync source holding the records (offsets in src).
 * @param {number} start
 * @param {number} count
 * @param {boolean} [headersOnly] - src holds only the headers: no bytes (null), no length check
 * @returns {Array<{userId:string, recordId:number, description:string, start:number, length:number, bytes:Uint8Array|null}>}
 */
export function parseEvlrs(src, start, count, headersOnly) {
	var out = [];
	var pos = start;
	for (var i = 0; i < count; i++) {
		if (pos + 60 > src.length()) throw new LasError(ERROR_CODES.BAD_VLR, "EVLR " + (i + 1) + " starts past the end of the file", pos);
		var len = readU64(src, pos + 20, LE);
		if (len === null || (!headersOnly && pos + 60 + len > src.length())) throw new LasError(ERROR_CODES.BAD_VLR, "EVLR " + (i + 1) + " runs past the end of the file", pos);
		out.push({
			userId: readAscii(src, pos + 2, 16),
			recordId: src.getUint16(pos + 18, LE),
			description: readAscii(src, pos + 28, 32),
			start: pos + 60,
			length: len,
			bytes: headersOnly ? null : new Uint8Array(src.slice(pos + 60, pos + 60 + len))
		});
		pos += 60 + len;
	}
	return out;
}
