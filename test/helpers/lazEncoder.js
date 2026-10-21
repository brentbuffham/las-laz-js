// test/helpers/lazEncoder.js
//==========================================================
// TEST-ONLY LASzip arithmetic ENCODER and integer compressor, so the
// decoder can be checked by round trips. Ported from laz-rs
// src/encoders.rs and src/compressors.rs (Apache-2.0; see NOTICE), but
// written into a growable byte array instead of laz-rs's ring buffer.
// The models are the library's: the encoder and decoder must share
// them, as LASzip's do. Ships nowhere (test/ is not in the package).
//==========================================================
/* prettier-ignore-file */
import { ArithmeticModel, ArithmeticBitModel } from "../../src/laz/models.js";

var AC_MIN_LENGTH = 0x01000000;

export function ArithmeticEncoder() {
	this.out = [];
	this.base = 0;
	this.range = 0xFFFFFFFF;
}

ArithmeticEncoder.prototype._carry = function () {
	var p = this.out.length - 1;
	while (this.out[p] === 0xFF) { this.out[p] = 0; p--; }
	this.out[p]++;
};
ArithmeticEncoder.prototype._add = function (x) {
	var b = this.base + x;
	if (b >= 4294967296) { b -= 4294967296; this._carry(); }
	this.base = b;
};
ArithmeticEncoder.prototype._renorm = function () {
	do {
		this.out.push(Math.floor(this.base / 16777216));
		this.base = (this.base % 16777216) * 256;
		this.range = (this.range * 256) % 4294967296;
	} while (this.range < AC_MIN_LENGTH);
};

ArithmeticEncoder.prototype.encodeBit = function (m, sym) {
	var x = m.bit0Prob * Math.floor(this.range / 8192);
	if (sym === 0) { this.range = x; m.bit0Count++; }
	else { this._add(x); this.range -= x; }
	if (this.range < AC_MIN_LENGTH) this._renorm();
	if (--m.bitsUntilUpdate === 0) m.update();
};

ArithmeticEncoder.prototype.encodeSymbol = function (m, sym) {
	var x;
	if (sym === m.lastSymbol) {
		x = m.distribution[sym] * Math.floor(this.range / 32768);
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

ArithmeticEncoder.prototype.writeBits = function (bits, sym) {
	if (bits > 19) { this.writeShort(sym % 65536); sym = Math.floor(sym / 65536); bits -= 16; }
	this.range = Math.floor(this.range / Math.pow(2, bits));
	this._add(sym * this.range);
	if (this.range < AC_MIN_LENGTH) this._renorm();
};
ArithmeticEncoder.prototype.writeShort = function (sym) {
	this.range = Math.floor(this.range / 65536);
	this._add(sym * this.range);
	if (this.range < AC_MIN_LENGTH) this._renorm();
};
ArithmeticEncoder.prototype.writeInt = function (sym) { this.writeShort(sym % 65536); this.writeShort(Math.floor(sym / 65536)); };

/** Flush, as laz-rs done(): returns the stream bytes. */
ArithmeticEncoder.prototype.done = function () {
	var another = true;
	if (this.range > 2 * AC_MIN_LENGTH) { this._add(AC_MIN_LENGTH); this.range = AC_MIN_LENGTH / 2; }
	else { this._add(AC_MIN_LENGTH / 2); this.range = AC_MIN_LENGTH / 512; another = false; }
	this._renorm();
	this.out.push(0, 0);
	if (another) this.out.push(0);
	return Uint8Array.from(this.out);
};

export function IntegerCompressor(bits, contexts, bitsHigh) {
	bits = bits === undefined ? 16 : bits;
	this.contexts = contexts === undefined ? 1 : contexts;
	this.bitsHigh = bitsHigh === undefined ? 8 : bitsHigh;
	if (bits && bits < 32) {
		this.corrBits = bits; this.corrRange = Math.pow(2, bits);
		this.corrMin = -this.corrRange / 2; this.corrMax = this.corrMin + this.corrRange - 1;
	} else {
		this.corrBits = 32; this.corrRange = 0; this.corrMin = -2147483648; this.corrMax = 2147483647;
	}
	this.mBits = [];
	for (var c = 0; c < this.contexts; c++) this.mBits.push(new ArithmeticModel(this.corrBits + 1));
	this.mCorrector0 = new ArithmeticBitModel();
	this.mCorrector = [];
	for (var i = 1; i <= this.corrBits; i++) this.mCorrector.push(new ArithmeticModel(Math.pow(2, i <= this.bitsHigh ? i : this.bitsHigh)));
	this.k = 0;
}

IntegerCompressor.prototype.compress = function (enc, pred, real, context) {
	var corr = (real - pred) | 0;
	if (corr < this.corrMin) corr += this.corrRange;
	else if (corr > this.corrMax) corr -= this.corrRange;
	var c1 = corr <= 0 ? -corr : corr - 1, k = 0;
	while (c1 >= 1) { c1 = Math.floor(c1 / 2); k++; }
	this.k = k;
	enc.encodeSymbol(this.mBits[context], k);
	if (k !== 0) {
		if (k < 32) {
			var c = corr >= 0 ? corr - 1 : corr + Math.pow(2, k) - 1;
			if (k <= this.bitsHigh) enc.encodeSymbol(this.mCorrector[k - 1], c);
			else {
				var k1 = k - this.bitsHigh, low = c % Math.pow(2, k1);
				enc.encodeSymbol(this.mCorrector[k - 1], Math.floor(c / Math.pow(2, k1)));
				enc.writeBits(k1, low);
			}
		}
	} else {
		enc.encodeBit(this.mCorrector0, corr);
	}
};
