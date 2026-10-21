// src/laz/v3/point14.js
//==========================================================
// LASzip Point14 item, versions 3 and 4 (LAS 1.4 point formats 6-10):
// the 30-byte extended record, coded in nine LAYERS — channel/returns/
// XY, Z, classification, flags, intensity, scan angle, user data,
// point source, GPS time — each its own arithmetic stream, so a layer
// that never changes in a chunk costs nothing (size 0: the value stays
// the last one). Up to four contexts follow the scanner channel. The
// compressor and decompressor below share each context's models,
// medians and coders (Context), so they stay in step point for point.
//
// Ported from laz-rs src/las/point6.rs, module v3_v4, and the 16x16
// return tables of src/las/utils.rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2015 martin isenburg,
// rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, working on raw
// record bytes, GPS time as two u32 halves, Brent Buffham 2026; the
// compressor (Point14Compressor) added beside the decompressor, sharing
// its contexts, deciding which layers to write as LAZperf
// (hobuinc/laz-perf, field_point14.cpp) does, with one change: a GPS
// time is "changed" when its bits differ (or it is NaN), so -0 after +0
// survives, where LAZperf's double compare would drop the sign.
//==========================================================

import { ArithmeticDecoder } from "../ArithmeticDecoder.js";
import { ArithmeticEncoder } from "../ArithmeticEncoder.js";
import { ArithmeticModel } from "../models.js";
import { IntegerDecompressor } from "../IntegerDecompressor.js";
import { IntegerCompressor } from "../IntegerCompressor.js";
import { StreamingMedian, yContext, zContext } from "../v2/point10.js";
import { quantizeMulti, diff32 } from "../v2/gpstime11.js";

var LE = true;
var MULTI = 500, MULTI_MINUS = -10;
var CODE_FULL = MULTI - MULTI_MINUS + 1;   // 511
var MULTI_TOTAL = MULTI - MULTI_MINUS + 5; // 515

