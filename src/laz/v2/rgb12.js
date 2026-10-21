// src/laz/v2/rgb12.js
//==========================================================
// LASzip RGB12 item, version 2: the 6 colour bytes. A symbol says which
// bytes changed and whether green and blue differ from red; red's byte
// differences predict green's, and the mean of red's and green's
// predicts blue's (clamped to a byte). Shared by the 1.4 RGB14 item;
// encodeRgb is decodeRgb's mirror, over the same RgbModels.
//
// Ported from laz-rs src/las/rgb.rs, module v2 (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2014 martin isenburg,
// rapidlasso; (c) 2014 Uday Verma, Hobu, Inc.; (c) 2019 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: translated from Rust to JavaScript, Brent Buffham 2026;
// the compressor (encodeRgb, Rgb12Compressor) added beside the decompressor.
//==========================================================

import { ArithmeticModel } from "../models.js";

var LE = true;

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/** The seven models of one RGB context. */
export function RgbModels() {
	this.byteUsed = new ArithmeticModel(128);
	this.lowRed = new ArithmeticModel(256); this.highRed = new ArithmeticModel(256);
	this.lowGreen = new ArithmeticModel(256); this.highGreen = new ArithmeticModel(256);
	this.lowBlue = new ArithmeticModel(256); this.highBlue = new ArithmeticModel(256);
}

/**
 * Decode one colour from the last one.
 * @param {object} dec - ArithmeticDecoder
 * @param {RgbModels} m
 * @param {Uint16Array} last - [r, g, b]; overwritten with the new colour
 */
export function decodeRgb(dec, m, last) {
	var sym = dec.decodeSymbol(m.byteUsed);
	var lr = last[0], lg = last[1], lb = last[2];
	var r, g, b, diff;
	r = sym & 1 ? (dec.decodeSymbol(m.lowRed) + (lr & 255)) & 255 : lr & 255;
	r += sym & 2 ? ((dec.decodeSymbol(m.highRed) + (lr >>> 8)) & 255) * 256 : lr & 0xFF00;
	if (sym & 64) {
		diff = (r & 255) - (lr & 255);
		g = sym & 4 ? (dec.decodeSymbol(m.lowGreen) + clamp8(diff + (lg & 255))) & 255 : lg & 255;
		if (sym & 16) {
			diff = Math.trunc((diff + (g & 255) - (lg & 255)) / 2);
			b = (dec.decodeSymbol(m.lowBlue) + clamp8(diff + (lb & 255))) & 255;
		} else {
			b = lb & 255;
		}
		diff = (r >>> 8) - (lr >>> 8);
		g += sym & 8 ? ((dec.decodeSymbol(m.highGreen) + clamp8(diff + (lg >>> 8))) & 255) * 256 : lg & 0xFF00;
		if (sym & 32) {
			diff = Math.trunc((diff + (g >>> 8) - (lg >>> 8)) / 2);
			b += ((dec.decodeSymbol(m.highBlue) + clamp8(diff + (lb >>> 8))) & 255) * 256;
		} else {
			b += lb & 0xFF00;
		}
	} else {
		g = r; b = r;
	}
	last[0] = r; last[1] = g; last[2] = b;
}

/** RGB12 v2 decompressor: one per chunk. */
export function Rgb12Decompressor() {
	this.size = 6;
	this.models = new RgbModels();
	this.last = new Uint16Array(3);
}

Rgb12Decompressor.prototype.first = function (src, s, view, o) {
	for (var i = 0; i < 6; i++) view.setUint8(o + i, src[s + i]);
	this.last[0] = view.getUint16(o, LE); this.last[1] = view.getUint16(o + 2, LE); this.last[2] = view.getUint16(o + 4, LE);
};

Rgb12Decompressor.prototype.next = function (dec, view, o) {
	decodeRgb(dec, this.models, this.last);
	view.setUint16(o, this.last[0], LE); view.setUint16(o + 2, this.last[1], LE); view.setUint16(o + 4, this.last[2], LE);
};

/**
 * Encode one colour against the last one: the mirror of decodeRgb.
 * @param {object} enc - ArithmeticEncoder
 * @param {RgbModels} m
 * @param {Uint16Array} last - [r, g, b] of the last point (not changed)
 * @param {Uint16Array} cur - [r, g, b] of this point
 */
export function encodeRgb(enc, m, last, cur) {
	var lr = last[0], lg = last[1], lb = last[2], r = cur[0], g = cur[1], b = cur[2];
	var sym = ((lr ^ r) & 255 ? 1 : 0) | ((lr ^ r) & 0xFF00 ? 2 : 0) | ((lg ^ g) & 255 ? 4 : 0) | ((lg ^ g) & 0xFF00 ? 8 : 0) |
		((lb ^ b) & 255 ? 16 : 0) | ((lb ^ b) & 0xFF00 ? 32 : 0) | (r !== g || r !== b ? 64 : 0);
	var diffL = 0, diffH = 0;
	enc.encodeSymbol(m.byteUsed, sym);
	if (sym & 1) { diffL = (r & 255) - (lr & 255); enc.encodeSymbol(m.lowRed, diffL & 255); }
	if (sym & 2) { diffH = (r >>> 8) - (lr >>> 8); enc.encodeSymbol(m.highRed, diffH & 255); }
	if (sym & 64) {
		if (sym & 4) enc.encodeSymbol(m.lowGreen, ((g & 255) - clamp8(diffL + (lg & 255))) & 255);
		if (sym & 16) {
			diffL = Math.trunc((diffL + (g & 255) - (lg & 255)) / 2);
			enc.encodeSymbol(m.lowBlue, ((b & 255) - clamp8(diffL + (lb & 255))) & 255);
		}
		if (sym & 8) enc.encodeSymbol(m.highGreen, ((g >>> 8) - clamp8(diffH + (lg >>> 8))) & 255);
		if (sym & 32) {
			diffH = Math.trunc((diffH + (g >>> 8) - (lg >>> 8)) / 2);
			enc.encodeSymbol(m.highBlue, ((b >>> 8) - clamp8(diffH + (lb >>> 8))) & 255);
		}
	}
}

/** RGB12 v2 compressor: one per chunk, the mirror of Rgb12Decompressor. */
export function Rgb12Compressor() {
	this.size = 6;
	this.models = new RgbModels();
	this.last = new Uint16Array(3);
	this.cur = new Uint16Array(3);
}

function readRgb(out, src, s) {
	out[0] = src[s] + src[s + 1] * 256; out[1] = src[s + 2] + src[s + 3] * 256; out[2] = src[s + 4] + src[s + 5] * 256;
}

Rgb12Compressor.prototype.first = function (src, s) { readRgb(this.last, src, s); };

Rgb12Compressor.prototype.next = function (enc, src, s) {
	readRgb(this.cur, src, s);
	encodeRgb(enc, this.models, this.last, this.cur);
	var t = this.last; this.last = this.cur; this.cur = t;
};
