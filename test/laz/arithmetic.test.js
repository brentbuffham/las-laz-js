// test/laz/arithmetic.test.js
//==========================================================
// The LASzip arithmetic decoder, models and integer decompressor,
// by round trip through the test-only encoder (helpers/lazEncoder.js):
// whatever the encoder wrote, the decoder must read back exactly,
// across small and large models, raw bits, and integer corrections
// that wrap. Whole-file correctness against an independent encoder
// (PDAL) is in pointwise.test.js.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ArithmeticDecoder } from "../../src/laz/ArithmeticDecoder.js";
import { ArithmeticModel, ArithmeticBitModel } from "../../src/laz/models.js";
import { IntegerDecompressor } from "../../src/laz/IntegerDecompressor.js";
import { ArithmeticEncoder, IntegerCompressor } from "../helpers/lazEncoder.js";

function rng(seed) { return function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

// A skewed source, so the models adapt (half the draws are one symbol)
function draw(r, n) { return r() < 0.5 ? 0 : Math.floor(r() * n); }

test("symbols round trip through models of 2, 16, 17, 256 and 2048 symbols", function () {
	[2, 16, 17, 256, 2048].forEach(function (n) {
		var r = rng(n), syms = [];
		for (var i = 0; i < 20000; i++) syms.push(draw(r, n));
		var enc = new ArithmeticEncoder(), em = new ArithmeticModel(n);
		syms.forEach(function (s) { enc.encodeSymbol(em, s); });
		var bytes = enc.done();
		var dec = new ArithmeticDecoder(bytes), dm = new ArithmeticModel(n);
		dec.readInitBytes();
		var got = syms.map(function () { return dec.decodeSymbol(dm); });
		assert.deepEqual(got, syms, n + " symbols");
		assert.ok(bytes.length < 20000 * Math.log2(n) / 8, n + " symbols: the coder compressed the skewed source");
	});
});

test("bits, raw bits (1-32), shorts and ints round trip interleaved", function () {
	var r = rng(5), ops = [];
	for (var i = 0; i < 5000; i++) {
		var kind = Math.floor(r() * 4), bits = 1 + Math.floor(r() * 32);
		var v = kind === 0 ? (r() < 0.8 ? 0 : 1) : kind === 1 ? Math.floor(r() * Math.pow(2, bits)) : kind === 2 ? Math.floor(r() * 65536) : Math.floor(r() * 4294967296);
		ops.push({ kind: kind, bits: bits, v: v });
	}
	var enc = new ArithmeticEncoder(), bm = new ArithmeticBitModel();
	ops.forEach(function (o) {
		if (o.kind === 0) enc.encodeBit(bm, o.v);
		else if (o.kind === 1) enc.writeBits(o.bits, o.v);
		else if (o.kind === 2) enc.writeShort(o.v);
		else enc.writeInt(o.v);
	});
	var dec = new ArithmeticDecoder(enc.done()), dbm = new ArithmeticBitModel();
	dec.readInitBytes();
	ops.forEach(function (o, i) {
		var got = o.kind === 0 ? dec.decodeBit(dbm) : o.kind === 1 ? dec.readBits(o.bits) : o.kind === 2 ? dec.readShort() : dec.readInt();
		assert.equal(got, o.v, "op " + i + " kind " + o.kind);
	});
});

test("integers round trip as corrections to a prediction, 16- and 32-bit, with contexts and wrap-around", function () {
	[[16, 4], [32, 22]].forEach(function (cfg) {
		var bits = cfg[0], contexts = cfg[1], r = rng(bits);
		var lo = bits === 32 ? -2147483648 : 0, span = Math.pow(2, bits);
		var vals = [];
		for (var i = 0; i < 20000; i++) {
			var pred = lo + Math.floor(r() * span), real;
			var p = r();
			if (p < 0.4) real = pred + Math.floor(r() * 7) - 3;                 // small corrections
			else if (p < 0.7) real = pred + Math.floor(r() * 2000) - 1000;
			else real = lo + Math.floor(r() * span);                            // anything, incl. far wraps
			if (bits === 32) real = real | 0; else real = ((real % span) + span) % span;
			vals.push({ pred: pred, real: real, ctx: Math.floor(r() * contexts) });
		}
		var enc = new ArithmeticEncoder(), ic = new IntegerCompressor(bits, contexts);
		vals.forEach(function (v) { ic.compress(enc, v.pred, v.real, v.ctx); });
		var dec = new ArithmeticDecoder(enc.done()), id = new IntegerDecompressor(bits, contexts);
		dec.readInitBytes();
		vals.forEach(function (v, i) { assert.equal(id.decompress(dec, v.pred, v.ctx), v.real, bits + "-bit value " + i); });
	});
});

test("the extreme 32-bit correction (k = 32) decodes to the i32 minimum offset", function () {
	var enc = new ArithmeticEncoder(), ic = new IntegerCompressor(32, 1);
	ic.compress(enc, 0, -2147483648, 0);
	ic.compress(enc, 5, 5 - 2147483648, 0);
	var dec = new ArithmeticDecoder(enc.done()), id = new IntegerDecompressor(32, 1);
	dec.readInitBytes();
	assert.equal(id.decompress(dec, 0, 0), -2147483648);
	assert.equal(id.decompress(dec, 5, 0), 5 - 2147483648);
	assert.equal(id.k, 32);
});

test("a stream cut short is TRUNCATED, never an endless decode", function () {
	var enc = new ArithmeticEncoder(), m = new ArithmeticModel(256), r = rng(9);
	for (var i = 0; i < 1000; i++) enc.encodeSymbol(m, Math.floor(r() * 256));
	var bytes = enc.done();
	var dec = new ArithmeticDecoder(bytes, 0, bytes.length - 40), dm = new ArithmeticModel(256);
	dec.readInitBytes();
	assert.throws(function () { for (var j = 0; j < 1000; j++) dec.decodeSymbol(dm); }, { code: "TRUNCATED" });
});