/** NUMBER_RETURN_MAP_6CTX[n][r] (LASzip). */
var MAP_6CTX = [
	[0, 1, 2, 3, 4, 5, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5], [1, 0, 1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
	[2, 1, 2, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3], [3, 3, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
	[4, 3, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4], [5, 3, 4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
	[3, 3, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4], [4, 3, 4, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4],
	[4, 3, 4, 4, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4], [5, 3, 4, 4, 4, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4, 4],
	[5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4], [5, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 4, 4, 4],
	[5, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 4, 4], [5, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 4],
	[5, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5], [5, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5]
];
/** NUMBER_RETURN_LEVEL_8CT[n][r] (LASzip): |n - r|, capped at 7. */
var LEVEL_8CT = [];
for (var ln = 0; ln < 16; ln++) { LEVEL_8CT.push([]); for (var lr = 0; lr < 16; lr++) LEVEL_8CT[ln].push(Math.min(7, Math.abs(ln - lr))); }

function medians(n) { var out = []; for (var i = 0; i < n; i++) out.push(new StreamingMedian()); return out; }

// One record's fields from a view (into q, or a new object)
function readPoint14(v, o, q) {
	q = q || {};
	q.x = v.getInt32(o, LE); q.y = v.getInt32(o + 4, LE); q.z = v.getInt32(o + 8, LE);
	q.intensity = v.getUint16(o + 12, LE); q.bits = v.getUint8(o + 14); q.flags = v.getUint8(o + 15);
	q.cls = v.getUint8(o + 16); q.user = v.getUint8(o + 17); q.angle = v.getInt16(o + 18, LE);
	q.psid = v.getUint16(o + 20, LE); q.gpsLo = v.getUint32(o + 22, LE); q.gpsHi = v.getInt32(o + 26, LE);
	return q;
}

// One context's state, started from the last point of another (laz-rs from_last_point);
// IC is the integer coder (IntegerCompressor or IntegerDecompressor), so both halves get
// the same widths and contexts
function Context(p, IC) {
	this.unused = false;
	this.p = { x: p.x, y: p.y, z: p.z, intensity: p.intensity, bits: p.bits, flags: p.flags, cls: p.cls, angle: p.angle, user: p.user, psid: p.psid, gpsHi: p.gpsHi, gpsLo: p.gpsLo, gpsChange: false };
	this.lastIntensity = new Uint16Array(8).fill(p.intensity);
	this.xMedian = medians(12);
	this.yMedian = medians(12);
	this.lastZ = new Int32Array(8).fill(p.z);
	this.changed = []; for (var i = 0; i < 8; i++) this.changed.push(new ArithmeticModel(128));
	this.channel = new ArithmeticModel(3);
	this.nret = new Array(16);
	this.rnum = new Array(16);
	this.rnumGpsSame = new ArithmeticModel(13);
	this.clsM = new Array(64);
	this.flagsM = new Array(64);
	this.userM = new Array(64);
	this.gpsMulti = new ArithmeticModel(MULTI_TOTAL);
	this.gpsNoDiff = new ArithmeticModel(5);
	this.icDx = new IC(32, 2);
	this.icDy = new IC(32, 22);
	this.icZ = new IC(32, 20);
	this.icIntensity = new IC(16, 4);
	this.icAngle = new IC(16, 2);
	this.icPsid = new IC(16, 1);
	this.icGps = new IC(32, 9);
	this.gLast = 0; this.gNext = 0;
	this.gHi = new Int32Array(4); this.gLo = new Float64Array(4);
	this.gHi[0] = p.gpsHi; this.gLo[0] = p.gpsLo;
	this.gDiff = new Int32Array(4);
	this.gExtreme = new Int32Array(4);
}

function lazy(arr, i, symbols) { return arr[i] || (arr[i] = new ArithmeticModel(symbols)); }

// The changed-values model context from the last point: single / first / last / intermediate,
// and whether its GPS time changed
function lastReturnContext(p) {
	var r = p.bits & 15, n = p.bits >>> 4;
	return (r === 1 ? 1 : 0) + (r >= n ? 2 : 0) + (p.gpsChange ? 4 : 0);
}

// The flags symbol: classification flags (bits 0-3), scan direction (4), edge of flight line (5)
// — the flags byte without the scanner channel, which layer 0 codes
function flagsSymbol(flags) { return ((flags >>> 7) & 1) * 32 + ((flags >>> 6) & 1) * 16 + (flags & 15); }

Context.prototype.addGps = function (i, d) {
	var lo = this.gLo[i] + d;
	if (lo >= 4294967296) { lo -= 4294967296; this.gHi[i] = (this.gHi[i] + 1) | 0; }
	else if (lo < 0) { lo += 4294967296; this.gHi[i] = (this.gHi[i] - 1) | 0; }
	this.gLo[i] = lo;
};
// A full time (hi, lo) starts the next of the four sequences, with no difference yet
Context.prototype.startGps = function (hi, lo) {
	this.gNext = (this.gNext + 1) & 3;
	this.gHi[this.gNext] = hi;
	this.gLo[this.gNext] = lo;
	this.gLast = this.gNext;
	this.gDiff[this.gLast] = 0;
	this.gExtreme[this.gLast] = 0;
};
Context.prototype.fullGps = function (dec) {
	var hi = this.icGps.decompress(dec, this.gHi[this.gLast], 8);
	this.startGps(hi, dec.readInt());
};
// After three extreme differences in a row, the latest becomes the new reference
Context.prototype.extremeGps = function (d) {
	if (++this.gExtreme[this.gLast] > 3) { this.gDiff[this.gLast] = d; this.gExtreme[this.gLast] = 0; }
};
// laz-rs read_gps_time (the 1.4 variant: no "unchanged" code, full = 511)
Context.prototype.readGps = function (dec) {
	for (;;) {
		var L = this.gLast, multi, d;
		if (this.gDiff[L] === 0) {
			multi = dec.decodeSymbol(this.gpsNoDiff);
			if (multi === 0) {
				this.gDiff[L] = this.icGps.decompress(dec, 0, 0);
				this.addGps(L, this.gDiff[L]);
				this.gExtreme[L] = 0;
			} else if (multi === 1) {
				this.fullGps(dec);
			} else {
				this.gLast = (L + multi - 1) & 3;
				continue;
			}
		} else {
			multi = dec.decodeSymbol(this.gpsMulti);
			if (multi === 1) {
				this.addGps(L, this.icGps.decompress(dec, this.gDiff[L], 1));
				this.gExtreme[L] = 0;
			} else if (multi < CODE_FULL) {
				if (multi === 0) {
					d = this.icGps.decompress(dec, 0, 7);
					this.extremeGps(d);
				} else if (multi < MULTI) {
					d = this.icGps.decompress(dec, Math.imul(multi, this.gDiff[L]), multi < 10 ? 2 : 3);
				} else if (multi === MULTI) {
					d = this.icGps.decompress(dec, Math.imul(MULTI, this.gDiff[L]), 4);
					this.extremeGps(d);
				} else {
					multi = MULTI - multi;
					if (multi > MULTI_MINUS) {
						d = this.icGps.decompress(dec, Math.imul(multi, this.gDiff[L]), 5);
					} else {
						d = this.icGps.decompress(dec, Math.imul(MULTI_MINUS, this.gDiff[L]), 6);
						this.extremeGps(d);
					}
				}
				this.addGps(L, d);
			} else if (multi === CODE_FULL) {
				this.fullGps(dec);
			} else {
				this.gLast = (L + multi - CODE_FULL) & 3;
				continue;
			}
		}
		return;
	}
};

// The first other sequence (1-3 on from the last) the time (hi, lo) is within i32 of, or 0
Context.prototype.otherGps = function (hi, lo) {
	for (var i = 1; i < 4; i++) { var j = (this.gLast + i) & 3; if (diff32(hi, lo, this.gHi[j], this.gLo[j]) !== null) return i; }
	return 0;
};
Context.prototype.writeFullGps = function (enc, hi, lo) {
	this.icGps.compress(enc, this.gHi[this.gLast], hi, 8);
	enc.writeInt(lo);
	this.startGps(hi, lo);
};
// The mirror of readGps (LAZperf encodeGpsTime): the time (hi, lo), known to have changed
Context.prototype.writeGps = function (enc, hi, lo) {
	for (;;) {
		var L = this.gLast, d = diff32(hi, lo, this.gHi[L], this.gLo[L]), j, multi;
		if (this.gDiff[L] === 0) {
			if (d !== null) {
				enc.encodeSymbol(this.gpsNoDiff, 0);
				this.icGps.compress(enc, 0, d, 0);
				this.gDiff[L] = d;
				this.gExtreme[L] = 0;
			} else if ((j = this.otherGps(hi, lo))) {
				enc.encodeSymbol(this.gpsNoDiff, j + 1);
				this.gLast = (L + j) & 3;
				continue;                            // code again against the other sequence
			} else {
				enc.encodeSymbol(this.gpsNoDiff, 1);
				this.writeFullGps(enc, hi, lo);
			}
		} else if (d !== null) {
			multi = quantizeMulti(d, this.gDiff[L]);
			if (multi > 0 && multi < MULTI) {
				enc.encodeSymbol(this.gpsMulti, multi);
				this.icGps.compress(enc, Math.imul(multi, this.gDiff[L]), d, multi === 1 ? 1 : multi < 10 ? 2 : 3);
				if (multi === 1) this.gExtreme[L] = 0;
			} else if (multi >= MULTI) {
				enc.encodeSymbol(this.gpsMulti, MULTI);
				this.icGps.compress(enc, Math.imul(MULTI, this.gDiff[L]), d, 4);
				this.extremeGps(d);
			} else if (multi < 0 && multi > MULTI_MINUS) {
				enc.encodeSymbol(this.gpsMulti, MULTI - multi);
				this.icGps.compress(enc, Math.imul(multi, this.gDiff[L]), d, 5);
			} else if (multi < 0) {
				enc.encodeSymbol(this.gpsMulti, MULTI - MULTI_MINUS);
				this.icGps.compress(enc, Math.imul(MULTI_MINUS, this.gDiff[L]), d, 6);
				this.extremeGps(d);
			} else {
				enc.encodeSymbol(this.gpsMulti, 0);
				this.icGps.compress(enc, 0, d, 7);
				this.extremeGps(d);
			}
		} else if ((j = this.otherGps(hi, lo))) {
			enc.encodeSymbol(this.gpsMulti, CODE_FULL + j);
			this.gLast = (L + j) & 3;
			continue;
		} else {
			enc.encodeSymbol(this.gpsMulti, CODE_FULL);
			this.writeFullGps(enc, hi, lo);
		}
		this.gHi[this.gLast] = hi;
		this.gLo[this.gLast] = lo;
		return;
	}
};

var LAYERS = 9;   // channel/returns/xy, z, classification, flags, intensity, scan angle, user data, point source, gps time

/**
 * Point14 decompressor: one per chunk.
 * @param {number} version - LASzip item version, 3 or 4 (they pass the scanner channel on differently)
 */
export function Point14Decompressor(version) {
	this.size = 30;
	this.version = version;
	this.contexts = [null, null, null, null];
	this.current = 0;
	this.sizes = new Array(LAYERS);
	this.dec = new Array(LAYERS);
	this.on = new Array(LAYERS);
}

Point14Decompressor.prototype.first = function (src, s, view, o, ctx) {
	for (var i = 0; i < 30; i++) view.setUint8(o + i, src[s + i]);
	var p = readPoint14(view, o);
	this.current = (p.flags >>> 4) & 3;
	this.contexts = [null, null, null, null];
	this.contexts[this.current] = new Context(p, IntegerDecompressor);
	ctx.v = this.current;
};

Point14Decompressor.prototype.readLayerSizes = function (dv, q) {
	for (var i = 0; i < LAYERS; i++) { this.sizes[i] = dv.getUint32(q, LE); q += 4; }
	return q;
};

Point14Decompressor.prototype.readLayers = function (bytes, q, e, fail, base) {
	if (this.sizes[0] === 0) fail(q);   // channel / returns / XY is coded for every point after the first
	for (var i = 0; i < LAYERS; i++) {
		var n = this.sizes[i];
		if (q + n > e) fail(q);
		this.on[i] = n > 0;
		if (n > 0) { this.dec[i] = new ArithmeticDecoder(bytes, q, q + n, base); this.dec[i].readInitBytes(); }
		q += n;
	}
	return q;
};

Point14Decompressor.prototype.next = function (view, o, ctx) {
	var c = this.contexts[this.current];
	var p = c.p, d0 = this.dec[0];
	var changed = d0.decodeSymbol(c.changed[lastReturnContext(p)]);
	if (changed & 64) {
		var channel = (this.current + d0.decodeSymbol(c.channel) + 1) % 4;
		if (!this.contexts[channel]) this.contexts[channel] = new Context(p, IntegerDecompressor);
		this.current = channel;
		if (this.version === 3) ctx.v = channel;
		c = this.contexts[channel];
		p = c.p;
		p.flags = (p.flags & 0xCF) | (channel << 4);
	}
	if (this.version !== 3) ctx.v = this.current;
	var psidChanged = changed & 32, gpsChanged = changed & 16 ? 1 : 0, angleChanged = changed & 8;
	var lastN = p.bits >>> 4, lastR = p.bits & 15, n, r;
	n = changed & 4 ? d0.decodeSymbol(lazy(c.nret, lastN, 16)) : lastN;
	var low = changed & 3;
	if (low === 0) r = lastR;
	else if (low === 1) r = (lastR + 1) % 16;
	else if (low === 2) r = (lastR + 15) % 16;
	else if (gpsChanged) r = d0.decodeSymbol(lazy(c.rnum, lastR, 16));
	else r = (lastR + d0.decodeSymbol(c.rnumGpsSame) + 2) % 16;
	p.bits = r + n * 16;
	var m = MAP_6CTX[n][r], l = LEVEL_8CT[n][r];
	var cpr = (r === 1 ? 2 : 0) + (r >= n ? 1 : 0);
	var single = n === 1 ? 1 : 0;
	var idx = m * 2 + gpsChanged;
	var diff = c.icDx.decompress(d0, c.xMedian[idx].get(), single);
	p.x = (p.x + diff) | 0;
	c.xMedian[idx].add(diff);
	diff = c.icDy.decompress(d0, c.yMedian[idx].get(), yContext(single, c.icDx));
	p.y = (p.y + diff) | 0;
	c.yMedian[idx].add(diff);
	if (this.on[1]) {
		p.z = c.icZ.decompress(this.dec[1], c.lastZ[l], zContext(single, c.icDx, c.icDy));
		c.lastZ[l] = p.z;
	}
	if (this.on[2]) p.cls = this.dec[2].decodeSymbol(lazy(c.clsM, (p.cls & 31) * 2 + (cpr === 3 ? 1 : 0), 256));
	if (this.on[3]) {
		var f = this.dec[3].decodeSymbol(lazy(c.flagsM, flagsSymbol(p.flags), 64));
		p.flags = ((f >>> 5) & 1) * 128 + ((f >>> 4) & 1) * 64 + (p.flags & 0x30) + (f & 15);
	}
	if (this.on[4]) {
		var ii = cpr * 2 + gpsChanged;
		p.intensity = c.icIntensity.decompress(this.dec[4], c.lastIntensity[ii], cpr) & 0xFFFF;
		c.lastIntensity[ii] = p.intensity;
	}
	if (this.on[5] && angleChanged) p.angle = (c.icAngle.decompress(this.dec[5], p.angle, gpsChanged) << 16) >> 16;   // as i16
	if (this.on[6]) p.user = this.dec[6].decodeSymbol(lazy(c.userM, Math.floor(p.user / 4), 256));
	if (this.on[7] && psidChanged) p.psid = c.icPsid.decompress(this.dec[7], p.psid, 0) & 0xFFFF;
	p.gpsChange = !!gpsChanged;
	if (this.on[8] && gpsChanged) {
		c.readGps(this.dec[8]);
		p.gpsHi = c.gHi[c.gLast]; p.gpsLo = c.gLo[c.gLast];
	}
	view.setInt32(o, p.x, LE); view.setInt32(o + 4, p.y, LE); view.setInt32(o + 8, p.z, LE);
	view.setUint16(o + 12, p.intensity, LE);
	view.setUint8(o + 14, p.bits);
	view.setUint8(o + 15, p.flags);
	view.setUint8(o + 16, p.cls);
	view.setUint8(o + 17, p.user);
	view.setInt16(o + 18, p.angle, LE);
	view.setUint16(o + 20, p.psid, LE);
	view.setUint32(o + 22, p.gpsLo, LE);
	view.setInt32(o + 26, p.gpsHi, LE);
};

// A DataView over the caller's records, made once per buffer
function viewOf(item, src) {
	if (item._src !== src) { item._src = src; item._view = new DataView(src.buffer, src.byteOffset, src.byteLength); }
	return item._view;
}

// Whether a point's GPS time changed from the last: its bits differ, or it is NaN (a NaN never
// equals itself, as LAZperf's double compare has it). Unlike that compare, -0 and +0 differ.
function gpsChangedFrom(p, q) {
	if (q.gpsHi !== p.gpsHi || q.gpsLo !== p.gpsLo) return true;
	return (q.gpsHi & 0x7FF00000) === 0x7FF00000 && ((q.gpsHi & 0xFFFFF) !== 0 || q.gpsLo !== 0);
}

/**
 * Point14 compressor: one per chunk, the mirror of Point14Decompressor. Each layer has its own
 * encoder; channel/returns/XY and Z are always written, the others once a value changes (LAZperf).
 * @param {number} version - LASzip item version, 3 or 4
 */
export function Point14Compressor(version) {
	this.size = 30;
	this.version = version;
	this.contexts = [null, null, null, null];
	this.current = 0;
	this.enc = [];
	this.used = [];
	for (var i = 0; i < LAYERS; i++) { this.enc.push(new ArithmeticEncoder()); this.used.push(i < 2); }
	this.q = {};
	this._src = null;
	this._view = null;
}

/** The first point of a chunk is stored raw; it starts its channel's context. */
Point14Compressor.prototype.first = function (src, s, ctx) {
	var p = readPoint14(viewOf(this, src), s);
	this.current = (p.flags >>> 4) & 3;
	this.contexts[this.current] = new Context(p, IntegerCompressor);
	ctx.v = this.current;
};

Point14Compressor.prototype.next = function (src, s, ctx) {
	var q = readPoint14(viewOf(this, src), s, this.q);
	var prev = this.contexts[this.current], sc = (q.flags >>> 4) & 3;
	var c = this.contexts[sc];
	// the last point of this channel, or (a channel not seen yet) of the last one
	var p = c ? c.p : prev.p, e0 = this.enc[0];
	var gpsChanged = gpsChangedFrom(p, q) ? 1 : 0;
	var psidChanged = q.psid !== p.psid, angleChanged = q.angle !== p.angle;
	var lastN = p.bits >>> 4, lastR = p.bits & 15, n = q.bits >>> 4, r = q.bits & 15;
	var low = r === lastR ? 0 : r === (lastR + 1) % 16 ? 1 : r === (lastR + 15) % 16 ? 2 : 3;
	var changed = (sc !== this.current ? 64 : 0) + (psidChanged ? 32 : 0) + gpsChanged * 16 + (angleChanged ? 8 : 0) + (n !== lastN ? 4 : 0) + low;
	e0.encodeSymbol(prev.changed[lastReturnContext(prev.p)], changed);
	if (changed & 64) {
		e0.encodeSymbol(prev.channel, (sc - this.current + 3) % 4);
		if (!c) { c = this.contexts[sc] = new Context(prev.p, IntegerCompressor); p = c.p; }
		this.current = sc;
		if (this.version === 3) ctx.v = sc;
	}
	if (this.version !== 3) ctx.v = this.current;
	if (changed & 4) e0.encodeSymbol(lazy(c.nret, lastN, 16), n);
	if (low === 3) {
		if (gpsChanged) e0.encodeSymbol(lazy(c.rnum, lastR, 16), r);
		else e0.encodeSymbol(c.rnumGpsSame, (r - lastR + 14) % 16);   // r - lastR - 2, mod 16
	}
	var m = MAP_6CTX[n][r], l = LEVEL_8CT[n][r];
	var cpr = (r === 1 ? 2 : 0) + (r >= n ? 1 : 0);
	var single = n === 1 ? 1 : 0;
	var idx = m * 2 + gpsChanged;
	var diff = (q.x - p.x) | 0;              // i32 wrapping_sub
	c.icDx.compress(e0, c.xMedian[idx].get(), diff, single);
	c.xMedian[idx].add(diff);
	diff = (q.y - p.y) | 0;
	c.icDy.compress(e0, c.yMedian[idx].get(), diff, yContext(single, c.icDx));
	c.yMedian[idx].add(diff);
	c.icZ.compress(this.enc[1], c.lastZ[l], q.z, zContext(single, c.icDx, c.icDy));
	c.lastZ[l] = q.z;
	var used = this.used;
	if (q.cls !== p.cls) used[2] = true;
	this.enc[2].encodeSymbol(lazy(c.clsM, (p.cls & 31) * 2 + (cpr === 3 ? 1 : 0), 256), q.cls);
	var lastF = flagsSymbol(p.flags), f = flagsSymbol(q.flags);
	if (f !== lastF) used[3] = true;
	this.enc[3].encodeSymbol(lazy(c.flagsM, lastF, 64), f);
	var ii = cpr * 2 + gpsChanged;
	if (q.intensity !== p.intensity) used[4] = true;
	c.icIntensity.compress(this.enc[4], c.lastIntensity[ii], q.intensity, cpr);
	c.lastIntensity[ii] = q.intensity;
	if (angleChanged) { used[5] = true; c.icAngle.compress(this.enc[5], p.angle, q.angle, gpsChanged); }
	if (q.user !== p.user) used[6] = true;
	this.enc[6].encodeSymbol(lazy(c.userM, Math.floor(p.user / 4), 256), q.user);
	if (psidChanged) { used[7] = true; c.icPsid.compress(this.enc[7], p.psid, q.psid, 0); }
	if (gpsChanged) { used[8] = true; c.writeGps(this.enc[8], q.gpsHi, q.gpsLo); }
	p.x = q.x; p.y = q.y; p.z = q.z; p.intensity = q.intensity; p.bits = q.bits; p.flags = q.flags;
	p.cls = q.cls; p.angle = q.angle; p.user = q.user; p.psid = q.psid; p.gpsHi = q.gpsHi; p.gpsLo = q.gpsLo;
	p.gpsChange = gpsChanged === 1;
};

/**
 * Finish the chunk's layers.
 * @returns {Array<Uint8Array>} the nine layers in readLayerSizes order; an unchanged layer is empty
 */
Point14Compressor.prototype.finish = function () {
	var out = [];
	for (var i = 0; i < LAYERS; i++) out.push(this.used[i] ? this.enc[i].done() : new Uint8Array(0));
	return out;
};
