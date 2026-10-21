// src/laz/v3/point14.js
//==========================================================
// LASzip Point14 item, versions 3 and 4 (LAS 1.4 point formats 6-10):
// the 30-byte extended record, coded in nine LAYERS — channel/returns/
// XY, Z, classification, flags, intensity, scan angle, user data,
// point source, GPS time — each its own arithmetic stream, so a layer
// that never changes in a chunk costs nothing (size 0: the value stays
// the last one). Up to four contexts follow the scanner channel.
//
// Ported from laz-rs src/las/point6.rs, module v3_v4, and the 16x16
// return tables of src/las/utils.rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2015 martin isenburg,
// rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, working on raw
// record bytes, GPS time as two u32 halves, Brent Buffham 2026.
//==========================================================

import { ArithmeticDecoder } from "../ArithmeticDecoder.js";
import { ArithmeticModel } from "../models.js";
import { IntegerDecompressor } from "../IntegerDecompressor.js";
import { StreamingMedian } from "../v2/point10.js";

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

// One context's state, started from the last point of another (laz-rs from_last_point)
function Context(p) {
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
	this.icDx = new IntegerDecompressor(32, 2);
	this.icDy = new IntegerDecompressor(32, 22);
	this.icZ = new IntegerDecompressor(32, 20);
	this.icIntensity = new IntegerDecompressor(16, 4);
	this.icAngle = new IntegerDecompressor(16, 2);
	this.icPsid = new IntegerDecompressor(16, 1);
	this.icGps = new IntegerDecompressor(32, 9);
	this.gLast = 0; this.gNext = 0;
	this.gHi = new Int32Array(4); this.gLo = new Float64Array(4);
	this.gHi[0] = p.gpsHi; this.gLo[0] = p.gpsLo;
	this.gDiff = new Int32Array(4);
	this.gExtreme = new Int32Array(4);
}

function lazy(arr, i, symbols) { return arr[i] || (arr[i] = new ArithmeticModel(symbols)); }

Context.prototype.addGps = function (i, d) {
	var lo = this.gLo[i] + d;
	if (lo >= 4294967296) { lo -= 4294967296; this.gHi[i] = (this.gHi[i] + 1) | 0; }
	else if (lo < 0) { lo += 4294967296; this.gHi[i] = (this.gHi[i] - 1) | 0; }
	this.gLo[i] = lo;
};
Context.prototype.fullGps = function (dec) {
	this.gNext = (this.gNext + 1) & 3;
	this.gHi[this.gNext] = this.icGps.decompress(dec, this.gHi[this.gLast], 8);
	this.gLo[this.gNext] = dec.readInt();
	this.gLast = this.gNext;
	this.gDiff[this.gLast] = 0;
	this.gExtreme[this.gLast] = 0;
};
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
	var p = {
		x: view.getInt32(o, LE), y: view.getInt32(o + 4, LE), z: view.getInt32(o + 8, LE),
		intensity: view.getUint16(o + 12, LE), bits: view.getUint8(o + 14), flags: view.getUint8(o + 15),
		cls: view.getUint8(o + 16), user: view.getUint8(o + 17), angle: view.getInt16(o + 18, LE),
		psid: view.getUint16(o + 20, LE), gpsLo: view.getUint32(o + 22, LE), gpsHi: view.getInt32(o + 26, LE)
	};
	this.current = (p.flags >>> 4) & 3;
	this.contexts = [null, null, null, null];
	this.contexts[this.current] = new Context(p);
	ctx.v = this.current;
};

Point14Decompressor.prototype.readLayerSizes = function (dv, q) {
	for (var i = 0; i < LAYERS; i++) { this.sizes[i] = dv.getUint32(q, LE); q += 4; }
	return q;
};

Point14Decompressor.prototype.readLayers = function (bytes, q, e, fail) {
	for (var i = 0; i < LAYERS; i++) {
		var n = this.sizes[i];
		if (q + n > e) fail(q);
		this.on[i] = n > 0;
		if (n > 0) { this.dec[i] = new ArithmeticDecoder(bytes, q, q + n); this.dec[i].readInitBytes(); }
		q += n;
	}
	return q;
};

Point14Decompressor.prototype.next = function (view, o, ctx) {
	var c = this.contexts[this.current];
	var p = c.p, d0 = this.dec[0];
	var r = p.bits & 15, n = p.bits >>> 4;
	var lpr = (r === 1 ? 1 : 0) + (r >= n ? 2 : 0) + (p.gpsChange ? 4 : 0);
	var changed = d0.decodeSymbol(c.changed[lpr]);
	if (changed & 64) {
		var channel = (this.current + d0.decodeSymbol(c.channel) + 1) % 4;
		if (!this.contexts[channel]) this.contexts[channel] = new Context(p);
		this.current = channel;
		if (this.version === 3) ctx.v = channel;
		c = this.contexts[channel];
		p = c.p;
		p.flags = (p.flags & 0xCF) | (channel << 4);
	}
	if (this.version !== 3) ctx.v = this.current;
	var psidChanged = changed & 32, gpsChanged = changed & 16 ? 1 : 0, angleChanged = changed & 8;
	var lastN = p.bits >>> 4, lastR = p.bits & 15;
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
	var kx = c.icDx.k;
	diff = c.icDy.decompress(d0, c.yMedian[idx].get(), single + (kx < 20 ? kx & 0xFFFFFFFE : 20));
	p.y = (p.y + diff) | 0;
	c.yMedian[idx].add(diff);
	if (this.on[1]) {
		var kz = Math.floor((c.icDx.k + c.icDy.k) / 2);
		p.z = c.icZ.decompress(this.dec[1], c.lastZ[l], single + (kz < 18 ? kz & 0xFFFFFFFE : 18));
		c.lastZ[l] = p.z;
	}
	if (this.on[2]) p.cls = this.dec[2].decodeSymbol(lazy(c.clsM, (p.cls & 31) * 2 + (cpr === 3 ? 1 : 0), 256));
	if (this.on[3]) {
		var lastFlags = ((p.flags >>> 7) & 1) * 32 + ((p.flags >>> 6) & 1) * 16 + (p.flags & 15);
		var f = this.dec[3].decodeSymbol(lazy(c.flagsM, lastFlags, 64));
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
