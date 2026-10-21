// src/laz/v3/layered.js
//==========================================================
// The LAS 1.4 layered items that follow Point14: RGB14, NIR14 (the
// second half of RGBNIR14) and Byte14 (extra bytes, one layer per
// byte). Each keeps up to four contexts keyed by the scanner channel
// Point14 passes on, with the version-3 quirk preserved: a context
// first used is seeded from the last one, and in version 3 later
// values are predicted from whichever context it was entered from.
// Each compressor shares its decompressor's setup and context switch,
// so the two stay in step point for point.
//
// Ported from laz-rs src/las/rgb.rs, nir.rs and extra_bytes.rs, modules
// v3_v4 (https://github.com/laz-rs/laz-rs), itself a port of LASzip by
// rapidlasso. (c) 2007-2015 martin isenburg, rapidlasso; (c) 2019-2023
// Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, Brent Buffham 2026;
// the compressors (Rgb14Compressor, Nir14Compressor, Byte14Compressor)
// added beside the decompressors, writing a layer once a value changes
// as LAZperf (hobuinc/laz-perf, field_rgb14/nir14/byte14.cpp) does.
//==========================================================

import { ArithmeticDecoder } from "../ArithmeticDecoder.js";
import { ArithmeticEncoder } from "../ArithmeticEncoder.js";
import { ArithmeticModel } from "../models.js";
import { RgbModels, decodeRgb, encodeRgb, readRgb } from "../v2/rgb12.js";

var LE = true;
var EMPTY = new Uint8Array(0);

// laz-rs's context switch, shared by the three items: returns the index whose
// last value predicts this point (`last_idx`), after switching to `ctx`.
// item.seed(from, to) starts a context from another's last value.
function enterContext(item, ctx) {
	var lastIdx = item.lastContext;
	if (item.lastContext !== ctx) {
		item.lastContext = ctx;
		if (item.unused[ctx]) {
			item.seed(lastIdx, ctx);
			item.unused[ctx] = false;
			if (item.version === 3) lastIdx = ctx;
		}
		if (item.version === 4) lastIdx = ctx;
	}
	return lastIdx;
}

// The first point of a chunk: only its channel's context is in use
function firstContext(item, ctx) {
	item.unused = [true, true, true, true];
	item.unused[ctx] = false;
	item.lastContext = ctx;
}

function layer(item, bytes, q, n, fail, e, base) {
	if (q + n > e) fail(q);
	if (n === 0) return null;
	var d = new ArithmeticDecoder(bytes, q, q + n, base);
	d.readInitBytes();
	return d;
}

// The state and models both halves of RGB14 start a chunk with
function initRgb14(self, version) {
	self.size = 6;
	self.version = version;
	self.models = [new RgbModels(), new RgbModels(), new RgbModels(), new RgbModels()];
	self.last = [new Uint16Array(3), new Uint16Array(3), new Uint16Array(3), new Uint16Array(3)];
	self.unused = [true, true, true, true];
	self.lastContext = 0;
}
function seedRgb(from, to) { this.last[to].set(this.last[from]); }

/** RGB14 (version 3 or 4). */
export function Rgb14Decompressor(version) {
	initRgb14(this, version);
	this.dec = null;
}
Rgb14Decompressor.prototype.first = function (src, s, view, o, ctx) {
	for (var i = 0; i < 6; i++) view.setUint8(o + i, src[s + i]);
	readRgb(this.last[ctx.v], src, s);
	firstContext(this, ctx.v);
};
Rgb14Decompressor.prototype.readLayerSizes = function (dv, q) { this.layerSize = dv.getUint32(q, LE); return q + 4; };
Rgb14Decompressor.prototype.readLayers = function (bytes, q, e, fail, base) { this.dec = layer(this, bytes, q, this.layerSize, fail, e, base); return q + this.layerSize; };
Rgb14Decompressor.prototype.seed = seedRgb;
Rgb14Decompressor.prototype.next = function (view, o, ctx) {
	var idx = enterContext(this, ctx.v);
	var rgb = this.last[idx];
	if (this.dec) decodeRgb(this.dec, this.models[this.lastContext], rgb);
	view.setUint16(o, rgb[0], LE); view.setUint16(o + 2, rgb[1], LE); view.setUint16(o + 4, rgb[2], LE);
};

