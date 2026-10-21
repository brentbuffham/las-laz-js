// test/laz/compress.test.js
//==========================================================
// The chunk compressor: point-wise (formats 0-3) and layered (6-8).
// Oracle: the chunks PDAL 2.10 (LAZperf) wrote into the committed
// fixtures — every chunk we compress from the decompressed records
// must be those bytes exactly. Beyond the fixtures: extreme deltas
// (i32 wrap in X, Z, a GPS time that jumps every point) round trip
// through the decoder, layers left empty by constant fields, all four
// scanner channels interleaved, extra bytes, item version 4, and the
// 0- and 1-point chunk shapes (a layered 1-point chunk as PDAL writes it).
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { createChunkCompressor } from "../../src/laz/compressChunk.js";
import { createChunkDecoder } from "../../src/laz/decompressChunk.js";
import { fixtureBytes, decompressAll } from "../helpers/lazFixtureFiles.js";

["f0", "f1", "f2", "f3", "f3x", "f6", "f7", "f7x", "f8"].forEach(function (name) {
	test(name + ": every chunk compresses to PDAL's bytes", async function () {
		var bytes = fixtureBytes(name), d = await decompressAll(bytes);
		var las = await openLas(bytes, { threads: 1 });
		var compress = createChunkCompressor(las.laz, d.header.recordLength);
		d.chunks.forEach(function (c, i) {
			var ours = compress(d.records, c.firstRecord * d.header.recordLength, c.count);
			assert.deepEqual(ours, bytes.subarray(c.start, c.end), name + " chunk " + i);
		});
	});
});

// LAS 1.2 format 3: Point10, GpsTime11, RGB12 (34-byte records)
var VLR3 = { compressor: 2, coder: 0, items: [{ type: 6, size: 20, version: 2 }, { type: 7, size: 8, version: 2 }, { type: 8, size: 6, version: 2 }] };

// A seeded LCG (Numerical Recipes), so the "random" colours are the same every run
function rng(seed) { var s = seed; return function () { s = (s * 1664525 + 1013904223) % 4294967296; return s; }; }

function extremeRecords(n) {
	var out = new Uint8Array(n * 34), v = new DataView(out.buffer), r = rng(7);
	for (var i = 0; i < n; i++) {
		var o = i * 34;
		v.setInt32(o, i % 2 ? 2147483647 : -2147483648, true);
		v.setInt32(o + 4, (i * 99991) | 0, true);
		v.setInt32(o + 8, i % 2 ? -2147483648 : 2147483647, true);
		v.setUint16(o + 12, r() % 65536, true);
		v.setUint8(o + 14, r() % 256);                   // any return number / count / flags
		v.setUint8(o + 15, r() % 256);
		v.setInt8(o + 16, (r() % 256) - 128);
		v.setUint8(o + 17, r() % 256);
		v.setUint16(o + 18, r() % 65536, true);
		v.setFloat64(o + 20, 1e5 + i * 1e9, true);
		v.setUint16(o + 28, r() % 65536, true); v.setUint16(o + 30, r() % 65536, true); v.setUint16(o + 32, r() % 65536, true);
	}
	return out;
}

test("extreme deltas round trip (format 3)", function () {
	var recs = extremeRecords(1000);
	var packed = createChunkCompressor(VLR3, 34)(recs, 0, 1000);
	var out = new Uint8Array(recs.length);
	createChunkDecoder(VLR3, 34)(packed, 0, packed.length, 1000, new DataView(out.buffer), 0);
	assert.deepEqual(out, recs);
});

