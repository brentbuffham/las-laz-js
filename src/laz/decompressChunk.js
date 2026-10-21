// src/laz/decompressChunk.js
//==========================================================
// One LAZ chunk -> the raw LAS records it holds, written into the
// caller's buffer exactly as a LAS file stores them, so the rest of
// the library (decodeRecords, filters, columns) reads LAZ and LAS the
// same way. Each chunk is independent: fresh item decompressors, the
// first record stored raw, then one arithmetic stream for the rest.
//
// Item dispatch after laz-rs src/record.rs and src/laszip/details.rs
// (https://github.com/laz-rs/laz-rs), itself from LASzip by rapidlasso.
// (c) 2007-2015 martin isenburg, rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: written in JavaScript over byte buffers, Brent Buffham 2026.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { ArithmeticDecoder } from "./ArithmeticDecoder.js";
import { ITEM, COMPRESSOR } from "./LazVlr.js";
import { Point10Decompressor } from "./v2/point10.js";
import { GpsTime11Decompressor } from "./v2/gpstime11.js";
import { Rgb12Decompressor } from "./v2/rgb12.js";
import { ByteDecompressor } from "./v2/byte.js";
import { Point14Decompressor } from "./v3/point14.js";
import { Rgb14Decompressor, Nir14Decompressor, Byte14Decompressor } from "./v3/layered.js";

var NAMES = { 0: "Byte", 6: "Point10", 7: "GpsTime11", 8: "RGB12", 9: "WavePacket13", 10: "Point14", 11: "RGB14", 12: "RGBNIR14", 13: "WavePacket14", 14: "Byte14" };

function pointwiseItem(it) {
	if (it.version !== 2 && !(it.type === ITEM.BYTE && it.version === 1)) {
		throw new LasError(ERROR_CODES.UNSUPPORTED, "LAZ item " + (NAMES[it.type] || it.type) + " version " + it.version + " is not supported (version 2 is; version 1 is from LASzip before 2011)");
	}
	switch (it.type) {
		case ITEM.POINT10: return function () { return new Point10Decompressor(); };
		case ITEM.GPSTIME11: return function () { return new GpsTime11Decompressor(); };
		case ITEM.RGB12: return function () { return new Rgb12Decompressor(); };
		case ITEM.BYTE: return function () { return new ByteDecompressor(it.size); };
		default: throw new LasError(ERROR_CODES.UNSUPPORTED, "LAZ item " + (NAMES[it.type] || it.type) + " is not supported (wave packets are not read)");
	}
}

// Layered (LAS 1.4) items, versions 3 and 4: each makes one or more field decoders
function layeredItem(it) {
	if (it.version !== 3 && it.version !== 4) {
		throw new LasError(ERROR_CODES.UNSUPPORTED, "LAZ item " + (NAMES[it.type] || it.type) + " version " + it.version + " is not supported in a layered file (versions 3 and 4 are)");
	}
	var v = it.version;
	switch (it.type) {
		case ITEM.POINT14: return function () { return [new Point14Decompressor(v)]; };
		case ITEM.RGB14: return function () { return [new Rgb14Decompressor(v)]; };
		case ITEM.RGBNIR14: return function () { return [new Rgb14Decompressor(v), new Nir14Decompressor(v)]; };
		case ITEM.BYTE14: return function () { return [new Byte14Decompressor(it.size, v)]; };
		default: throw new LasError(ERROR_CODES.UNSUPPORTED, "LAZ item " + (NAMES[it.type] || it.type) + " is not supported (wave packets are not read)");
	}
}

function cutShort(at) { throw new LasError(ERROR_CODES.TRUNCATED, "a LAZ chunk is cut short", at); }

// A layered chunk: the first record raw, a u32 point count, every field's
// layer sizes, then the layers; each later point is decoded field by field,
// Point14 passing the scanner channel on to the fields after it.
function layeredChunk(makers, recordLength, layerWords) {
	return function decodeChunk(bytes, s, e, count, view, o) {
		if (!count) return;
		var fields = [];
		makers.forEach(function (make) { fields.push.apply(fields, make()); });
		var ctx = { v: 0 }, p = s, k;
		if (p + recordLength > e) cutShort(p);
		for (k = 0; k < fields.length; k++) { fields[k].first(bytes, p, view, o, ctx); p += fields[k].size; o += fields[k].size; }
		if (count === 1) return;
		if (p + 4 + layerWords * 4 > e) cutShort(p);
		var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		p += 4;                                                    // the chunk's point count (the table already has it)
		for (k = 0; k < fields.length; k++) p = fields[k].readLayerSizes(dv, p);
		for (k = 0; k < fields.length; k++) p = fields[k].readLayers(bytes, p, e, cutShort);
		for (var i = 1; i < count; i++) {
			ctx.v = 0;
			for (k = 0; k < fields.length; k++) { fields[k].next(view, o, ctx); o += fields[k].size; }
		}
	};
}

/**
 * Check a LASzip VLR against the file and build the chunk decoder.
 * @param {object} vlr - parseLazVlr
 * @param {number} recordLength - header record length
 * @returns {function(Uint8Array, number, number, number, DataView, number): void}
 *   decode(bytes, start, end, count, outView, outOffset) — one chunk's records into outView
 */
export function createChunkDecoder(vlr, recordLength) {
	var size = vlr.items.reduce(function (s, it) { return s + it.size; }, 0);
	if (size !== recordLength) throw new LasError(ERROR_CODES.BAD_VLR, "the LASzip items make " + size + "-byte records but the header says " + recordLength);
	if (vlr.coder !== 0) throw new LasError(ERROR_CODES.UNSUPPORTED, "LAZ coder " + vlr.coder + " (only the arithmetic coder, 0, exists)");
	if (vlr.compressor === COMPRESSOR.LAYERED_CHUNKED) {
		var words = vlr.items.reduce(function (s, it) { return s + (it.type === ITEM.POINT14 ? 9 : it.type === ITEM.RGBNIR14 ? 2 : it.type === ITEM.BYTE14 ? it.size : 1); }, 0);
		return layeredChunk(vlr.items.map(layeredItem), recordLength, words);
	}
	var makers = vlr.items.map(pointwiseItem);
	return function decodeChunk(bytes, s, e, count, view, o) {
		if (!count) return;
		var items = makers.map(function (make) { return make(); });
		var k, p = s;
		if (p + recordLength > e) throw new LasError(ERROR_CODES.TRUNCATED, "a LAZ chunk is shorter than one record", p);
		for (k = 0; k < items.length; k++) { items[k].first(bytes, p, view, o); p += items[k].size; o += items[k].size; }
		if (count === 1) return;
		var dec = new ArithmeticDecoder(bytes, p, e);
		dec.readInitBytes();
		for (var i = 1; i < count; i++) {
			for (k = 0; k < items.length; k++) { items[k].next(dec, view, o); o += items[k].size; }
		}
	};
}
