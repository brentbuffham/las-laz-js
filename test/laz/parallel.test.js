// test/laz/parallel.test.js
//==========================================================
// Parallel LAZ decoding (worker pool) against single-threaded decoding,
// which the PDAL oracle already pins: every column identical, for every
// fixture, in windows smaller and larger than a chunk, through the
// filtered count pass, and errors (file offsets) and aborts the same.
// Node runs the pool on worker_threads.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { FIELD_TYPES } from "../../src/read/decodeRecords.js";
import { readChunks } from "../../src/laz/chunkTable.js";
import { LAZ_FIXTURES } from "../helpers/lazFixtureData.js";
import { LAZ_MANIFEST, fixtureBytes } from "../helpers/lazFixtureFiles.js";

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
