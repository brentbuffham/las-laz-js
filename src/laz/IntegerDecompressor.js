// src/laz/IntegerDecompressor.js
//==========================================================
// LASzip's integer decompressor: an integer is coded as a correction
// to a prediction — first k, the bit length of the correction (one
// model per context), then the correction's bits (modelled up to
// bitsHigh bits, raw above). The result wraps into the integer's
// range like the encoder's did (i32 wrap for 32-bit integers).
//
// Ported from laz-rs src/decompressors.rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2014 martin isenburg,
// rapidlasso; (c) 2014 Uday Verma, Hobu, Inc.; (c) 2019 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, Brent Buffham 2026.
//==========================================================

import { ArithmeticModel, ArithmeticBitModel } from "./models.js";

/**
 * @param {number} [bits] - integer width (default 16; 32 wraps as i32)
 * @param {number} [contexts] - number of k models (default 1)
 * @param {number} [bitsHigh] - correction bits that are modelled (default 8)
 * (laz-rs also takes an explicit range; no LAZ item uses one, so it is left out)
 */
export function IntegerDecompressor(bits, contexts, bitsHigh) {
	bits = bits === undefined ? 16 : bits;
	this.contexts = contexts === undefined ? 1 : contexts;
	this.bitsHigh = bitsHigh === undefined ? 8 : bitsHigh;
	if (bits && bits < 32) {
		this.corrBits = bits;
		this.corrRange = Math.pow(2, bits);
		this.corrMin = -Math.floor(this.corrRange / 2);
	} else {
		this.corrBits = 32;
		this.corrRange = 0;
		this.corrMin = -2147483648;
	}
	// laz-rs compares and adds `corr_range as i32`
	this.corrRangeI32 = this.corrRange > 2147483647 ? this.corrRange - 4294967296 : this.corrRange;
	this.k = 0;
	this.mBits = [];
	for (var c = 0; c < this.contexts; c++) this.mBits.push(new ArithmeticModel(this.corrBits + 1));
	this.mCorrector0 = new ArithmeticBitModel();
	this.mCorrector = [];
	for (var i = 1; i <= this.corrBits; i++) this.mCorrector.push(new ArithmeticModel(Math.pow(2, i <= this.bitsHigh ? i : this.bitsHigh)));
}

/**
 * @param {import("./ArithmeticDecoder.js").ArithmeticDecoder} dec
 * @param {number} pred - the prediction (i32)
 * @param {number} context
 * @returns {number} the decoded integer (i32; within [0, range) for narrower integers)
 */
IntegerDecompressor.prototype.decompress = function (dec, pred, context) {
	var k = dec.decodeSymbol(this.mBits[context]);
	var c;
	this.k = k;
	if (k !== 0) {
		if (k < 32) {
			if (k <= this.bitsHigh) {
				c = dec.decodeSymbol(this.mCorrector[k - 1]);
			} else {
				var k1 = k - this.bitsHigh;
				c = dec.decodeSymbol(this.mCorrector[k - 1]) * Math.pow(2, k1) + dec.readBits(k1);
			}
			if (c >= Math.pow(2, k - 1)) c += 1;
			else c -= Math.pow(2, k) - 1;
		} else {
			c = this.corrMin;
		}
	} else {
		c = dec.decodeBit(this.mCorrector0);
	}
	var real = (pred + c) | 0;   // i32 wrapping_add
	if (real < 0) real = (real + this.corrRangeI32) | 0;
	else if (real >= this.corrRangeI32) real = (real - this.corrRangeI32) | 0;
	return real;
};