/** RGB14 compressor (version 3 or 4): one layer, written once a colour differs or is not grey. */
export function Rgb14Compressor(version) {
	initRgb14(this, version);
	this.enc = new ArithmeticEncoder();
	this.used = false;
	this.cur = new Uint16Array(3);
}
Rgb14Compressor.prototype.first = function (src, s, ctx) {
	readRgb(this.last[ctx.v], src, s);
	firstContext(this, ctx.v);
};
Rgb14Compressor.prototype.seed = seedRgb;
Rgb14Compressor.prototype.next = function (src, s, ctx) {
	var idx = enterContext(this, ctx.v);
	readRgb(this.cur, src, s);
	if (encodeRgb(this.enc, this.models[this.lastContext], this.last[idx], this.cur)) this.used = true;
	this.last[idx].set(this.cur);
};
/** @returns {Array<Uint8Array>} the one layer (empty when nothing was coded) */
Rgb14Compressor.prototype.finish = function () { return [this.used ? this.enc.done() : EMPTY]; };

// The state and models both halves of NIR14 start a chunk with
function initNir14(self, version) {
	self.size = 2;
	self.version = version;
	self.usedModel = []; self.low = []; self.high = [];
	for (var i = 0; i < 4; i++) { self.usedModel.push(new ArithmeticModel(4)); self.low.push(new ArithmeticModel(256)); self.high.push(new ArithmeticModel(256)); }
	self.last = new Uint16Array(4);
	self.unused = [true, true, true, true];
	self.lastContext = 0;
}
function seedNir(from, to) { this.last[to] = this.last[from]; }

/** NIR14 (version 3 or 4): the near-infrared word of RGBNIR14. */
export function Nir14Decompressor(version) {
	initNir14(this, version);
	this.dec = null;
}
Nir14Decompressor.prototype.first = function (src, s, view, o, ctx) {
	view.setUint8(o, src[s]); view.setUint8(o + 1, src[s + 1]);
	this.last[ctx.v] = src[s] + src[s + 1] * 256;
	firstContext(this, ctx.v);
};
Nir14Decompressor.prototype.readLayerSizes = Rgb14Decompressor.prototype.readLayerSizes;
Nir14Decompressor.prototype.readLayers = Rgb14Decompressor.prototype.readLayers;
Nir14Decompressor.prototype.seed = seedNir;
Nir14Decompressor.prototype.next = function (view, o, ctx) {
	var idx = enterContext(this, ctx.v);
	if (this.dec) {
		var c = this.lastContext, last = this.last[idx];
		var sym = this.dec.decodeSymbol(this.usedModel[c]);
		var v = sym & 1 ? (this.dec.decodeSymbol(this.low[c]) + (last & 255)) & 255 : last & 255;
		v += sym & 2 ? ((this.dec.decodeSymbol(this.high[c]) + (last >>> 8)) & 255) * 256 : last & 0xFF00;
		this.last[idx] = v;
	}
	view.setUint16(o, this.last[idx], LE);
};

/** NIR14 compressor (version 3 or 4): one layer, written once the value changes. */
export function Nir14Compressor(version) {
	initNir14(this, version);
	this.enc = new ArithmeticEncoder();
	this.used = false;
}
Nir14Compressor.prototype.first = function (src, s, ctx) {
	this.last[ctx.v] = src[s] + src[s + 1] * 256;
	firstContext(this, ctx.v);
};
Nir14Compressor.prototype.seed = seedNir;
Nir14Compressor.prototype.next = function (src, s, ctx) {
	var idx = enterContext(this, ctx.v), c = this.lastContext;
	var last = this.last[idx], v = src[s] + src[s + 1] * 256;
	var sym = ((last ^ v) & 255 ? 1 : 0) + ((last ^ v) & 0xFF00 ? 2 : 0);
	this.enc.encodeSymbol(this.usedModel[c], sym);
	if (sym & 1) this.enc.encodeSymbol(this.low[c], ((v & 255) - (last & 255)) & 255);
	if (sym & 2) this.enc.encodeSymbol(this.high[c], ((v >>> 8) - (last >>> 8)) & 255);
	if (sym) this.used = true;
	this.last[idx] = v;
};
/** @returns {Array<Uint8Array>} the one layer (empty when the value never changed) */
Nir14Compressor.prototype.finish = Rgb14Compressor.prototype.finish;

