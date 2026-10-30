// test/laz/parallel.test.js
//==========================================================
// Parallel LAZ decoding (worker pool) against single-threaded decoding,
// which the PDAL oracle already pins: every column identical, for every
// fixture, in windows smaller and larger than a chunk, through the
// filtered count pass, and errors (file offsets) and aborts the same.
// The pool's compress tasks give the single-threaded chunks, byte for byte.
// Node runs the pool on worker_threads.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { FIELD_TYPES } from "../../src/read/decodeRecords.js";
import { readChunks } from "../../src/laz/chunkTable.js";
import { LAZ_FIXTURES } from "../helpers/lazFixtureData.js";
import { LAZ_MANIFEST, fixtureBytes, decompressAll } from "../helpers/lazFixtureFiles.js";
import { createLazPool } from "../../src/laz/pool.js";
import { lazVlrFor } from "../../src/laz/LazVlr.js";
import { createChunkCompressor } from "../../src/laz/compressChunk.js";

var ALL = Object.keys(FIELD_TYPES);

function same(a, b, what) {
	assert.equal(a.count, b.count, what + " count");
	Object.keys(b).forEach(function (k) { if (ArrayBuffer.isView(b[k])) assert.deepEqual(Array.from(a[k]), Array.from(b[k]), what + " " + k); });
}

LAZ_FIXTURES.forEach(function (fx) {
	test(fx.name + ": two decode workers give exactly the single-threaded columns", async function () {
		var one = await (await openLas(fixtureBytes(fx.name), { threads: 1 })).readPoints({ fields: ALL });
		var two = await (await openLas(fixtureBytes(fx.name), { threads: 2 })).readPoints({ fields: ALL });
		same(two, one, fx.name);
	});
});

test("one chunk per window (the next window decoding while this one is used) reads the same points", async function () {
	var one = await (await openLas(fixtureBytes("f7"), { threads: 1 })).readPoints({ fields: ALL });
	var las = await openLas(fixtureBytes("f7"), { threads: 3, windowSize: 1000 });
	same(await las.readPoints({ fields: ALL }), one, "f7 windowed");
	var n = 0, windows = 0;
	for await (var c of las.chunks({ fields: ["x"] })) { n += c.count; windows++; }
	assert.equal(n, LAZ_MANIFEST.f7.points);
	assert.equal(windows, 2);
});

test("filters + maxPoints (the counting pass also runs on the pool) give the single-threaded points", async function () {
	var opts = { fields: ["x", "y", "gpsTime", "classification"], classes: [2, 9], maxPoints: 1500 };
	var one = await (await openLas(fixtureBytes("f3"), { threads: 1 })).readPoints(opts);
	var two = await (await openLas(fixtureBytes("f3"), { threads: 2, windowSize: 1000 })).readPoints(opts);
	assert.equal(two.count, 1500);
	same(two, one, "filtered");
});

test("a corrupt chunk decoded by a worker is TRUNCATED with its file offset", async function () {
	var bytes = fixtureBytes("f3").slice();
	var las = await openLas(bytes);
	var src = { size: bytes.length, read: async function (s, e) { return bytes.subarray(s, e); } };
	var c1 = (await readChunks(src, las.header, las.laz))[1];
	for (var i = c1.start + 200; i < c1.end; i++) bytes[i] = 0xFF;
	var err = await (await openLas(bytes, { threads: 2 })).readPoints({ fields: ["x"] }).then(function () { return null; }, function (e) { return e; });
	assert.ok(err, "must fail");
	assert.equal(err.code, "TRUNCATED");
	assert.ok(err.offset >= c1.start + 200 && err.offset <= c1.end, "offset " + err.offset + " in chunk 1");
});

test("an abort stops a parallel read, and the reader reads again afterwards", async function () {
	var las = await openLas(fixtureBytes("f3"), { threads: 2, windowSize: 1000 });
	var ac = new AbortController();
	var seen = 0;
	await assert.rejects((async function () {
		for await (var c of las.chunks({ fields: ["x"], signal: ac.signal })) { seen += c.count; ac.abort(); }
	})(), { code: "ABORTED" });
	assert.equal(seen, 50000);                                        // one window, then stopped
	assert.equal((await las.readPoints({ fields: ["x"] })).count, LAZ_MANIFEST.f3.points);
});

