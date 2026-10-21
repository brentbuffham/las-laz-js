// src/laz/ArithmeticDecoder.js
//==========================================================
// The LASzip arithmetic decoder, over a byte range of one Uint8Array
// (a LAZ chunk, read whole). Running past the range end is TRUNCATED:
// a well-formed stream never needs a byte beyond its own end, so a
// short or corrupt chunk fails loudly instead of decoding garbage.
//
// Ported from laz-rs src/decoders.rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2014 martin isenburg,
// rapidlasso; (c) 2014 Uday Verma, Hobu, Inc.; (c) 2019 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, Brent Buffham 2026;
// the coder interval laz-rs calls `length` is `range` here.
// value and range are u32 in Numbers (>>> 0 after every shift); every
// product of a probability and the shifted range stays below 2^32.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

var AC_MAX_LENGTH = 0xFFFFFFFF;
var AC_MIN_LENGTH = 0x01000000;

/**
 * @param {Uint8Array} bytes
 * @param {number} [start] - first byte of the stream (default 0)
 * @param {number} [end] - one past the last byte (default bytes.length)
 */
export function ArithmeticDecoder(bytes, start, end) {
	this.bytes = bytes;
	this.p = start || 0;
	this.end = end === undefined ? bytes.length : end;
	this.value = 0;
	this.range = AC_MAX_LENGTH;
}

ArithmeticDecoder.prototype._next = function () {
	if (this.p >= this.end) throw new LasError(ERROR_CODES.TRUNCATED, "compressed LAZ data ended early", this.p);
	return this.bytes[this.p++];
};

/** Read the 4 big-endian bytes that start the stream. */
ArithmeticDecoder.prototype.readInitBytes = function () {
	this.value = this._next() * 16777216 + this._next() * 65536 + this._next() * 256 + this._next();
	this.range = AC_MAX_LENGTH;
};

ArithmeticDecoder.prototype._renorm = function () {
	do {
		this.value = ((this.value << 8) | this._next()) >>> 0;
		this.range = (this.range << 8) >>> 0;
	} while (this.range < AC_MIN_LENGTH);
};

/** Decode one bit with an adaptive binary model. */
ArithmeticDecoder.prototype.decodeBit = function (m) {
	var x = m.bit0Prob * (this.range >>> 13);   // BM_LENGTH_SHIFT
	var sym;
	if (this.value < x) {
		sym = 0;
		this.range = x;
		m.bit0Count++;
	} else {
		sym = 1;
		this.value -= x;
		this.range -= x;
	}
	if (this.range < AC_MIN_LENGTH) this._renorm();
	if (--m.bitsUntilUpdate === 0) m.update();
	return sym;
};

/** Decode one symbol with an adaptive multi-symbol model. */
ArithmeticDecoder.prototype.decodeSymbol = function (m) {
	var dist = m.distribution, sym, n, x, k, y = this.range;
	if (m.decoderTable) {
		this.range = this.range >>> 15;   // DM_LENGTH_SHIFT
		if (this.range === 0) throw new LasError(ERROR_CODES.TRUNCATED, "corrupt LAZ stream (zero interval)", this.p);
		var dv = Math.floor(this.value / this.range);
		var t = dv >>> m.tableShift;
		sym = m.decoderTable[t];
		n = m.decoderTable[t + 1] + 1;
		while (n > sym + 1) {
			k = (sym + n) >>> 1;
			if (dist[k] > dv) n = k; else sym = k;
		}
		x = dist[sym] * this.range;
		if (sym !== m.lastSymbol) y = dist[sym + 1] * this.range;
	} else {
		x = 0;
		sym = 0;
		this.range = this.range >>> 15;
		n = m.symbols;
		k = n >>> 1;
		do {
			var z = this.range * dist[k];
			if (z > this.value) { n = k; y = z; } else { sym = k; x = z; }
			k = (sym + n) >>> 1;
		} while (k !== sym);
	}
	this.value -= x;
	this.range = y - x;
	if (this.range < AC_MIN_LENGTH) this._renorm();
	m.symbolCount[sym]++;
	if (--m.symbolsUntilUpdate === 0) m.update();
	return sym;
};

/** `bits` raw bits (1-32), as an unsigned Number. */
ArithmeticDecoder.prototype.readBits = function (bits) {
	if (bits > 19) {
		var low = this.readShort();
		return this.readBits(bits - 16) * 65536 + low;
	}
	this.range = this.range >>> bits;
	var sym = Math.floor(this.value / this.range);
	this.value -= this.range * sym;
	if (this.range < AC_MIN_LENGTH) this._renorm();
	return sym;
};

/** 16 raw bits. */
ArithmeticDecoder.prototype.readShort = function () {
	this.range = this.range >>> 16;
	var sym = Math.floor(this.value / this.range);
	this.value -= this.range * sym;
	if (this.range < AC_MIN_LENGTH) this._renorm();
	return sym;
};

/** 32 raw bits (low 16 first), as an unsigned Number. */
ArithmeticDecoder.prototype.readInt = function () {
	var low = this.readShort();
	return this.readShort() * 65536 + low;
};