// The state both halves of Byte14 start a chunk with; a context's models are made when it is first used
function initByte14(self, count, version) {
	self.size = count;
	self.version = version;
	self.models = [null, null, null, null];
	self.last = [new Uint8Array(count), new Uint8Array(count), new Uint8Array(count), new Uint8Array(count)];
	self.unused = [true, true, true, true];
	self.lastContext = 0;
}
function byteModels(count) { var m = []; for (var i = 0; i < count; i++) m.push(new ArithmeticModel(256)); return m; }
function firstBytes(item, src, s, ctx) {
	item.last[ctx.v].set(src.subarray(s, s + item.size));
	firstContext(item, ctx.v);
	item.models[ctx.v] = byteModels(item.size);
}
function seedBytes(from, to) { this.models[to] = byteModels(this.size); this.last[to].set(this.last[from]); }

/** Byte14 (version 3 or 4): `count` extra bytes, one layer each. */
export function Byte14Decompressor(count, version) {
	initByte14(this, count, version);
	this.sizes = new Array(count);
	this.dec = new Array(count);
}
Byte14Decompressor.prototype.first = function (src, s, view, o, ctx) {
	for (var i = 0; i < this.size; i++) view.setUint8(o + i, src[s + i]);
	firstBytes(this, src, s, ctx);
};
Byte14Decompressor.prototype.readLayerSizes = function (dv, q) {
	for (var i = 0; i < this.size; i++) { this.sizes[i] = dv.getUint32(q, LE); q += 4; }
	return q;
};
Byte14Decompressor.prototype.readLayers = function (bytes, q, e, fail, base) {
	for (var i = 0; i < this.size; i++) { this.dec[i] = layer(this, bytes, q, this.sizes[i], fail, e, base); q += this.sizes[i]; }
	return q;
};
Byte14Decompressor.prototype.seed = seedBytes;
Byte14Decompressor.prototype.next = function (view, o, ctx) {
	var idx = enterContext(this, ctx.v);
	var last = this.last[idx], models = this.models[ctx.v];
	for (var i = 0; i < this.size; i++) {
		if (this.dec[i]) last[i] = (last[i] + this.dec[i].decodeSymbol(models[i])) & 255;
		view.setUint8(o + i, last[i]);
	}
};

/** Byte14 compressor (version 3 or 4): `count` extra bytes, a layer each, written once that byte changes. */
export function Byte14Compressor(count, version) {
	initByte14(this, count, version);
	this.enc = [];
	this.used = [];
	for (var i = 0; i < count; i++) { this.enc.push(new ArithmeticEncoder()); this.used.push(false); }
}
Byte14Compressor.prototype.first = function (src, s, ctx) { firstBytes(this, src, s, ctx); };
Byte14Compressor.prototype.seed = seedBytes;
Byte14Compressor.prototype.next = function (src, s, ctx) {
	var idx = enterContext(this, ctx.v);
	var last = this.last[idx], models = this.models[ctx.v];
	for (var i = 0; i < this.size; i++) {
		var d = (src[s + i] - last[i]) & 255;   // u8 wrapping_sub
		this.enc[i].encodeSymbol(models[i], d);
		if (d) { this.used[i] = true; last[i] = src[s + i]; }
	}
};
/** @returns {Array<Uint8Array>} one layer per byte (empty when that byte never changed) */
Byte14Compressor.prototype.finish = function () {
	var out = [];
	for (var i = 0; i < this.size; i++) out.push(this.used[i] ? this.enc[i].done() : EMPTY);
	return out;
};
