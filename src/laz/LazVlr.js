// src/laz/LazVlr.js
//==========================================================
// The LASzip VLR ("laszip encoded", record 22204): how the points are
// compressed — the compressor (point-wise, point-wise chunked, layered
// chunked), the chunk size (0 / 0xFFFFFFFF = variable, the table then
// carries each chunk's point count) and the items that make up one
// record (Point10, GpsTime, RGB12, Byte … or the 1.4 Point14 family),
// each with its size and coder version.
//
// Layout from laz-rs src/laszip/vlr.rs (https://github.com/laz-rs/laz-rs),
// itself from LASzip by rapidlasso. (c) 2007-2015 martin isenburg,
// rapidlasso; (c) 2019-2023 Thomas Montaigu. Licensed under the Apache
// License, Version 2.0 (see LICENSE-APACHE and NOTICE). Changes: written
// in JavaScript from that layout, Brent Buffham 2026.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

/** LASzip compressor kinds. */
export var COMPRESSOR = Object.freeze({ NONE: 0, POINTWISE: 1, POINTWISE_CHUNKED: 2, LAYERED_CHUNKED: 3 });

/** LASzip item types. */
export var ITEM = Object.freeze({ BYTE: 0, POINT10: 6, GPSTIME11: 7, RGB12: 8, WAVEPACKET13: 9, POINT14: 10, RGB14: 11, RGBNIR14: 12, WAVEPACKET14: 13, BYTE14: 14 });

/** User id and record id of the LASzip VLR. */
export var LASZIP_USER_ID = "laszip encoded";
export var LASZIP_RECORD_ID = 22204;

var VARIABLE = 0xFFFFFFFF;

/**
 * @param {Uint8Array} bytes - the VLR's payload
 * @returns {{compressor:number, coder:number, version:{major:number, minor:number, revision:number},
 *   options:number, chunkSize:number, variableChunks:boolean, items:Array<{type:number, size:number, version:number}>}}
 */
export function parseLazVlr(bytes) {
	if (!bytes || bytes.length < 34) throw new LasError(ERROR_CODES.BAD_VLR, "the LASzip VLR is " + (bytes ? bytes.length : 0) + " bytes (needs 34 or more)");
	var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var n = v.getUint16(32, true);
	if (bytes.length < 34 + n * 6) throw new LasError(ERROR_CODES.BAD_VLR, "the LASzip VLR lists " + n + " items but holds only " + bytes.length + " bytes");
	var chunk = v.getUint32(12, true);
	var items = [];
	for (var i = 0; i < n; i++) items.push({ type: v.getUint16(34 + i * 6, true), size: v.getUint16(36 + i * 6, true), version: v.getUint16(38 + i * 6, true) });
	return {
		compressor: v.getUint16(0, true),
		coder: v.getUint16(2, true),
		version: { major: v.getUint8(4), minor: v.getUint8(5), revision: v.getUint16(6, true) },
		options: v.getUint32(8, true),
		chunkSize: chunk === 0 ? VARIABLE : chunk,
		variableChunks: chunk === 0 || chunk === VARIABLE,
		items: items
	};
}

/**
 * The LASzip VLR among a file's VLRs, or null.
 * @param {Array<{userId:string, recordId:number, bytes:Uint8Array}>} vlrs
 */
export function findLazVlr(vlrs) {
	for (var i = 0; i < vlrs.length; i++) {
		if (vlrs[i].recordId === LASZIP_RECORD_ID && vlrs[i].userId === LASZIP_USER_ID) return parseLazVlr(vlrs[i].bytes);
	}
	return null;
}
