// test/laz/compress.test.js
//==========================================================
// The point-wise chunk compressor (formats 0-3). Oracle: the chunks
// PDAL 2.10 (LAZperf) wrote into the committed fixtures — every chunk
// we compress from the decompressed records must be those bytes
// exactly. Beyond the fixtures: extreme deltas (i32 wrap in X, Z, a
// GPS time that jumps every point) round trip through the decoder,
// and the 0- and 1-point chunk shapes.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { createChunkCompressor } from "../../src/laz/compressChunk.js";
import { createChunkDecoder } from "../../src/laz/decompressChunk.js";
import { fixtureBytes, decompressAll } from "../helpers/lazFixtureFiles.js";

["f0", "f1", "f2", "f3", "f3x"].forEach(function (name) {
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
	assert.throws(function () { createChunkCompressor(Object.assign({}, VLR3, { compressor: 3 }), 34); },
		function (e) { return e.code === "UNSUPPORTED" && /layered \(LAS 1\.4\) compression is not written yet/.test(e.message); });
	assert.throws(function () { createChunkCompressor({ compressor: 2, coder: 0, items: [{ type: 6, size: 20, version: 1 }] }, 20); },
		function (e) { return e.code === "UNSUPPORTED" && /Point10 version 1/.test(e.message); });
	assert.throws(function () { createChunkCompressor({ compressor: 2, coder: 0, items: [{ type: 6, size: 20, version: 2 }, { type: 9, size: 29, version: 2 }] }, 49); },
		function (e) { return e.code === "UNSUPPORTED" && /WavePacket13/.test(e.message); });
});
