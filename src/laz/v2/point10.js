// src/laz/v2/point10.js
//==========================================================
// LASzip Point10 item, version 2: the 20 bytes every legacy record
// (formats 0-5) starts with. Each point codes which attributes changed
// since the last one; X and Y are corrections to a streaming median
// of the recent differences, Z to the last height at the same return
// level, all through integer decompressors whose contexts follow the
// return structure.
//
// Ported from laz-rs src/las/point0.rs, module v2, and the median and
// return tables of src/las/utils.rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2014 martin isenburg,
// rapidlasso; (c) 2014 Uday Verma, Hobu, Inc.; (c) 2019 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, working on raw
// record bytes, Brent Buffham 2026.
//==========================================================

import { ArithmeticModel } from "../models.js";
import { IntegerDecompressor } from "../IntegerDecompressor.js";

var LE = true;

/** NUMBER_RETURN_MAP[numberOfReturns][returnNumber] (LASzip). */
export var NUMBER_RETURN_MAP = [
	[15, 14, 13, 12, 11, 10, 9, 8], [14, 0, 1, 3, 6, 10, 10, 9], [13, 1, 2, 4, 7, 11, 11, 10], [12, 3, 4, 5, 8, 12, 12, 11],
	[11, 6, 7, 8, 9, 13, 13, 12], [10, 10, 11, 12, 13, 14, 14, 13], [9, 10, 11, 12, 13, 14, 15, 14], [8, 9, 10, 11, 12, 13, 14, 15]
];
/** NUMBER_RETURN_LEVEL[numberOfReturns][returnNumber] (LASzip). */
export var NUMBER_RETURN_LEVEL = [
	[0, 1, 2, 3, 4, 5, 6, 7], [1, 0, 1, 2, 3, 4, 5, 6], [2, 1, 0, 1, 2, 3, 4, 5], [3, 2, 1, 0, 1, 2, 3, 4],
	[4, 3, 2, 1, 0, 1, 2, 3], [5, 4, 3, 2, 1, 0, 1, 2], [6, 5, 4, 3, 2, 1, 0, 1], [7, 6, 5, 4, 3, 2, 1, 0]
];

/** Median of the last five values, updated in O(1) (LASzip StreamingMedian5). */
export function StreamingMedian() { this.v = new Int32Array(5); this.high = true; }
StreamingMedian.prototype.get = function () { return this.v[2]; };
StreamingMedian.prototype.add = function (x) {
	var v = this.v;
	if (this.high) {
		if (x < v[2]) {
			v[4] = v[3]; v[3] = v[2];
			if (x < v[0]) { v[2] = v[1]; v[1] = v[0]; v[0] = x; }
			else if (x < v[1]) { v[2] = v[1]; v[1] = x; }
			else v[2] = x;
		} else {
			if (x < v[3]) { v[4] = v[3]; v[3] = x; } else v[4] = x;
			this.high = false;
		}
	} else {
		if (v[2] < x) {
			v[0] = v[1]; v[1] = v[2];
			if (v[4] < x) { v[2] = v[3]; v[3] = v[4]; v[4] = x; }
			else if (v[3] < x) { v[2] = v[3]; v[3] = x; }
			else v[2] = x;
		} else {
			if (v[1] < x) { v[0] = v[1]; v[1] = x; } else v[0] = x;
			this.high = true;
		}
	}
};

function models(n, symbols) { var out = []; for (var i = 0; i < n; i++) out.push(new ArithmeticModel(symbols)); return out; }
function medians() { var out = []; for (var i = 0; i < 16; i++) out.push(new StreamingMedian()); return out; }

