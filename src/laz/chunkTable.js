// src/laz/chunkTable.js
//==========================================================
// Where each compressed chunk lives. A chunked LAZ file starts its
// point data with an i64 offset to the chunk table (written last, so
// a streaming writer leaves -1 there and repeats the offset in the
// file's final 8 bytes). The table is u32 version, u32 chunk count,
// then each chunk's byte count (and, for variable-size chunks, its
// point count), arithmetic-coded as integers predicted from the
// previous chunk. Chunk 0 starts right after the 8-byte offset.
// A point-wise (unchunked) file is one chunk running to the end.
//
// From laz-rs src/laszip/chunk_table.rs (https://github.com/laz-rs/laz-rs),
// itself from LASzip by rapidlasso. (c) 2007-2015 martin isenburg,
// rapidlasso; (c) 2019-2023 Thomas Montaigu. Licensed under the Apache
// License, Version 2.0 (see LICENSE-APACHE and NOTICE). Changes: written
// in JavaScript over an async byte source, Brent Buffham 2026.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { ArithmeticDecoder } from "./ArithmeticDecoder.js";
import { IntegerDecompressor } from "./IntegerDecompressor.js";
import { COMPRESSOR } from "./LazVlr.js";

// Signed i64 at `at` as a Number (an offset; > 2^53 is refused)
function i64(bytes, at) {
	var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var lo = v.getUint32(at, true), hi = v.getInt32(at + 4, true);
	if (hi > 2097151 || hi < -2097152) throw new LasError(ERROR_CODES.BAD_HEADER, "LAZ chunk table offset is out of range", at);
	return hi * 4294967296 + lo;
}

/**
 * Decode the chunk table body.
 * @param {Uint8Array} bytes - from the table's start to the end of the file
 * @param {boolean} withPointCounts - variable-size chunks
 * @returns {Array<{pointCount:number, byteCount:number}>}
 */
export function decodeChunkTable(bytes, withPointCounts) {
	if (bytes.length < 8) throw new LasError(ERROR_CODES.TRUNCATED, "the LAZ chunk table is cut short");
	var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var n = v.getUint32(4, true);
	var out = [];
	if (!n) return out;
	var dec = new ArithmeticDecoder(bytes, 8, bytes.length);
	dec.readInitBytes();
	var ic = new IntegerDecompressor(32, 2);
	var prevPoints = 0, prevBytes = 0;
	for (var i = 0; i < n; i++) {
		var points = withPointCounts ? ic.decompress(dec, prevPoints, 0) : 0;
		var size = ic.decompress(dec, prevBytes, 1);
		// stored as u32 in an i32 coder: read back unsigned
		points = points >>> 0; size = size >>> 0;
		out.push({ pointCount: points, byteCount: size });
		prevPoints = points | 0; prevBytes = size | 0;
	}
	return out;
}

/**
 * Every chunk of a LAZ file: its first record, point count and byte range.
 * @param {{size:number, read:function(number, number): Promise<Uint8Array>}} src
 * @param {object} header - parseHeader (offsetToPointData, pointCount, evlrStart)
 * @param {object} vlr - parseLazVlr
 * @returns {Promise<Array<{firstRecord:number, count:number, start:number, end:number}>>}
 */
export async function readChunks(src, header, vlr) {
	var dataStart = header.offsetToPointData;
	var total = header.pointCount;
	if (vlr.compressor === COMPRESSOR.POINTWISE) {
		var stop = header.evlrStart > dataStart && header.evlrStart <= src.size ? header.evlrStart : src.size;
		return total ? [{ firstRecord: 0, count: total, start: dataStart, end: stop }] : [];
	}
	if (vlr.compressor !== COMPRESSOR.POINTWISE_CHUNKED && vlr.compressor !== COMPRESSOR.LAYERED_CHUNKED) {
		throw new LasError(ERROR_CODES.UNSUPPORTED, "LAZ compressor " + vlr.compressor + " is not one LASzip defines (1-3)");
	}
	if (dataStart + 8 > src.size) throw new LasError(ERROR_CODES.TRUNCATED, "the LAZ point data is cut short", src.size);
	var tableAt = i64(await src.read(dataStart, dataStart + 8), 0);
	if (tableAt <= dataStart && src.size >= 8) tableAt = i64(await src.read(src.size - 8, src.size), 0);   // streaming writers repeat it last
	if (tableAt <= dataStart || tableAt >= src.size) {
		throw new LasError(ERROR_CODES.UNSUPPORTED, "this LAZ file has no chunk table (an unfinished write?); it cannot be read in windows");
	}
	// Read only the table: EVLRs (which can be huge) may follow it. Each coded entry
	// is two integers of at most ~6 bytes each; 24 bytes per chunk is a safe ceiling.
	var head = await src.read(tableAt, Math.min(src.size, tableAt + 8));
	var nChunks = head.length === 8 ? new DataView(head.buffer, head.byteOffset, 8).getUint32(4, true) : 0;
	var table = decodeChunkTable(await src.read(tableAt, Math.min(src.size, tableAt + 8 + nChunks * 24 + 16)), vlr.variableChunks);
	var chunks = [], at = dataStart + 8, first = 0;
	for (var i = 0; i < table.length && first < total; i++) {
		var count = vlr.variableChunks ? table[i].pointCount : Math.min(vlr.chunkSize, total - first);
		var end = at + table[i].byteCount;
		if (end > tableAt) throw new LasError(ERROR_CODES.BAD_HEADER, "LAZ chunk " + i + " runs into the chunk table", at);
		chunks.push({ firstRecord: first, count: count, start: at, end: end });
		first += count;
		at = end;
	}
	if (first < total) throw new LasError(ERROR_CODES.TRUNCATED, "the LAZ chunk table covers " + first + " of " + total + " points", tableAt);
	return chunks;
}
