// src/laz/IntegerCompressor.js
//==========================================================
// LASzip's integer compressor, the writing half of IntegerDecompressor:
// an integer is coded as a correction to a prediction — first k, the
// bit length of the correction (one model per context), then the
// correction's bits (modelled up to bitsHigh bits, raw above). The
// correction wraps into the integer's range (i32 wrap for 32-bit
// integers), so the decoder's wrap undoes it.
//
// Ported from laz-rs src/compressors.rs (https://github.com/laz-rs/laz-rs),
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
export function IntegerCompressor(bits, contexts, bitsHigh) {
	bits = bits === undefined ? 16 : bits;
	this.contexts = contexts === undefined ? 1 : contexts;
	this.bitsHigh = bitsHigh === undefined ? 8 : bitsHigh;
	if (bits && bits < 32) {
		this.corrBits = bits;
		this.corrRange = Math.pow(2, bits);
		this.corrMin = -this.corrRange / 2;
		this.corrMax = this.corrMin + this.corrRange - 1;
	} else {
		this.corrBits = 32;
		this.corrRange = 0;
		this.corrMin = -2147483648;
		this.corrMax = 2147483647;
	}
	this.k = 0;   // bit length of the last correction, as IntegerDecompressor.k
	this.mBits = [];
	for (var c = 0; c < this.contexts; c++) this.mBits.push(new ArithmeticModel(this.corrBits + 1));
	this.mCorrector0 = new ArithmeticBitModel();
	this.mCorrector = [];
	for (var i = 1; i <= this.corrBits; i++) this.mCorrector.push(new ArithmeticModel(Math.pow(2, i <= this.bitsHigh ? i : this.bitsHigh)));
}

/**
 * @param {import("./ArithmeticEncoder.js").ArithmeticEncoder} enc
 * @param {number} pred - the prediction (i32)
 * @param {number} real - the integer to write
 * @param {number} context
 */
IntegerCompressor.prototype.compress = function (enc, pred, real, context) {
	var corr = (real - pred) | 0;   // i32 wrapping_sub
	if (corr < this.corrMin) corr += this.corrRange;
	else if (corr > this.corrMax) corr -= this.corrRange;
	var c1 = corr <= 0 ? -corr : corr - 1, k = 0;
	while (c1 >= 1) { c1 = Math.floor(c1 / 2); k++; }
	this.k = k;
	enc.encodeSymbol(this.mBits[context], k);
	if (k !== 0) {
		if (k < 32) {
			var c = corr >= 0 ? corr - 1 : corr + Math.pow(2, k) - 1;
			if (k <= this.bitsHigh) {
				enc.encodeSymbol(this.mCorrector[k - 1], c);
			} else {
				var k1 = k - this.bitsHigh, low = c % Math.pow(2, k1);
				enc.encodeSymbol(this.mCorrector[k - 1], Math.floor(c / Math.pow(2, k1)));
				enc.writeBits(k1, low);
			}
		}
	} else {
		enc.encodeBit(this.mCorrector0, corr);
	}
};
