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
// halves, Brent Buffham 2026.
//==========================================================

import { ArithmeticModel } from "../models.js";
import { IntegerDecompressor } from "../IntegerDecompressor.js";

var LE = true;
var MULTI = 500, MULTI_MINUS = -10;
var MULTI_UNCHANGED = MULTI - MULTI_MINUS + 1;   // 511
var MULTI_CODE_FULL = MULTI - MULTI_MINUS + 2;   // 512
var MULTI_TOTAL = MULTI - MULTI_MINUS + 6;       // 516

/** GpsTime11 v2 decompressor: one per chunk. */
export function GpsTime11Decompressor() {
	this.size = 8;
	this.multiModel = new ArithmeticModel(MULTI_TOTAL);
	this.zeroDiffModel = new ArithmeticModel(6);
	this.ic = new IntegerDecompressor(32, 9);
	this.last = 0;
	this.nextSeq = 0;
	this.hi = new Int32Array(4);
	this.lo = new Float64Array(4);              // u32 values, held exactly
	this.diffs = new Int32Array(4);
	this.extremes = new Int32Array(4);
}

GpsTime11Decompressor.prototype._add = function (i, d) {
	var lo = this.lo[i] + d;
	if (lo >= 4294967296) { lo -= 4294967296; this.hi[i] = (this.hi[i] + 1) | 0; }
	else if (lo < 0) { lo += 4294967296; this.hi[i] = (this.hi[i] - 1) | 0; }
	this.lo[i] = lo;
};

GpsTime11Decompressor.prototype._full = function (dec) {
	this.nextSeq = (this.nextSeq + 1) & 3;
	this.hi[this.nextSeq] = this.ic.decompress(dec, this.hi[this.last], 8);
	this.lo[this.nextSeq] = dec.readInt();
	this.last = this.nextSeq;
	this.diffs[this.last] = 0;
	this.extremes[this.last] = 0;
};

// After three extreme differences in a row, the latest becomes the new reference
GpsTime11Decompressor.prototype._extreme = function (d) {
	if (++this.extremes[this.last] > 3) { this.diffs[this.last] = d; this.extremes[this.last] = 0; }
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
					this._extreme(d);
				} else if (multi < MULTI) {
					d = this.ic.decompress(dec, Math.imul(multi, this.diffs[L]), multi < 10 ? 2 : 3);
				} else if (multi === MULTI) {
					d = this.ic.decompress(dec, Math.imul(MULTI, this.diffs[L]), 4);
					this._extreme(d);
				} else {
					multi = MULTI - multi;
					if (multi > MULTI_MINUS) {
						d = this.ic.decompress(dec, Math.imul(multi, this.diffs[L]), 5);
					} else {
						d = this.ic.decompress(dec, Math.imul(MULTI_MINUS, this.diffs[L]), 6);
						this._extreme(d);
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