test("breaking out of chunks() early closes the pool (no hang, reads again)", async function () {
	var las = await openLas(fixtureBytes("f7"), { threads: 2, windowSize: 1000 });
	for await (var c of las.chunks({ fields: ["x"] })) { assert.equal(c.count, 50000); break; }
	assert.equal((await las.readPoints({ fields: ["x"] })).count, LAZ_MANIFEST.f7.points);
});

test("pool.compress: groups of chunks come back as the single-threaded chunks, and decode still works on the same workers", async function () {
	var d = await decompressAll(fixtureBytes("f7")), len = d.header.recordLength;
	var made = lazVlrFor(7, len, 1000), one = createChunkCompressor(made.vlr, len);
	var pool = await createLazPool(2);
	assert.ok(pool, "no pool: this test would not reach a worker");
	try {
		// 51 chunks of 1000 in tasks of up to 4, sent at once: each task's chunks, in order
		var tasks = [], sent = [];
		for (var c = 0; c < 51; c += 4) {
			var counts = [];
			for (var k = c; k < Math.min(51, c + 4); k++) counts.push(1000);
			var records = d.records.slice(c * 1000 * len, (c + counts.length) * 1000 * len);
			tasks.push(pool.compress({ vlr: made.vlr, recordLength: len, records: records.buffer, counts: counts }));
			sent.push(records);
		}
		var got = await Promise.all(tasks);
		sent.forEach(function (r) { assert.equal(r.byteLength, 0, "the records are transferred, not copied"); });
		got.forEach(function (r, t) {
			var at = 0;
			r.sizes.forEach(function (n, i) {
				var ch = t * 4 + i;
				assert.deepEqual(r.bytes.subarray(at, at + n), one(d.records, ch * 1000 * len, 1000), "chunk " + ch);
				at += n;
			});
			assert.equal(at, r.bytes.length);
		});
		// the same workers still decode (no op = decode)
		var fx = fixtureBytes("f7"), las = await openLas(fx);
		var src = { size: fx.length, read: async function (s, e) { return fx.subarray(s, e); } };
		var c0 = (await readChunks(src, las.header, las.laz))[0];
		var piece = fx.slice(c0.start, c0.end);
		var raw = await pool.decode({ vlr: las.laz, recordLength: len, packed: piece.buffer, chunks: [{ s: 0, e: piece.length, count: c0.count }], base: c0.start });
		assert.deepEqual(raw, d.records.subarray(0, c0.count * len));
	} finally {
		pool.close();
	}
	await assert.rejects(pool.compress({ vlr: made.vlr, recordLength: len, records: new ArrayBuffer(len), counts: [1] }), { code: "ABORTED" });
});

test("pool: a task that cannot be sent fails alone and leaves every worker free", { timeout: 20000 }, async function () {
	var pool = await createLazPool(2);
	try {
		var made = lazVlrFor(3, 34, 1000);
		// a buffer that was transferred away: postMessage throws, as it did on the main thread in a stalled build
		var gone = function () { var b = new ArrayBuffer(340); structuredClone(b, { transfer: [b] }); return b; };
		for (var i = 0; i < 2; i++)
			await assert.rejects(pool.compress({ vlr: made.vlr, recordLength: 34, records: gone(), counts: [10] }), { name: "LasError", message: /could not send/ });
		// both workers still take work (with the leak, a pool of 2 had none left and this waited for ever)
		var good = [0, 1, 2].map(function () { return pool.compress({ vlr: made.vlr, recordLength: 34, records: new ArrayBuffer(340), counts: [10] }); });
		var got = await Promise.all(good);
		assert.ok(got.every(function (g) { return g.bytes.length > 0 && g.sizes.length === 1; }));
	} finally {
		pool.close();
	}
});

test("pool.compress: a worker's error comes back as a LasError", async function () {
	var pool = await createLazPool(2);
	try {
		// a VLR the compressor refuses (coder 1): refused in the worker, sent back with its code
		var made = lazVlrFor(3, 34, 1000);
		await assert.rejects(pool.compress({ vlr: Object.assign({}, made.vlr, { coder: 1 }), recordLength: 34, records: new ArrayBuffer(34), counts: [1] }), { name: "LasError", code: "UNSUPPORTED", message: /coder 1/ });
	} finally {
		pool.close();
	}
});
