// src/laz/ArithmeticEncoder.js
//==========================================================
// The LASzip arithmetic encoder, the writing half of ArithmeticDecoder:
// whatever it writes, the decoder reads back exactly. Bytes go into a
// growable Uint8Array (64 KiB to start, doubled when full); done()
// flushes the coder and returns a copy of the bytes written. A carry out
// of base walks back over those bytes, as laz-rs walks its buffer.
//
// Ported from laz-rs src/encoders.rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2014 martin isenburg,
// rapidlasso; (c) 2014 Uday Verma, Hobu, Inc.; (c) 2019 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, Brent Buffham 2026;
// written into a growable byte array instead of laz-rs's ring buffer.
// base and range are u32 in Numbers (no bit operators: sums and
// products stay below 2^53 and wrap by subtraction or modulo).
// The models are the library's (models.js): the encoder and decoder
// must share them, as LASzip's do.
//==========================================================

var AC_MIN_LENGTH = 0x01000000;
var FIRST_ALLOCATION = 65536;

/** An arithmetic encoder over a growable byte buffer. */
export function ArithmeticEncoder() {
	this.buf = new Uint8Array(FIRST_ALLOCATION);
	this.n = 0;   // bytes written
	this.base = 0;
	this.range = 0xFFFFFFFF;
}

ArithmeticEncoder.prototype._put = function (b) {
	if (this.n === this.buf.length) {
		var bigger = new Uint8Array(this.buf.length * 2);
		bigger.set(this.buf);
		this.buf = bigger;
	}
	this.buf[this.n++] = b;
};

/** Add one to the bytes already written (base overflowed 2^32). */
ArithmeticEncoder.prototype._carry = function () {
	var p = this.n - 1;
	while (this.buf[p] === 0xFF) { this.buf[p] = 0; p--; }
	this.buf[p]++;
};

ArithmeticEncoder.prototype._add = function (x) {
	var b = this.base + x;
	if (b >= 4294967296) { b -= 4294967296; this._carry(); }
	this.base = b;
};

ArithmeticEncoder.prototype._renorm = function () {
	do {
		this._put(Math.floor(this.base / 16777216));
		this.base = (this.base % 16777216) * 256;
		this.range = (this.range * 256) % 4294967296;
	} while (this.range < AC_MIN_LENGTH);
};

/** Encode one bit with an adaptive binary model. */
ArithmeticEncoder.prototype.encodeBit = function (m, sym) {
	var x = m.bit0Prob * Math.floor(this.range / 8192);   // BM_LENGTH_SHIFT
	if (sym === 0) { this.range = x; m.bit0Count++; }
	else { this._add(x); this.range -= x; }
	if (this.range < AC_MIN_LENGTH) this._renorm();
	if (--m.bitsUntilUpdate === 0) m.update();
};

/** Encode one symbol with an adaptive multi-symbol model. */
ArithmeticEncoder.prototype.encodeSymbol = function (m, sym) {
	var x;
	if (sym === m.lastSymbol) {
		x = m.distribution[sym] * Math.floor(this.range / 32768);   // DM_LENGTH_SHIFT
		this._add(x);
		this.range -= x;
	} else {
		this.range = Math.floor(this.range / 32768);
		x = m.distribution[sym] * this.range;
		this._add(x);
		this.range = m.distribution[sym + 1] * this.range - x;
	}
	if (this.range < AC_MIN_LENGTH) this._renorm();
	m.symbolCount[sym]++;
	if (--m.symbolsUntilUpdate === 0) m.update();
};

/** `bits` raw bits (1-32) of an unsigned Number. */
ArithmeticEncoder.prototype.writeBits = function (bits, sym) {
	if (bits > 19) { this.writeShort(sym % 65536); sym = Math.floor(sym / 65536); bits -= 16; }
	this.range = Math.floor(this.range / Math.pow(2, bits));
	this._add(sym * this.range);
	if (this.range < AC_MIN_LENGTH) this._renorm();
};

/** 16 raw bits. */
ArithmeticEncoder.prototype.writeShort = function (sym) {
	this.range = Math.floor(this.range / 65536);
	this._add(sym * this.range);
	if (this.range < AC_MIN_LENGTH) this._renorm();
};

/** 32 raw bits (low 16 first), from an unsigned Number. */
ArithmeticEncoder.prototype.writeInt = function (sym) {
	this.writeShort(sym % 65536);
	this.writeShort(Math.floor(sym / 65536));
};

/**
 * Flush the coder, as laz-rs done().
 * @returns {Uint8Array} a copy of the bytes written (the encoder is finished)
 */
ArithmeticEncoder.prototype.done = function () {
	var another = true;
	if (this.range > 2 * AC_MIN_LENGTH) { this._add(AC_MIN_LENGTH); this.range = AC_MIN_LENGTH / 2; }
	else { this._add(AC_MIN_LENGTH / 2); this.range = AC_MIN_LENGTH / 512; another = false; }
	this._renorm();
	this._put(0);
	this._put(0);
	if (another) this._put(0);
	return this.buf.slice(0, this.n);
};
