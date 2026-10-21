// test/laz/chunkTable.test.js
//==========================================================
// The LASzip VLR and the chunk table, over hand-made files: a VLR
// written field by field from its layout, and chunk tables encoded
// with the test encoder. Expected chunk ranges are worked by hand
// from the byte counts.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLazVlr, findLazVlr, COMPRESSOR } from "../../src/laz/LazVlr.js";
import { readChunks, decodeChunkTable } from "../../src/laz/chunkTable.js";
import { ArithmeticEncoder } from "../../src/laz/ArithmeticEncoder.js";
import { IntegerCompressor } from "../../src/laz/IntegerCompressor.js";

function vlrBytes(compressor, chunkSize, items) {
	var b = new Uint8Array(34 + items.length * 6), v = new DataView(b.buffer);
	v.setUint16(0, compressor, true); v.setUint16(2, 0, true);
	v.setUint8(4, 3); v.setUint8(5, 4); v.setUint16(6, 3, true);
	v.setUint32(8, 0, true); v.setUint32(12, chunkSize, true);
	v.setInt32(16, -1, true); v.setInt32(20, -1, true); v.setInt32(24, -1, true); v.setInt32(28, -1, true);
	v.setUint16(32, items.length, true);
	items.forEach(function (it, i) { v.setUint16(34 + i * 6, it[0], true); v.setUint16(36 + i * 6, it[1], true); v.setUint16(38 + i * 6, it[2], true); });
	return b;
}

function tableBytes(entries, withPoints) {
	var enc = new ArithmeticEncoder(), ic = new IntegerCompressor(32, 2), pp = 0, pb = 0;
	entries.forEach(function (e) {
		if (withPoints) { ic.compress(enc, pp, e[0], 0); pp = e[0]; }
		ic.compress(enc, pb, e[1], 1); pb = e[1];
	});
	var body = enc.done(), out = new Uint8Array(8 + body.length), v = new DataView(out.buffer);
	v.setUint32(0, 0, true); v.setUint32(4, entries.length, true);
	out.set(body, 8);
	return out;
}

// A fake LAZ file: [dataStart] i64 table offset, chunk bytes, table, [tail]
function fakeFile(dataStart, byteCounts, table, opts) {
	opts = opts || {};
	var chunksLen = byteCounts.reduce(function (a, b) { return a + b; }, 0);
	var tableAt = dataStart + 8 + chunksLen;
	var size = tableAt + table.length + (opts.tail ? 8 : 0);
	var b = new Uint8Array(size), v = new DataView(b.buffer);
	var at = opts.offsetAtStart === undefined ? tableAt : opts.offsetAtStart;
	v.setInt32(dataStart, at, true); v.setInt32(dataStart + 4, at < 0 ? -1 : 0, true);
	b.set(table, tableAt);
	if (opts.tail) { v.setInt32(size - 8, tableAt, true); v.setInt32(size - 4, 0, true); }
	return { size: b.length, read: async function (s, e) { return b.subarray(s, e); }, tableAt: tableAt };
}

test("the LASzip VLR: compressor, chunk size and items", function () {
	var vlr = parseLazVlr(vlrBytes(2, 50000, [[6, 20, 2], [7, 8, 2], [8, 6, 2]]));
	assert.equal(vlr.compressor, COMPRESSOR.POINTWISE_CHUNKED);
	assert.equal(vlr.chunkSize, 50000);
	assert.equal(vlr.variableChunks, false);
	assert.deepEqual(vlr.items, [{ type: 6, size: 20, version: 2 }, { type: 7, size: 8, version: 2 }, { type: 8, size: 6, version: 2 }]);
	assert.deepEqual(vlr.version, { major: 3, minor: 4, revision: 3 });
	var variable = parseLazVlr(vlrBytes(3, 0, [[10, 30, 3]]));                       // 0 = variable
	assert.equal(variable.variableChunks, true);
	assert.equal(variable.chunkSize, 0xFFFFFFFF);
	assert.equal(findLazVlr([{ userId: "laszip encoded", recordId: 22204, bytes: vlrBytes(2, 1, [[6, 20, 2]]) }]).chunkSize, 1);
	assert.equal(findLazVlr([{ userId: "LASF_Projection", recordId: 34735, bytes: new Uint8Array(8) }]), null);
	assert.throws(function () { parseLazVlr(new Uint8Array(20)); }, { code: "BAD_VLR" });
	assert.throws(function () { parseLazVlr(vlrBytes(2, 1, [[6, 20, 2]]).subarray(0, 36)); }, { code: "BAD_VLR" });
});

