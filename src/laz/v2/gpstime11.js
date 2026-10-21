// src/laz/v2/gpstime11.js
//==========================================================
// LASzip GpsTime11 item, version 2: the 8-byte GPS time, coded as its
// raw 64-bit pattern. Up to four time sequences are tracked; each
// point is "same time", a multiple of the last difference (with a
// correction), a jump to another tracked sequence, or a full new time.
// The 64-bit value is held as two 32-bit halves (hi signed, lo
// unsigned) with explicit carry, never as a float.
//
// Ported from laz-rs src/las/gps.rs, module v2 (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2014 martin isenburg,
// rapidlasso; (c) 2014 Uday Verma, Hobu, Inc.; (c) 2019 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, i64 as two u32
// halves, Brent Buffham 2026; the compressor (GpsTime11Compressor) added
// beside the decompressor, rounding its multiplier as LAZperf does.
//==========================================================

import { ArithmeticModel } from "../models.js";
import { IntegerDecompressor } from "../IntegerDecompressor.js";
import { IntegerCompressor } from "../IntegerCompressor.js";

var LE = true;
var MULTI = 500, MULTI_MINUS = -10;
var MULTI_UNCHANGED = MULTI - MULTI_MINUS + 1;   // 511
var MULTI_CODE_FULL = MULTI - MULTI_MINUS + 2;   // 512
var MULTI_TOTAL = MULTI - MULTI_MINUS + 6;       // 516

// The state and models both halves start a chunk with; IC is the integer coder
// (IntegerCompressor or IntegerDecompressor)
function initGps(self, IC) {
	self.size = 8;
	self.multiModel = new ArithmeticModel(MULTI_TOTAL);
	self.zeroDiffModel = new ArithmeticModel(6);
	self.ic = new IC(32, 9);
	self.last = 0;
	self.nextSeq = 0;
	self.hi = new Int32Array(4);
	self.lo = new Float64Array(4);              // u32 values, held exactly
	self.diffs = new Int32Array(4);
	self.extremes = new Int32Array(4);
}

// A full time (hi, lo) starts the next of the four sequences, with no difference yet
function startSequence(self, hi, lo) {
	self.nextSeq = (self.nextSeq + 1) & 3;
	self.hi[self.nextSeq] = hi;
	self.lo[self.nextSeq] = lo;
	self.last = self.nextSeq;
	self.diffs[self.last] = 0;
	self.extremes[self.last] = 0;
}

// After three extreme differences in a row, the latest becomes the new reference
function extreme(self, d) {
	if (++self.extremes[self.last] > 3) { self.diffs[self.last] = d; self.extremes[self.last] = 0; }
}

/** GpsTime11 v2 decompressor: one per chunk. */
export function GpsTime11Decompressor() {
	initGps(this, IntegerDecompressor);
}

GpsTime11Decompressor.prototype._add = function (i, d) {
	var lo = this.lo[i] + d;
	if (lo >= 4294967296) { lo -= 4294967296; this.hi[i] = (this.hi[i] + 1) | 0; }
	else if (lo < 0) { lo += 4294967296; this.hi[i] = (this.hi[i] - 1) | 0; }
	this.lo[i] = lo;
};

GpsTime11Decompressor.prototype._full = function (dec) {
	var hi = this.ic.decompress(dec, this.hi[this.last], 8);
	startSequence(this, hi, dec.readInt());
};

GpsTime11Decompressor.prototype.first = function (src, s, view, o) {
	for (var i = 0; i < 8; i++) view.setUint8(o + i, src[s + i]);
	this.lo[0] = view.getUint32(o, LE);
	this.hi[0] = view.getInt32(o + 4, LE);
};

GpsTime11Decompressor.prototype.next = function (dec, view, o) {
	for (;;) {
		var L = this.last, multi, d;
		if (this.diffs[L] === 0) {
			multi = dec.decodeSymbol(this.zeroDiffModel);
			if (multi === 1) {
				this.diffs[L] = this.ic.decompress(dec, 0, 0);
				this._add(L, this.diffs[L]);
				this.extremes[L] = 0;
			} else if (multi === 2) {
				this._full(dec);
			} else if (multi > 2) {
				this.last = (L + multi - 2) & 3;
				continue;                            // laz-rs recurses: decode again from the new sequence
			}
		} else {
			multi = dec.decodeSymbol(this.multiModel);
			if (multi === 1) {
				this._add(L, this.ic.decompress(dec, this.diffs[L], 1));
				this.extremes[L] = 0;
			} else if (multi < MULTI_UNCHANGED) {
				if (multi === 0) {
					d = this.ic.decompress(dec, 0, 7);
					extreme(this, d);
				} else if (multi < MULTI) {
					d = this.ic.decompress(dec, Math.imul(multi, this.diffs[L]), multi < 10 ? 2 : 3);
				} else if (multi === MULTI) {
					d = this.ic.decompress(dec, Math.imul(MULTI, this.diffs[L]), 4);
					extreme(this, d);
				} else {
					multi = MULTI - multi;
					if (multi > MULTI_MINUS) {
						d = this.ic.decompress(dec, Math.imul(multi, this.diffs[L]), 5);
					} else {
						d = this.ic.decompress(dec, Math.imul(MULTI_MINUS, this.diffs[L]), 6);
						extreme(this, d);
					}
				}
				this._add(L, d);
			} else if (multi === MULTI_CODE_FULL) {
				this._full(dec);
			} else if (multi > MULTI_CODE_FULL) {
				this.last = (L + multi - MULTI_CODE_FULL) & 3;
				continue;
			}
		}
		break;
	}
	view.setUint32(o, this.lo[this.last], LE);
	view.setInt32(o + 4, this.hi[this.last], LE);
};

