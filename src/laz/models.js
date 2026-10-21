// src/laz/models.js
//==========================================================
// Adaptive probability models for the LASzip arithmetic coder: a
// multi-symbol model (with a decoder look-up table above 16 symbols)
// and a binary model. Both re-estimate their probabilities on a
// growing update cycle, exactly as the encoder did, so encoder and
// decoder stay in step symbol for symbol.
//
// Ported from laz-rs src/models.rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2014 martin isenburg,
// rapidlasso; (c) 2014 Uday Verma, Hobu, Inc.; (c) 2019 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, Brent Buffham 2026.
// All values are u32 held in Numbers; every product stays below 2^32.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

export var DM_LENGTH_SHIFT = 15;
var DM_MAX_COUNT = 32768;          // 1 << DM_LENGTH_SHIFT
export var BM_LENGTH_SHIFT = 13;
var BM_MAX_COUNT = 8192;           // 1 << BM_LENGTH_SHIFT

/**
 * Adaptive model over `symbols` symbols (2..2048).
 * @param {number} symbols
 * @param {Uint32Array|number[]} [initTable] - starting counts (default 1 each)
 */
export function ArithmeticModel(symbols, initTable) {
	if (!(symbols >= 2 && symbols <= 2048)) throw new LasError(ERROR_CODES.UNSUPPORTED, "LAZ model with " + symbols + " symbols (2-2048)");
	this.symbols = symbols;
	this.lastSymbol = symbols - 1;
	this.tableSize = 0;
	this.tableShift = 0;
	this.decoderTable = null;
	if (symbols > 16) {
		var tableBits = 3;
		while (symbols > Math.pow(2, tableBits + 2)) tableBits++;
		this.tableSize = Math.pow(2, tableBits);
		this.tableShift = DM_LENGTH_SHIFT - tableBits;
		this.decoderTable = new Uint32Array(this.tableSize + 2);
	}
	this.distribution = new Uint32Array(symbols);
	this.symbolCount = new Uint32Array(symbols);
	for (var k = 0; k < symbols; k++) this.symbolCount[k] = initTable ? initTable[k] : 1;
	this.totalCount = 0;
	this.updateCycle = symbols;
	this.symbolsUntilUpdate = 0;
	this.update();
	this.symbolsUntilUpdate = this.updateCycle = (symbols + 6) >>> 1;
}

/** Re-estimate the distribution from the counts (and rebuild the decoder table). */
ArithmeticModel.prototype.update = function () {
	var counts = this.symbolCount, dist = this.distribution, n = this.symbols, k;
	this.totalCount += this.updateCycle;
	if (this.totalCount > DM_MAX_COUNT) {
		this.totalCount = 0;
		for (k = 0; k < n; k++) { counts[k] = (counts[k] + 1) >>> 1; this.totalCount += counts[k]; }
	}
	var sum = 0, scale = Math.floor(0x80000000 / this.totalCount);
	if (!this.decoderTable) {
		for (k = 0; k < n; k++) { dist[k] = (scale * sum) >>> 16; sum += counts[k]; }   // >> (31 - DM_LENGTH_SHIFT)
	} else {
		var table = this.decoderTable, shift = this.tableShift, s = 0;
		for (k = 0; k < n; k++) {
			dist[k] = (scale * sum) >>> 16;
			sum += counts[k];
			var w = dist[k] >>> shift;
			while (s < w) { s++; table[s] = k - 1; }
		}
		table[0] = 0;
		while (s <= this.tableSize) { s++; table[s] = n - 1; }
	}
	this.updateCycle = (5 * this.updateCycle) >>> 2;
	var maxCycle = (n + 6) * 8;
	if (this.updateCycle > maxCycle) this.updateCycle = maxCycle;
	this.symbolsUntilUpdate = this.updateCycle;
};

/** Adaptive binary model. */
export function ArithmeticBitModel() {
	this.bit0Count = 1;
	this.bitCount = 2;
	this.bit0Prob = 4096;            // 1 << (BM_LENGTH_SHIFT - 1)
	this.bitsUntilUpdate = 4;
	this.updateCycle = 4;
}

ArithmeticBitModel.prototype.update = function () {
	this.bitCount += this.updateCycle;
	if (this.bitCount > BM_MAX_COUNT) {
		this.bitCount = (this.bitCount + 1) >>> 1;
		this.bit0Count = (this.bit0Count + 1) >>> 1;
		if (this.bit0Count === this.bitCount) this.bitCount++;
	}
	var scale = Math.floor(0x80000000 / this.bitCount);
	this.bit0Prob = (this.bit0Count * scale) >>> 18;   // >> (31 - BM_LENGTH_SHIFT)
	this.updateCycle = (5 * this.updateCycle) >>> 2;
	if (this.updateCycle > 64) this.updateCycle = 64;
	this.bitsUntilUpdate = this.updateCycle;
};