test("a chunk table decodes to the byte counts (and point counts) it was encoded from", function () {
	assert.deepEqual(decodeChunkTable(tableBytes([[0, 1000], [0, 1200], [0, 3000000000]], false), false).map(function (e) { return e.byteCount; }), [1000, 1200, 3000000000]);
	assert.deepEqual(decodeChunkTable(tableBytes([[10, 5], [7, 9]], true), true), [{ pointCount: 10, byteCount: 5 }, { pointCount: 7, byteCount: 9 }]);
	assert.deepEqual(decodeChunkTable(tableBytes([], false), false), []);
});

test("fixed-size chunks: ranges from the byte counts; the last chunk holds what is left", async function () {
	var f = fakeFile(500, [40, 60, 30], tableBytes([[0, 40], [0, 60], [0, 30]], false));
	var chunks = await readChunks(f, { offsetToPointData: 500, pointCount: 250 }, { compressor: 2, chunkSize: 100, variableChunks: false });
	assert.deepEqual(chunks, [
		{ firstRecord: 0, count: 100, start: 508, end: 548 },
		{ firstRecord: 100, count: 100, start: 548, end: 608 },
		{ firstRecord: 200, count: 50, start: 608, end: 638 }
	]);
});

test("variable-size chunks take their point counts from the table", async function () {
	var f = fakeFile(300, [10, 20], tableBytes([[7, 10], [3, 20]], true));
	var chunks = await readChunks(f, { offsetToPointData: 300, pointCount: 10 }, { compressor: 3, chunkSize: 0xFFFFFFFF, variableChunks: true });
	assert.deepEqual(chunks.map(function (c) { return [c.firstRecord, c.count, c.start, c.end]; }), [[0, 7, 308, 318], [7, 3, 318, 338]]);
});

test("a table offset of -1 at the start is found in the file's last 8 bytes", async function () {
	var f = fakeFile(300, [10], tableBytes([[0, 10]], false), { offsetAtStart: -1, tail: true });
	var chunks = await readChunks(f, { offsetToPointData: 300, pointCount: 5 }, { compressor: 2, chunkSize: 50000, variableChunks: false });
	assert.deepEqual(chunks, [{ firstRecord: 0, count: 5, start: 308, end: 318 }]);
});

test("no chunk table anywhere is UNSUPPORTED; a table short of points is TRUNCATED; a point-wise file is one chunk", async function () {
	var none = fakeFile(300, [10], tableBytes([[0, 10]], false), { offsetAtStart: -1 });
	await assert.rejects(readChunks(none, { offsetToPointData: 300, pointCount: 5 }, { compressor: 2, chunkSize: 50000, variableChunks: false }), { code: "UNSUPPORTED" });
	var short = fakeFile(300, [10], tableBytes([[0, 10]], false));
	await assert.rejects(readChunks(short, { offsetToPointData: 300, pointCount: 70000 }, { compressor: 2, chunkSize: 50000, variableChunks: false }), { code: "TRUNCATED" });
	var pw = await readChunks({ size: 900, read: null }, { offsetToPointData: 300, pointCount: 12, evlrStart: 0 }, { compressor: 1 });
	assert.deepEqual(pw, [{ firstRecord: 0, count: 12, start: 300, end: 900 }]);
	await assert.rejects(readChunks({ size: 900 }, { offsetToPointData: 300, pointCount: 1 }, { compressor: 9 }), { code: "UNSUPPORTED" });
});