// Format 1 with GPS bit patterns chosen to reach every GpsTime11 branch: repeats, multipliers
// 0, 1, 2-9, 10-499, >= 500, -1..-9, <= -10, the 2^31 quotient, a run of extremes, jumps to a
// new sequence and back to an old one
var VLR1 = { compressor: 2, coder: 0, items: [{ type: 6, size: 20, version: 2 }, { type: 7, size: 8, version: 2 }] };
test("GPS time multipliers, extremes and sequence jumps round trip (format 1)", function () {
	var steps = [0n, 0n, 5n, 5n, 0n, 10n, 60n, 5000n, -5n, 5n, -40n, -400n, 1n, 2147483647n, -2147483648n, 1n, 9999999n, 9999999n,
		9999999n, 9999999n, 9999999n, 1n << 40n, 3n, -(1n << 40n), 7n, 0n, 1n << 41n, 0n, 1n << 42n, 0n, 1n << 43n, -(1n << 43n), 2n];
	var r = rng(3);
	for (var i = 0; i < 400; i++) steps.push([0n, 1n, 2n, 3n, 100n, -1n, -77n, 1n << 36n, -(1n << 36n)][r() % 9]);
	var n = steps.length + 1, recs = new Uint8Array(n * 28), v = new DataView(recs.buffer), t = 0x41C0000000000000n;
	for (i = 0; i < n; i++) {
		if (i) t = BigInt.asIntN(64, t + steps[i - 1]);
		v.setInt32(i * 28, i * 3, true);
		v.setBigInt64(i * 28 + 20, t, true);
	}
	var packed = createChunkCompressor(VLR1, 28)(recs, 0, n);
	var out = new Uint8Array(recs.length);
	createChunkDecoder(VLR1, 28)(packed, 0, packed.length, n, new DataView(out.buffer), 0);
	assert.deepEqual(out, recs);
});

test("a chunk can start part-way into the records", function () {
	var recs = extremeRecords(30), compress = createChunkCompressor(VLR3, 34);
	var packed = compress(recs, 10 * 34, 20);
	var out = new Uint8Array(20 * 34);
	createChunkDecoder(VLR3, 34)(packed, 0, packed.length, 20, new DataView(out.buffer), 0);
	assert.deepEqual(out, recs.subarray(10 * 34));
});

test("0 and 1 point chunks", function () {
	var recs = extremeRecords(3), compress = createChunkCompressor(VLR3, 34);
	assert.equal(compress(recs, 0, 0).length, 0);
	assert.deepEqual(compress(recs, 34, 1), recs.slice(34, 68));
});

test("the compressor checks the VLR as the decoder does", function () {
	assert.throws(function () { createChunkCompressor(VLR3, 35); }, { code: "BAD_VLR" });
	assert.throws(function () { createChunkCompressor(Object.assign({}, VLR3, { coder: 1 }), 34); }, { code: "UNSUPPORTED" });
	assert.throws(function () { createChunkCompressor({ compressor: 3, coder: 0, items: [{ type: 10, size: 30, version: 2 }] }, 30); },
		function (e) { return e.code === "UNSUPPORTED" && /Point14 version 2 is not supported in a layered file/.test(e.message); });
	assert.throws(function () { createChunkCompressor({ compressor: 3, coder: 0, items: [{ type: 10, size: 30, version: 3 }, { type: 13, size: 29, version: 3 }] }, 59); },
		function (e) { return e.code === "UNSUPPORTED" && /WavePacket14/.test(e.message); });
	assert.throws(function () { createChunkCompressor({ compressor: 2, coder: 0, items: [{ type: 6, size: 20, version: 1 }] }, 20); },
		function (e) { return e.code === "UNSUPPORTED" && /Point10 version 1/.test(e.message); });
	assert.throws(function () { createChunkCompressor({ compressor: 2, coder: 0, items: [{ type: 6, size: 20, version: 2 }, { type: 9, size: 29, version: 2 }] }, 49); },
		function (e) { return e.code === "UNSUPPORTED" && /WavePacket13/.test(e.message); });
});

// LAS 1.4 formats 6-8 (layered): Point14, then RGB14 (7) or RGB14 + NIR14 (8), then Byte14
var BASE14 = { 6: 30, 7: 36, 8: 38 };
function layeredVlr(fmt, extra, version) {
	var v = version || 3, items = [{ type: 10, size: 30, version: v }];
	if (fmt === 7) items.push({ type: 11, size: 6, version: v });
	if (fmt === 8) items.push({ type: 12, size: 8, version: v });
	if (extra) items.push({ type: 14, size: extra, version: v });
	return { compressor: 3, coder: 0, items: items };
}

// n records of format fmt with `extra` extra bytes; fill(i, view, offset, bytes) writes record i
function records14(n, fmt, extra, fill) {
	var len = BASE14[fmt] + extra, out = new Uint8Array(n * len), v = new DataView(out.buffer);
	for (var i = 0; i < n; i++) fill(i, v, i * len, out);
	return out;
}

