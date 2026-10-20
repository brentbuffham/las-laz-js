// src/format/LasHeader.js
//==========================================================
// The LAS public header block (ASPRS LAS 1.0-1.4 R15). Reads from
// any sync source (a MemorySource over the first bytes of the
// file). 64-bit fields go through readU64 (hi * 2^32 + lo), never
// bit operators.
//
// Point count: LAS 1.4 stores a u64 count at 247 and a "legacy"
// u32 at 107 that is 0 for formats 6-10 or counts above 2^32, so
// a 1.4 header always takes the u64.
// LAZ marks its compressed points by setting bit 7 (and in some
// writers bit 6) of the point format byte: 131 = format 3, LAZ.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { readU64, readAscii } from "../io/ByteSource.js";
import { POINT_FORMATS } from "./PointFormats.js";

var LE = true;

/**
 * Parse the public header.
 * @param {object} src - sync source over at least the header bytes.
 * @returns {object} header
 */
export function parseHeader(src) {
	if (src.length() < 227) throw new LasError(ERROR_CODES.TRUNCATED, "file is shorter than a LAS header", 0);
	if (readAscii(src, 0, 4) !== "LASF") throw new LasError(ERROR_CODES.NOT_LAS, "no LASF signature: not a LAS file", 0);

	var major = src.getUint8(24), minor = src.getUint8(25);
	if (major !== 1 || minor > 4) {
		throw new LasError(ERROR_CODES.UNSUPPORTED_VERSION, "LAS version " + major + "." + minor + " is not supported (1.0-1.4)", 24);
	}
	var headerSize = src.getUint16(94, LE);
	if (headerSize < 227) throw new LasError(ERROR_CODES.BAD_HEADER, "header size " + headerSize + " is below the 227 bytes every version needs", 94);

	var formatByte = src.getUint8(104);
	var pointFormat = formatByte & 0x3F; // bits-ok
	var compressed = formatByte >= 128 || (formatByte & 0x40) !== 0; // bits-ok
	if (pointFormat > 10) throw new LasError(ERROR_CODES.BAD_HEADER, "point format " + pointFormat + " does not exist (0-10)", 104);
	var recordLength = src.getUint16(105, LE);
	if (recordLength < POINT_FORMATS[pointFormat].size) {
		throw new LasError(ERROR_CODES.BAD_HEADER, "record length " + recordLength + " is shorter than format " + pointFormat + " needs (" + POINT_FORMATS[pointFormat].size + ")", 105);
	}

	var is14 = minor >= 4 && headerSize >= 375 && src.length() >= 375;
	var pointCount = src.getUint32(107, LE);
	var pointsByReturn = [];
	var i;
	if (is14) {
		pointCount = readU64(src, 247, LE);
		if (pointCount === null) throw new LasError(ERROR_CODES.TOO_MANY_POINTS, "more points than JavaScript can count exactly (2^53)", 247);
		for (i = 0; i < 15; i++) pointsByReturn.push(readU64(src, 255 + i * 8, LE) || 0);
	} else {
		for (i = 0; i < 5; i++) pointsByReturn.push(src.getUint32(111 + i * 4, LE));
		for (i = 5; i < 15; i++) pointsByReturn.push(0);
	}

	var h = {
		fileSourceId: src.getUint16(4, LE),
		globalEncoding: src.getUint16(6, LE),
		versionMajor: major,
		versionMinor: minor,
		systemId: readAscii(src, 26, 32),
		software: readAscii(src, 58, 32),
		creationDay: src.getUint16(90, LE),
		creationYear: src.getUint16(92, LE),
		headerSize: headerSize,
		offsetToPointData: src.getUint32(96, LE),
		numberOfVlrs: src.getUint32(100, LE),
		pointFormat: pointFormat,
		compressed: compressed,
		recordLength: recordLength,
		extraBytes: recordLength - POINT_FORMATS[pointFormat].size,
		pointCount: pointCount,
		pointsByReturn: pointsByReturn,
		scale: { x: src.getFloat64(131, LE), y: src.getFloat64(139, LE), z: src.getFloat64(147, LE) },
		offset: { x: src.getFloat64(155, LE), y: src.getFloat64(163, LE), z: src.getFloat64(171, LE) },
		bounds: {
			minX: src.getFloat64(187, LE), maxX: src.getFloat64(179, LE),
			minY: src.getFloat64(203, LE), maxY: src.getFloat64(195, LE),
			minZ: src.getFloat64(219, LE), maxZ: src.getFloat64(211, LE)
		},
		waveformStart: 0,
		evlrStart: 0,
		numberOfEvlrs: 0
	};
	if (minor >= 3 && headerSize >= 235 && src.length() >= 235) h.waveformStart = readU64(src, 227, LE) || 0;
	if (is14) {
		h.evlrStart = readU64(src, 235, LE) || 0;
		h.numberOfEvlrs = src.getUint32(243, LE);
	}
	if (h.offsetToPointData < headerSize) {
		throw new LasError(ERROR_CODES.BAD_HEADER, "point data starts inside the header", 96);
	}
	return h;
}