test("variable-size chunk counts that do not add up to the header's count are BAD_HEADER", async function () {
	var more = fakeFile(300, [10, 20], tableBytes([[7, 10], [5, 20]], true));            // 12 points in the table
	await assert.rejects(readChunks(more, { offsetToPointData: 300, pointCount: 10 }, { compressor: 3, chunkSize: 0xFFFFFFFF, variableChunks: true }), { code: "BAD_HEADER" });
	var fewer = fakeFile(300, [10, 20], tableBytes([[7, 10], [1, 20]], true));           // 8 points in the table
	await assert.rejects(readChunks(fewer, { offsetToPointData: 300, pointCount: 10 }, { compressor: 3, chunkSize: 0xFFFFFFFF, variableChunks: true }), { code: "BAD_HEADER" });
	var huge = fakeFile(300, [10], tableBytes([[2000000000, 10]], true));               // a corrupt count must not size a buffer
	await assert.rejects(readChunks(huge, { offsetToPointData: 300, pointCount: 10 }, { compressor: 3, chunkSize: 0xFFFFFFFF, variableChunks: true }), { code: "BAD_HEADER" });
});

// ---- writing: encodeChunkTable and lazVlrFor ----
import { encodeChunkTable } from "../../src/laz/chunkTable.js";
import { lazVlrFor } from "../../src/laz/LazVlr.js";
import { openLas } from "../../src/LasReader.js";
import { LAZ_MANIFEST, fixtureBytes, decompressAll } from "../helpers/lazFixtureFiles.js";

Object.keys(LAZ_MANIFEST).forEach(function (name) {
	test(name + ": lazVlrFor and encodeChunkTable rebuild PDAL's VLR and chunk table", async function () {
		var bytes = fixtureBytes(name), m = LAZ_MANIFEST[name];
		var d = await decompressAll(bytes);
		var las = await openLas(bytes, { threads: 1 });
		var theirs = las.vlrs.filter(function (v) { return v.recordId === 22204; })[0];
		var built = lazVlrFor(m.pointFormat, m.recordLength, 50000);
		assert.deepEqual(built.bytes, theirs.bytes, "VLR payload");
		assert.deepEqual(built.vlr, parseLazVlr(theirs.bytes), "parsed VLR");
		var dv = new DataView(bytes.buffer, bytes.byteOffset + d.header.offsetToPointData, 8);
		var tableAt = dv.getUint32(0, true) + dv.getUint32(4, true) * 4294967296;
		var table = encodeChunkTable(d.chunks.map(function (c) { return { pointCount: c.count, byteCount: c.end - c.start }; }), false);
		assert.deepEqual(table, bytes.subarray(tableAt), "chunk table");
	});
});

test("lazVlrFor: chunk size, extra bytes, and the formats it refuses", function () {
	var f8 = lazVlrFor(8, 40, 1000);
	assert.equal(f8.vlr.compressor, COMPRESSOR.LAYERED_CHUNKED);
	assert.equal(f8.vlr.chunkSize, 1000);
	assert.deepEqual(f8.vlr.items.slice(-1), [{ type: 14, size: 2, version: 3 }]);
	assert.equal(f8.bytes.length, 34 + 6 * f8.vlr.items.length);
	assert.equal(lazVlrFor(0, 20, 50000).vlr.items.length, 1);              // no extra bytes, no Byte item
	assert.deepEqual(lazVlrFor(1, 30, 50000).vlr.items.slice(-1), [{ type: 0, size: 2, version: 2 }]);
	[4, 5, 9, 10].forEach(function (f) {
		assert.throws(function () { lazVlrFor(f, 100, 50000); }, { code: "UNSUPPORTED" });
	});
	assert.throws(function () { lazVlrFor(3, 30, 50000); }, { code: "INVALID_ARGUMENT" });   // record shorter than the format
});

test("encodeChunkTable is the inverse of decodeChunkTable", function () {
	var seed = 12345;
	function rnd(n) { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; }
	[0, 1, 300].forEach(function (n) {
		var chunks = [];
		for (var i = 0; i < n; i++) chunks.push({ pointCount: i === 0 ? 4294967295 : 1 + rnd(100000), byteCount: i === 1 ? 4294967295 : rnd(4000000000) });
		[true, false].forEach(function (withCounts) {
			var back = decodeChunkTable(encodeChunkTable(chunks, withCounts), withCounts);
			assert.equal(back.length, n);
			back.forEach(function (c, j) {
				assert.equal(c.byteCount, chunks[j].byteCount);
				if (withCounts) assert.equal(c.pointCount, chunks[j].pointCount);
			});
		});
	});
	assert.equal(new DataView(encodeChunkTable([{ pointCount: 5, byteCount: 9 }], false).buffer).getUint32(4, true), 1);
});