/** Point10 v2 decompressor: one per chunk. */
export function Point10Decompressor() {
	this.size = 20;
	this.lastIntensity = new Uint16Array(16);
	this.xMedian = medians();
	this.yMedian = medians();
	this.lastHeight = new Int32Array(8);
	this.changedValues = new ArithmeticModel(64);
	this.scanAngleRank = models(2, 256);
	this.bitByte = models(256, 256);
	this.classification = models(256, 256);
	this.userData = models(256, 256);
	this.icIntensity = new IntegerDecompressor(16, 4);
	this.icPointSourceId = new IntegerDecompressor(16, 1);
	this.icDx = new IntegerDecompressor(32, 2);
	this.icDy = new IntegerDecompressor(32, 22);
	this.icZ = new IntegerDecompressor(32, 20);
}

/** The first point of a chunk is stored raw. */
Point10Decompressor.prototype.first = function (src, s, view, o) {
	for (var i = 0; i < 20; i++) view.setUint8(o + i, src[s + i]);
	this.x = view.getInt32(o, LE); this.y = view.getInt32(o + 4, LE); this.z = view.getInt32(o + 8, LE);
	this.intensity = 0;                       // laz-rs: the first point's intensity is not a prediction
	this.bits = view.getUint8(o + 14);
	this.cls = view.getUint8(o + 15);
	this.angle = view.getInt8(o + 16);
	this.user = view.getUint8(o + 17);
	this.psid = view.getUint16(o + 18, LE);
};

Point10Decompressor.prototype.next = function (dec, view, o) {
	var changed = dec.decodeSymbol(this.changedValues);
	var r, n, m, l;
	if (changed !== 0) {
		if (changed & 32) this.bits = dec.decodeSymbol(this.bitByte[this.bits]);
		r = this.bits & 7; n = (this.bits >>> 3) & 7;
		m = NUMBER_RETURN_MAP[n][r]; l = NUMBER_RETURN_LEVEL[n][r];
		if (changed & 16) {
			this.intensity = this.icIntensity.decompress(dec, this.lastIntensity[m], m < 3 ? m : 3);
			this.lastIntensity[m] = this.intensity;
		} else {
			this.intensity = this.lastIntensity[m];
		}
		if (changed & 8) this.cls = dec.decodeSymbol(this.classification[this.cls]);
		if (changed & 4) {
			var d = dec.decodeSymbol(this.scanAngleRank[(this.bits >>> 6) & 1]);
			this.angle = ((this.angle + d) << 24) >> 24;   // i8 wrapping_add
		}
		if (changed & 2) this.user = dec.decodeSymbol(this.userData[this.user]);
		if (changed & 1) this.psid = this.icPointSourceId.decompress(dec, this.psid, 0);
	} else {
		r = this.bits & 7; n = (this.bits >>> 3) & 7;
		m = NUMBER_RETURN_MAP[n][r]; l = NUMBER_RETURN_LEVEL[n][r];
	}
	var single = n === 1 ? 1 : 0;
	var diff = this.icDx.decompress(dec, this.xMedian[m].get(), single);
	this.x = (this.x + diff) | 0;
	this.xMedian[m].add(diff);
	var kx = this.icDx.k;
	diff = this.icDy.decompress(dec, this.yMedian[m].get(), single + (kx < 20 ? kx & 0xFFFFFFFE : 20));
	this.y = (this.y + diff) | 0;
	this.yMedian[m].add(diff);
	var kz = Math.floor((this.icDx.k + this.icDy.k) / 2);
	this.z = this.icZ.decompress(dec, this.lastHeight[l], single + (kz < 18 ? kz & 0xFFFFFFFE : 18));
	this.lastHeight[l] = this.z;
	view.setInt32(o, this.x, LE); view.setInt32(o + 4, this.y, LE); view.setInt32(o + 8, this.z, LE);
	view.setUint16(o + 12, this.intensity, LE);
	view.setUint8(o + 14, this.bits);
	view.setUint8(o + 15, this.cls);
	view.setInt8(o + 16, this.angle);
	view.setUint8(o + 17, this.user);
	view.setUint16(o + 18, this.psid, LE);
};
