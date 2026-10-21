// src/laz/v3/layered.js
//==========================================================
// The LAS 1.4 layered items that follow Point14: RGB14, NIR14 (the
// second half of RGBNIR14) and Byte14 (extra bytes, one layer per
// byte). Each keeps up to four contexts keyed by the scanner channel
// Point14 passes on, with the version-3 quirk preserved: a context
// first used is seeded from the last one, and in version 3 later
// values are predicted from whichever context it was entered from.
//
// Ported from laz-rs src/las/rgb.rs, nir.rs and extra_bytes.rs, modules
// v3_v4 (https://github.com/laz-rs/laz-rs), itself a port of LASzip by
// rapidlasso. (c) 2007-2015 martin isenburg, rapidlasso; (c) 2019-2023
// Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, Brent Buffham 2026.
//==========================================================

import { ArithmeticDecoder } from "../ArithmeticDecoder.js";
import { ArithmeticModel } from "../models.js";
import { RgbModels, decodeRgb } from "../v2/rgb12.js";

var LE = true;

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

function layer(item, bytes, q, n, fail, e, base) {
	if (q + n > e) fail(q);
	if (n === 0) return null;
	var d = new ArithmeticDecoder(bytes, q, q + n, base);
	d.readInitBytes();
	return d;
}

/** RGB14 (version 3 or 4). */
export function Rgb14Decompressor(version) {
	this.size = 6;
	this.version = version;
	this.models = [new RgbModels(), new RgbModels(), new RgbModels(), new RgbModels()];
	this.last = [new Uint16Array(3), new Uint16Array(3), new Uint16Array(3), new Uint16Array(3)];
	this.unused = [true, true, true, true];
	this.lastContext = 0;
	this.dec = null;
}
Rgb14Decompressor.prototype.first = function (src, s, view, o, ctx) {
	for (var i = 0; i < 6; i++) view.setUint8(o + i, src[s + i]);
	var c = ctx.v;
	this.last[c][0] = view.getUint16(o, LE); this.last[c][1] = view.getUint16(o + 2, LE); this.last[c][2] = view.getUint16(o + 4, LE);
	this.unused = [true, true, true, true];
	this.unused[c] = false;
	this.lastContext = c;
};
Rgb14Decompressor.prototype.readLayerSizes = function (dv, q) { this.layerSize = dv.getUint32(q, LE); return q + 4; };
Rgb14Decompressor.prototype.readLayers = function (bytes, q, e, fail, base) { this.dec = layer(this, bytes, q, this.layerSize, fail, e, base); return q + this.layerSize; };
Rgb14Decompressor.prototype.seed = function (from, to) { this.last[to].set(this.last[from]); };
Rgb14Decompressor.prototype.next = function (view, o, ctx) {
	var idx = enterContext(this, ctx.v);
	var rgb = this.last[idx];
	if (this.dec) decodeRgb(this.dec, this.models[this.lastContext], rgb);
	view.setUint16(o, rgb[0], LE); view.setUint16(o + 2, rgb[1], LE); view.setUint16(o + 4, rgb[2], LE);
};

/** NIR14 (version 3 or 4): the near-infrared word of RGBNIR14. */
export function Nir14Decompressor(version) {
	this.size = 2;
	this.version = version;
	this.used = []; this.low = []; this.high = [];
	for (var i = 0; i < 4; i++) { this.used.push(new ArithmeticModel(4)); this.low.push(new ArithmeticModel(256)); this.high.push(new ArithmeticModel(256)); }
	this.last = new Uint16Array(4);
	this.unused = [true, true, true, true];
	this.lastContext = 0;
	this.dec = null;
}
Nir14Decompressor.prototype.first = function (src, s, view, o, ctx) {
	view.setUint8(o, src[s]); view.setUint8(o + 1, src[s + 1]);
	this.last[ctx.v] = view.getUint16(o, LE);
	this.unused = [true, true, true, true];
	this.unused[ctx.v] = false;
	this.lastContext = ctx.v;
};
Nir14Decompressor.prototype.readLayerSizes = Rgb14Decompressor.prototype.readLayerSizes;
Nir14Decompressor.prototype.readLayers = Rgb14Decompressor.prototype.readLayers;
Nir14Decompressor.prototype.seed = function (from, to) { this.last[to] = this.last[from]; };
Nir14Decompressor.prototype.next = function (view, o, ctx) {
	var idx = enterContext(this, ctx.v);
	if (this.dec) {
		var c = this.lastContext, last = this.last[idx];
		var sym = this.dec.decodeSymbol(this.used[c]);
		var v = sym & 1 ? (this.dec.decodeSymbol(this.low[c]) + (last & 255)) & 255 : last & 255;
		v += sym & 2 ? ((this.dec.decodeSymbol(this.high[c]) + (last >>> 8)) & 255) * 256 : last & 0xFF00;
		this.last[idx] = v;
	}
	view.setUint16(o, this.last[idx], LE);
};

/** Byte14 (version 3 or 4): `count` extra bytes, one layer each. */
export function Byte14Decompressor(count, version) {
	this.size = count;
	this.version = version;
	this.models = [null, null, null, null];
	this.last = [new Uint8Array(count), new Uint8Array(count), new Uint8Array(count), new Uint8Array(count)];
	this.unused = [true, true, true, true];
	this.lastContext = 0;
	this.sizes = new Array(count);
	this.dec = new Array(count);
}
function byteModels(count) { var m = []; for (var i = 0; i < count; i++) m.push(new ArithmeticModel(256)); return m; }
Byte14Decompressor.prototype.first = function (src, s, view, o, ctx) {
	for (var i = 0; i < this.size; i++) view.setUint8(o + i, src[s + i]);
	this.last[ctx.v].set(src.subarray(s, s + this.size));
	this.unused = [true, true, true, true];
	this.unused[ctx.v] = false;
	this.models[ctx.v] = byteModels(this.size);
	this.lastContext = ctx.v;
};
Byte14Decompressor.prototype.readLayerSizes = function (dv, q) {
	for (var i = 0; i < this.size; i++) { this.sizes[i] = dv.getUint32(q, LE); q += 4; }
	return q;
};
Byte14Decompressor.prototype.readLayers = function (bytes, q, e, fail, base) {
	for (var i = 0; i < this.size; i++) { this.dec[i] = layer(this, bytes, q, this.sizes[i], fail, e, base); q += this.sizes[i]; }
	return q;
};
Byte14Decompressor.prototype.seed = function (from, to) { this.models[to] = byteModels(this.size); this.last[to].set(this.last[from]); };
Byte14Decompressor.prototype.next = function (view, o, ctx) {
	var idx = enterContext(this, ctx.v);
	var last = this.last[idx], models = this.models[ctx.v];
	for (var i = 0; i < this.size; i++) {
		if (this.dec[i]) last[i] = (last[i] + this.dec[i].decodeSymbol(models[i])) & 255;
		view.setUint8(o + i, last[i]);
	}
};