// Compress `count` records from record `from`, decode them back, and require the same bytes
function roundTrip14(vlr, len, recs, from, count) {
	var packed = createChunkCompressor(vlr, len)(recs, from * len, count);
	var out = new Uint8Array(count * len);
	createChunkDecoder(vlr, len)(packed, 0, packed.length, count, new DataView(out.buffer), 0);
	assert.deepEqual(out, recs.subarray(from * len, (from + count) * len));
	return packed;
}

// The layer sizes after the raw first record and the point count
function layerSizes(packed, len, words) {
	var v = new DataView(packed.buffer, packed.byteOffset, packed.byteLength), out = [];
	for (var i = 0; i < words; i++) out.push(v.getUint32(len + 4 + i * 4, true));
	return out;
}

test("constant fields leave empty layers that decode (format 6)", function () {
	var recs = records14(6000, 6, 0, function (i, v, o) {
		var n = 1 + (i % 3);
		v.setInt32(o, 1000 + i * 25 + (i % 7), true); v.setInt32(o + 4, 2000 + Math.floor(i / 100) * 25, true); v.setInt32(o + 8, 300000 + Math.round(4000 * Math.sin(i / 50)), true);
		v.setUint16(o + 12, 412, true);                        // intensity, class, flags, user data, scan angle, source, GPS time: constant
		v.setUint8(o + 14, (1 + (i % n)) + n * 16);
		v.setUint8(o + 15, 0x41);
		v.setUint8(o + 16, 2); v.setUint8(o + 17, 9); v.setInt16(o + 18, -120, true); v.setUint16(o + 20, 77, true);
		v.setFloat64(o + 22, 345678.25, true);
	});
	var packed = roundTrip14(layeredVlr(6, 0), 30, recs, 0, 6000);
	var sizes = layerSizes(packed, 30, 9);
	assert.ok(sizes[0] > 0 && sizes[1] > 0, "channel/returns/XY and Z are always written");
	assert.deepEqual(sizes.slice(2), [0, 0, 0, 0, 0, 0, 0], "classification, flags, intensity, scan angle, user data, source, GPS time: empty");
	assert.equal(packed.length, 30 + 4 + 36 + sizes[0] + sizes[1]);
});

// Every point on the next of the four channels, each channel walking on its own (XYZ, colour, time)
function channelRecords(n, fmt, extra) {
	return records14(n, fmt, extra, function (i, v, o, bytes) {
		var ch = i % 4, k = Math.floor(i / 4), ret = 1 + (k % 2), base = BASE14[fmt];
		v.setInt32(o, ch * 100000 + k * 31, true); v.setInt32(o + 4, -ch * 50000 + k * 7, true); v.setInt32(o + 8, ch * 1000 + Math.round(300 * Math.sin(k / 9)), true);
		v.setUint16(o + 12, 100 * ch + (k % 50), true);
		v.setUint8(o + 14, ret + 2 * 16);
		v.setUint8(o + 15, ch * 16 + (k % 97 === 0 ? 1 : 0));
		v.setUint8(o + 16, k % 300 < 150 ? 2 : 5); v.setUint8(o + 17, ch); v.setInt16(o + 18, ch * 10 - (k % 5), true); v.setUint16(o + 20, 10 + ch, true);
		v.setFloat64(o + 22, 1000 * ch + Math.floor(k / 2) * 0.0001, true);
		if (fmt >= 7) { v.setUint16(o + 30, 1000 * ch + k, true); v.setUint16(o + 32, 2000 * ch + 3 * k, true); v.setUint16(o + 34, 9000 - k, true); }
		if (fmt === 8) v.setUint16(o + 36, 40000 + ch * 100 + (k % 13), true);
		for (var e = 0; e < extra; e++) bytes[o + base + e] = e === 1 ? 200 : (k * (e + 1) + ch * 17) % 256;   // extra byte 1 never changes
	});
}

test("scanner channels 0-3 interleaved round trip (format 7)", function () {
	var recs = channelRecords(4000, 7, 0);
	roundTrip14(layeredVlr(7, 0), 36, recs, 0, 4000);
	roundTrip14(layeredVlr(7, 0), 36, recs, 13, 3000);         // a chunk can start part-way into the records, on another channel
});