// The multiplier between this and the last difference, as LAZperf rounds it:
// std::round of the f32 quotient (half away from zero), then (int). LASzip and
// laz-rs add 0.5f in f32 instead, which differs only within an f32 step of a
// half; the fixtures' oracle is LAZperf. The one quotient past i32 (2^31, a last
// difference of +-1) converts as x86 does, to -2^31. Either choice decodes the same.
function quantizeMulti(curr, last) {
	var q = Math.fround(Math.fround(curr) / Math.fround(last));
	var m = q >= 0 ? Math.floor(q + 0.5) : -Math.floor(0.5 - q);
	return m > 2147483647 ? -2147483648 : m;
}

// A DataView over the caller's records, made once per buffer
function viewOf(item, src) {
	if (item._src !== src) { item._src = src; item._view = new DataView(src.buffer, src.byteOffset, src.byteLength); }
	return item._view;
}

/** GpsTime11 v2 compressor: one per chunk, the mirror of GpsTime11Decompressor. */
export function GpsTime11Compressor() {
	initGps(this, IntegerCompressor);
	this._src = null;
	this._view = null;
}


// (hi, lo) minus sequence i as an i32, or null when the 64-bit difference does not fit
GpsTime11Compressor.prototype._diff = function (i, hi, lo) {
	var dl = lo - this.lo[i], dh = hi - this.hi[i];
	if (dl < 0) { dl += 4294967296; dh -= 1; }
	dh = dh | 0;                                 // the high word of the i64 wrapping_sub
	if (dh === 0 && dl < 2147483648) return dl;
	if (dh === -1 && dl >= 2147483648) return dl - 4294967296;
	return null;
};

// The first other sequence (1-3 on from the last) this time is within i32 of, or 0
GpsTime11Compressor.prototype._other = function (hi, lo) {
	for (var i = 1; i < 4; i++) if (this._diff((this.last + i) & 3, hi, lo) !== null) return i;
	return 0;
};

GpsTime11Compressor.prototype._full = function (enc, hi, lo) {
	this.ic.compress(enc, this.hi[this.last], hi, 8);
	enc.writeInt(lo);
	startSequence(this, hi, lo);
};

GpsTime11Compressor.prototype.first = function (src, s) {
	var v = viewOf(this, src);
	this.lo[0] = v.getUint32(s, LE);
	this.hi[0] = v.getInt32(s + 4, LE);
};

GpsTime11Compressor.prototype.next = function (enc, src, s) {
	var v = viewOf(this, src);
	var lo = v.getUint32(s, LE), hi = v.getInt32(s + 4, LE);
	for (;;) {
		var L = this.last, d, j, multi;
		if (hi === this.hi[L] && lo === this.lo[L]) {
			if (this.diffs[L] === 0) enc.encodeSymbol(this.zeroDiffModel, 0);
			else enc.encodeSymbol(this.multiModel, MULTI_UNCHANGED);
			return;
		}
		d = this._diff(L, hi, lo);
		if (this.diffs[L] === 0) {
			if (d !== null) {
				enc.encodeSymbol(this.zeroDiffModel, 1);
				this.ic.compress(enc, 0, d, 0);
				this.diffs[L] = d;
				this.extremes[L] = 0;
			} else if ((j = this._other(hi, lo))) {
				enc.encodeSymbol(this.zeroDiffModel, j + 2);
				this.last = (L + j) & 3;
				continue;                            // laz-rs recurses: code again against the new sequence
			} else {
				enc.encodeSymbol(this.zeroDiffModel, 2);
				this._full(enc, hi, lo);
			}
		} else if (d !== null) {
			multi = quantizeMulti(d, this.diffs[L]);
			if (multi === 1) {
				enc.encodeSymbol(this.multiModel, 1);
				this.ic.compress(enc, this.diffs[L], d, 1);
				this.extremes[L] = 0;
			} else if (multi > 0) {
				if (multi < MULTI) {
					enc.encodeSymbol(this.multiModel, multi);
					this.ic.compress(enc, Math.imul(multi, this.diffs[L]), d, multi < 10 ? 2 : 3);
				} else {
					enc.encodeSymbol(this.multiModel, MULTI);
					this.ic.compress(enc, Math.imul(MULTI, this.diffs[L]), d, 4);
					extreme(this, d);
				}
			} else if (multi < 0) {
				if (multi > MULTI_MINUS) {
					enc.encodeSymbol(this.multiModel, MULTI - multi);
					this.ic.compress(enc, Math.imul(multi, this.diffs[L]), d, 5);
				} else {
					enc.encodeSymbol(this.multiModel, MULTI - MULTI_MINUS);
					this.ic.compress(enc, Math.imul(MULTI_MINUS, this.diffs[L]), d, 6);
					extreme(this, d);
				}
			} else {
				enc.encodeSymbol(this.multiModel, 0);
				this.ic.compress(enc, 0, d, 7);
				extreme(this, d);
			}
		} else if ((j = this._other(hi, lo))) {
			enc.encodeSymbol(this.multiModel, MULTI_CODE_FULL + j);
			this.last = (L + j) & 3;
			continue;
		} else {
			enc.encodeSymbol(this.multiModel, MULTI_CODE_FULL);
			this._full(enc, hi, lo);
		}
		this.hi[this.last] = hi;
		this.lo[this.last] = lo;
		return;
	}
};
