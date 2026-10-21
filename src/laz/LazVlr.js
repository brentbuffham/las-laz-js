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
// rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: written
// in JavaScript from that layout; lazVlrFor (the writing half) added,
// Brent Buffham 2026.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { POINT_FORMATS } from "../format/PointFormats.js";

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

// The items of each writable point format as [type, size, version]; the
// extra-bytes item (Byte / Byte14) follows when the record is longer
var FORMAT_ITEMS = {
	0: [[ITEM.POINT10, 20, 2]],
	1: [[ITEM.POINT10, 20, 2], [ITEM.GPSTIME11, 8, 2]],
	2: [[ITEM.POINT10, 20, 2], [ITEM.RGB12, 6, 2]],
	3: [[ITEM.POINT10, 20, 2], [ITEM.GPSTIME11, 8, 2], [ITEM.RGB12, 6, 2]],
	6: [[ITEM.POINT14, 30, 3]],
	7: [[ITEM.POINT14, 30, 3], [ITEM.RGB14, 6, 3]],
	8: [[ITEM.POINT14, 30, 3], [ITEM.RGBNIR14, 8, 3]]
};

/**
 * The LASzip VLR a writer puts in a file: compressor 2 (formats 0-3) or 3 (6-8),
 * LASzip 3.4 r3, chunked.
 * @param {number} pointFormat - 0-3 or 6-8 (4, 5, 9, 10 carry waveform or 1.3 items that are not written)
 * @param {number} recordLength - the file's point record length
 * @param {number} chunkSize - points per chunk
 * @returns {{vlr: object, bytes: Uint8Array}} vlr has the parseLazVlr shape; bytes is its 34 + 6 * items payload
 */
export function lazVlrFor(pointFormat, recordLength, chunkSize) {
	var layered = pointFormat >= 6;
	if (!FORMAT_ITEMS[pointFormat]) {
		throw new LasError(ERROR_CODES.UNSUPPORTED, "LAZ compression of point format " + pointFormat + " is not written (formats 0-3 and 6-8 only)");
	}
	var extra = recordLength - POINT_FORMATS[pointFormat].size;
	if (!(extra >= 0 && extra <= 0xFFFF)) {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "record length " + recordLength + " does not fit point format " + pointFormat + " (" + POINT_FORMATS[pointFormat].size + " bytes)");
	}
	var items = FORMAT_ITEMS[pointFormat].map(function (it) {
		return { type: it[0], size: it[1], version: it[2] };
	});
	if (extra > 0) items.push({ type: layered ? ITEM.BYTE14 : ITEM.BYTE, size: extra, version: layered ? 3 : 2 });
	var vlr = {
		compressor: layered ? COMPRESSOR.LAYERED_CHUNKED : COMPRESSOR.POINTWISE_CHUNKED,
		coder: 0,
		version: { major: 3, minor: 4, revision: 3 },
		options: 0,
		chunkSize: chunkSize,
		variableChunks: false,
		items: items
	};
	var bytes = new Uint8Array(34 + 6 * items.length), v = new DataView(bytes.buffer);
	v.setUint16(0, vlr.compressor, true);
	v.setUint16(2, 0, true);
	v.setUint8(4, 3);
	v.setUint8(5, 4);
	v.setUint16(6, 3, true);
	v.setUint32(8, 0, true);
	v.setUint32(12, chunkSize, true);
	for (var at = 16; at < 32; at += 4) v.setUint32(at, 0xFFFFFFFF, true);   // no special EVLRs: count -1, offset -1 (two i64)
	v.setUint16(32, items.length, true);
	items.forEach(function (it, i) {
		v.setUint16(34 + i * 6, it.type, true);
		v.setUint16(36 + i * 6, it.size, true);
		v.setUint16(38 + i * 6, it.version, true);
	});
	return { vlr: vlr, bytes: bytes };
}