test("extra bytes with switching channels round trip, item versions 3 and 4 (formats 6, 7, 8)", function () {
	[[6, 30], [7, 36], [8, 38]].forEach(function (f) {
		var recs = channelRecords(3000, f[0], 4), len = f[1] + 4;
		[3, 4].forEach(function (version) {
			var packed = roundTrip14(layeredVlr(f[0], 4, version), len, recs, 0, 3000);
			var words = 9 + (f[0] === 7 ? 1 : f[0] === 8 ? 2 : 0) + 4;
			assert.equal(layerSizes(packed, len, words)[words - 3], 0, "format " + f[0] + " v" + version + ": the constant extra byte's layer is empty");
		});
	});
});

test("extreme deltas round trip (format 8)", function () {
	var r = rng(11), last = [0, 0];
	var recs = records14(3000, 8, 2, function (i, v, o, bytes) {
		v.setInt32(o, i % 2 ? 2147483647 : -2147483648, true);
		v.setInt32(o + 4, (i * 99991) | 0, true);
		v.setInt32(o + 8, i % 2 ? -2147483648 : 2147483647, true);
		v.setUint16(o + 12, r() % 65536, true);
		v.setUint8(o + 14, r() % 256);                          // any return number / count (0-15 each)
		v.setUint8(o + 15, r() % 256);                          // any flags, and a random scanner channel every point
		v.setUint8(o + 16, r() % 256); v.setUint8(o + 17, r() % 256);
		v.setInt16(o + 18, (r() % 65536) - 32768, true); v.setUint16(o + 20, r() % 65536, true);
		// GPS bit patterns: repeats and any 64 bits (NaNs among them)
		if (i % 3 === 0) last = [r(), r()];
		v.setUint32(o + 22, last[0], true); v.setUint32(o + 26, last[1], true);
		for (var k = 30; k < 40; k++) bytes[o + k] = r() % 256;   // colour, NIR, extra bytes
	});
	roundTrip14(layeredVlr(8, 2), 40, recs, 0, 3000);
	// GPS times a double compare gets wrong: +0 and -0 alternating (LAZperf calls them unchanged and
	// loses the sign; they are coded as a change here), then one NaN repeated (LAZperf codes a change)
	var odd = records14(100, 6, 0, function (i, v, o) {
		v.setInt32(o, i, true);
		if (i < 50) v.setFloat64(o + 22, i % 2 ? -0 : 0, true);
		else { v.setUint32(o + 22, 1, true); v.setUint32(o + 26, 0x7FF00000, true); }
	});
	assert.ok(layerSizes(roundTrip14(layeredVlr(6, 0), 30, odd, 0, 100), 30, 9)[8] > 0);
	var nan = records14(50, 6, 0, function (i, v, o) { v.setInt32(o, i, true); v.setUint32(o + 22, 1, true); v.setUint32(o + 26, 0x7FF00000, true); });
	assert.ok(layerSizes(roundTrip14(layeredVlr(6, 0), 30, nan, 0, 50), 30, 9)[8] > 0);
});

// PDAL 2.10 (LAZperf) for a 1-point layered chunk (seen as the last chunk of 50,001 format 6 points):
// the raw record, the count 1, the layer sizes — channel/returns/XY and Z always written (4 bytes,
// an empty stream), every other layer empty — then the two empty streams. (A point-wise 1-point
// chunk is the raw record alone.)
function onePointTail(words) {
	var tail = [1, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0];
	for (var i = 2; i < words; i++) tail.push(0, 0, 0, 0);
	return tail.concat([1, 0, 0, 0, 1, 0, 0, 0]);
}

test("0 and 1 point layered chunks: empty, and the 1-point shape PDAL writes", function () {
	var recs6 = channelRecords(2, 6, 0);
	var one6 = createChunkCompressor(layeredVlr(6, 0), 30)(recs6, 30, 1);
	assert.deepEqual(Array.from(one6), Array.from(recs6.subarray(30, 60)).concat(onePointTail(9)));
	var recs = channelRecords(3, 8, 2), compress = createChunkCompressor(layeredVlr(8, 2), 40);
	assert.equal(compress(recs, 0, 0).length, 0);
	var one = compress(recs, 40, 1);
	assert.deepEqual(Array.from(one), Array.from(recs.subarray(40, 80)).concat(onePointTail(13)));
	var out = new Uint8Array(40);
	createChunkDecoder(layeredVlr(8, 2), 40)(one, 0, one.length, 1, new DataView(out.buffer), 0);
	assert.deepEqual(out, recs.subarray(40, 80));
});
