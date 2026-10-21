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
// NOTICE). Changes: translated from Rust to JavaScript, Brent Buffham 2026.
//==========================================================

import { ArithmeticModel } from "../models.js";

/** Byte v2 decompressor for `count` extra bytes: one per chunk. */
export function ByteDecompressor(count) {
	this.size = count;
	this.last = new Uint8Array(count);
	this.models = [];
	for (var i = 0; i < count; i++) this.models.push(new ArithmeticModel(256));
}

ByteDecompressor.prototype.first = function (src, s, view, o) {
	for (var i = 0; i < this.size; i++) { this.last[i] = src[s + i]; view.setUint8(o + i, src[s + i]); }
};

ByteDecompressor.prototype.next = function (dec, view, o) {
	for (var i = 0; i < this.size; i++) {
		this.last[i] = (this.last[i] + dec.decodeSymbol(this.models[i])) & 255;
		view.setUint8(o + i, this.last[i]);
	}
};
