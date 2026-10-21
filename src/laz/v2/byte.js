// src/laz/v2/byte.js
//==========================================================
// LASzip Byte item, versions 1 and 2 (the same coder): extra bytes
// after the standard fields, each coded as a byte difference from the
// same byte of the last point, one model per byte.
//
// Ported from laz-rs src/las/extra_bytes.rs, module v1 (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2014 martin isenburg,
// rapidlasso; (c) 2014 Uday Verma, Hobu, Inc.; (c) 2019 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, Brent Buffham 2026;
// the compressor (ByteCompressor) added beside the decompressor.
//==========================================================

import { ArithmeticModel } from "../models.js";

// The state and models both halves start a chunk with: the last bytes and one model per byte
function initByte(self, count) {
	self.size = count;
	self.last = new Uint8Array(count);
	self.models = [];
	for (var i = 0; i < count; i++) self.models.push(new ArithmeticModel(256));
}

/** Byte v2 decompressor for `count` extra bytes: one per chunk. */
export function ByteDecompressor(count) { initByte(this, count); }

ByteDecompressor.prototype.first = function (src, s, view, o) {
	for (var i = 0; i < this.size; i++) { this.last[i] = src[s + i]; view.setUint8(o + i, src[s + i]); }
};

ByteDecompressor.prototype.next = function (dec, view, o) {
	for (var i = 0; i < this.size; i++) {
		this.last[i] = (this.last[i] + dec.decodeSymbol(this.models[i])) & 255;
		view.setUint8(o + i, this.last[i]);
	}
};

/** Byte v2 compressor for `count` extra bytes: one per chunk, the mirror of ByteDecompressor. */
export function ByteCompressor(count) { initByte(this, count); }

ByteCompressor.prototype.first = function (src, s) { this.last.set(src.subarray(s, s + this.size)); };

ByteCompressor.prototype.next = function (enc, src, s) {
	for (var i = 0; i < this.size; i++) {
		enc.encodeSymbol(this.models[i], (src[s + i] - this.last[i]) & 255);   // u8 wrapping_sub
		this.last[i] = src[s + i];
	}
};
