// src/laz/compressChunk.js
//==========================================================
// Raw LAS records -> one LAZ chunk, the writing half of
// decompressChunk.js: fresh item compressors per chunk, the first
// record stored raw, then one arithmetic stream for the rest. A
// 1-point chunk is the raw record alone (no stream, as LAZperf writes
// it); a 0-point chunk is empty.
//
// Item dispatch after laz-rs src/record.rs and src/laszip/details.rs
// (https://github.com/laz-rs/laz-rs), itself from LASzip by rapidlasso.
// (c) 2007-2015 martin isenburg, rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: written in JavaScript over byte buffers, Brent Buffham 2026.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { ArithmeticEncoder } from "./ArithmeticEncoder.js";
import { ITEM, COMPRESSOR } from "./LazVlr.js";
import { checkChunkVlr, checkPointwiseItem } from "./decompressChunk.js";
import { Point10Compressor } from "./v2/point10.js";
import { GpsTime11Compressor } from "./v2/gpstime11.js";
import { Rgb12Compressor } from "./v2/rgb12.js";
import { ByteCompressor } from "./v2/byte.js";

function pointwiseItem(it) {
	checkPointwiseItem(it);
	switch (it.type) {
		case ITEM.POINT10: return function () { return new Point10Compressor(); };
		case ITEM.GPSTIME11: return function () { return new GpsTime11Compressor(); };
		case ITEM.RGB12: return function () { return new Rgb12Compressor(); };
		default: return function () { return new ByteCompressor(it.size); };
	}
}

/**
 * Check a LASzip VLR against the records and build the chunk compressor.
 * @param {object} vlr - parseLazVlr, or the VLR the writer will store
 * @param {number} recordLength - the records' length
 * @returns {function(Uint8Array, number, number): Uint8Array}
 *   compress(records, start, count) — the chunk of `count` records from byte `start`,
 *   exactly as a LAZ file stores it
 */
export function createChunkCompressor(vlr, recordLength) {
	checkChunkVlr(vlr, recordLength);
	if (vlr.compressor === COMPRESSOR.LAYERED_CHUNKED) throw new LasError(ERROR_CODES.UNSUPPORTED, "layered (LAS 1.4) compression is not written yet");
	var makers = vlr.items.map(pointwiseItem);
	return function compressChunk(records, start, count) {
		if (!count) return new Uint8Array(0);
		var items = makers.map(function (make) { return make(); });
		var k, p = start;
		for (k = 0; k < items.length; k++) { items[k].first(records, p); p += items[k].size; }
		if (count === 1) return records.slice(start, p);
		var enc = new ArithmeticEncoder();
		for (var i = 1; i < count; i++) {
			for (k = 0; k < items.length; k++) { items[k].next(enc, records, p); p += items[k].size; }
		}
		var stream = enc.done(), out = new Uint8Array(recordLength + stream.length);
		out.set(records.subarray(start, start + recordLength));
		out.set(stream, recordLength);
		return out;
	};
}
