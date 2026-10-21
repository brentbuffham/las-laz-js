// src/laz/compressChunk.js
//==========================================================
// Raw LAS records -> one LAZ chunk, the writing half of
// decompressChunk.js: fresh item compressors per chunk, the first
// record stored raw, then — point-wise (formats 0-3) — one arithmetic
// stream for the rest, or — layered (formats 6-8) — the point count,
// every field's layer sizes and the layers. A 0-point chunk is empty;
// a point-wise 1-point chunk is the raw record alone, a layered one
// still has its count, sizes and two empty streams (as LAZperf writes
// both).
//
// Item dispatch after laz-rs src/record.rs and src/laszip/details.rs
// (https://github.com/laz-rs/laz-rs), itself from LASzip by rapidlasso.
// (c) 2007-2015 martin isenburg, rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: written in JavaScript over byte buffers, Brent Buffham 2026.
//==========================================================

import { ArithmeticEncoder } from "./ArithmeticEncoder.js";
import { ITEM, COMPRESSOR } from "./LazVlr.js";
import { checkChunkVlr, checkPointwiseItem, checkLayeredItem } from "./decompressChunk.js";
import { Point10Compressor } from "./v2/point10.js";
import { GpsTime11Compressor } from "./v2/gpstime11.js";
import { Rgb12Compressor } from "./v2/rgb12.js";
import { ByteCompressor } from "./v2/byte.js";
import { Point14Compressor } from "./v3/point14.js";
import { Rgb14Compressor, Nir14Compressor, Byte14Compressor } from "./v3/layered.js";

var LE = true;

function pointwiseItem(it) {
	checkPointwiseItem(it);
	switch (it.type) {
		case ITEM.POINT10: return function () { return new Point10Compressor(); };
		case ITEM.GPSTIME11: return function () { return new GpsTime11Compressor(); };
		case ITEM.RGB12: return function () { return new Rgb12Compressor(); };
		default: return function () { return new ByteCompressor(it.size); };
	}
}

// Layered (LAS 1.4) items, versions 3 and 4: each makes one or more field compressors
function layeredItem(it) {
	checkLayeredItem(it);
	var v = it.version;
	switch (it.type) {
		case ITEM.POINT14: return function () { return [new Point14Compressor(v)]; };
		case ITEM.RGB14: return function () { return [new Rgb14Compressor(v)]; };
		case ITEM.RGBNIR14: return function () { return [new Rgb14Compressor(v), new Nir14Compressor(v)]; };
		default: return function () { return [new Byte14Compressor(it.size, v)]; };
	}
}

// A layered chunk, the mirror of decompressChunk's: the first record raw, a u32 point count,
// every field's layer sizes (u32), then the layers; Point14 passes the scanner channel on to
// the fields after it, from 0 at each point as the decoder starts it
function layeredChunk(makers, recordLength) {
	return function compressChunk(records, start, count) {
		if (!count) return new Uint8Array(0);
		var fields = [];
		makers.forEach(function (make) { fields.push.apply(fields, make()); });
		var ctx = { v: 0 }, p = start, k;
		for (k = 0; k < fields.length; k++) { fields[k].first(records, p, ctx); p += fields[k].size; }
		for (var i = 1; i < count; i++) {
			ctx.v = 0;
			for (k = 0; k < fields.length; k++) { fields[k].next(records, p, ctx); p += fields[k].size; }
		}
		var layers = [];
		fields.forEach(function (f) { layers.push.apply(layers, f.finish()); });
		var total = layers.reduce(function (n, l) { return n + l.length; }, recordLength + 4 + 4 * layers.length);
		var out = new Uint8Array(total), dv = new DataView(out.buffer);
		out.set(records.subarray(start, start + recordLength));
		dv.setUint32(recordLength, count, LE);
		var q = recordLength + 4;
		layers.forEach(function (l) { dv.setUint32(q, l.length, LE); q += 4; });
		layers.forEach(function (l) { out.set(l, q); q += l.length; });
		return out;
	};
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
	if (vlr.compressor === COMPRESSOR.LAYERED_CHUNKED) return layeredChunk(vlr.items.map(layeredItem), recordLength);
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
