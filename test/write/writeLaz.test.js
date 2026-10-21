// test/write/writeLaz.test.js
//==========================================================
// writeLas / createLasWriter with compress: true (LAZ, point
// formats 0-3 and 6-8). Oracle: the PDAL 2.10 (LAZperf) fixtures — our
// chunks and chunk table must be PDAL's bytes, and our 8-byte table
// offset must point at our own table. Beyond the fixtures: round
// trips through openLas against the LAS writer's output, batches of
// any size and unawaited writePoints calls giving the one-shot bytes,
// the 0-point file PDAL writes, the refusals, and threads: the worker
// pool's bytes are the threads-1 bytes, whatever order chunks finish in.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeLas, createLasWriter } from "../../src/write/writeLas.js";
import { openLas } from "../../src/LasReader.js";
import { parseHeader } from "../../src/format/LasHeader.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { LASZIP_USER_ID, LASZIP_RECORD_ID } from "../../src/laz/LazVlr.js";
import { LAZ_MANIFEST, fixtureBytes, decompressAll } from "../helpers/lazFixtureFiles.js";
import { LAZ_FIXTURES, fixturePoints } from "../helpers/lazFixtureData.js";
import { createLazPool, defaultThreads } from "../../src/laz/pool.js";
import { createChunkCompressor } from "../../src/laz/compressChunk.js";
import { ArithmeticEncoder } from "../../src/laz/ArithmeticEncoder.js";
import { LasError, ERROR_CODES } from "../../src/errors.js";

var ALL = ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scannerChannel", "scanAngle", "userData", "pointSourceId", "gpsTime", "red", "green", "blue", "nir"];
var TYPES = { x: Float64Array, y: Float64Array, z: Float64Array, intensity: Uint16Array, returnNumber: Uint8Array, numberOfReturns: Uint8Array, scanDirection: Uint8Array, edgeOfFlightLine: Uint8Array, classification: Uint8Array, classificationFlags: Uint8Array, scannerChannel: Uint8Array, scanAngle: Float32Array, userData: Uint8Array, pointSourceId: Uint16Array, gpsTime: Float64Array, red: Uint16Array, green: Uint16Array, blue: Uint16Array, nir: Uint16Array };
var SCALE = { x: 0.001, y: 0.001, z: 0.001 };
var OFFSET = { x: 477000, y: 6770000, z: 0 };
var DATE = new Date(Date.UTC(2026, 9, 21));

// Point objects (fixturePoints) -> PointColumns
function toColumns(pts) {
	var c = { count: pts.length };
	ALL.forEach(function (k) { c[k] = TYPES[k].from(pts, function (p) { return p[k]; }); });
	return c;
}

// n survey-like points: a slowly moving surface, returns 1-3, colour and time drifting
function columns(n) {
	var c = { count: n };
	ALL.forEach(function (k) { c[k] = new TYPES[k](n); });
	for (var i = 0; i < n; i++) {
		c.x[i] = 477000 + (i % 300) * 0.25; c.y[i] = 6770000 + Math.floor(i / 300) * 0.25; c.z[i] = 300 + 4 * Math.sin(i / 70);
		c.intensity[i] = 500 + (i * 37) % 900; c.numberOfReturns[i] = 1 + (i % 3); c.returnNumber[i] = 1 + (i % c.numberOfReturns[i]);
		c.scanDirection[i] = (i >> 6) % 2; c.edgeOfFlightLine[i] = i % 499 === 0 ? 1 : 0;
		c.classification[i] = [2, 2, 2, 5, 6][Math.floor(i / 400) % 5]; c.classificationFlags[i] = i % 211 === 0 ? 1 : 0;
		c.scanAngle[i] = Math.round(10 * Math.sin(i / 900)); c.userData[i] = Math.floor(i / 1000) % 256; c.pointSourceId[i] = i < n / 2 ? 7 : 8;
		c.gpsTime[i] = 345678.25 + Math.floor(i / 2) * 0.00001; c.red[i] = (20000 + i * 3) % 65536; c.green[i] = (30000 + i * 5) % 65536; c.blue[i] = (25000 + i * 7) % 65536;
	}
	return c;
}

function slice(all, a, b) {
	var c = { count: b - a };
	Object.keys(all).forEach(function (k) { if (k !== "count") c[k] = all[k].slice(a, b); });
	return c;
}

function u32(bytes, at) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true); }
function i64(bytes, at) { return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(at, true)); }
function memorySink(size) {
	var sink = { buf: new Uint8Array(size), end: 0 };
	sink.write = function (bytes, position) {
		if (position + bytes.length > sink.buf.length) { var b = new Uint8Array(2 * (position + bytes.length)); b.set(sink.buf); sink.buf = b; }
		sink.buf.set(bytes, position); sink.end = Math.max(sink.end, position + bytes.length);
	};
	sink.bytes = function () { return sink.buf.slice(0, sink.end); };
	return sink;
}

// Ruling R4: every fixture whose records PDAL kept (not f8: PDAL padded its records). The writer
// has no extra-bytes columns, so it cannot produce a fixture's extra bytes: those fixtures (f3x,
// f7x) keep the chunk-level byte test (test/laz/compress.test.js) only.
Object.keys(LAZ_MANIFEST).filter(function (name) {
	return LAZ_MANIFEST[name].pdalKeptRecords;
}).forEach(function (name) {
	var fx = LAZ_FIXTURES.find(function (f) { return f.name === name; });
	var skip = fx.extra ? "the writer has no extra-bytes columns, so it cannot write " + name + "'s " + fx.extra + " extra bytes (chunk-level test only)" : false;
	test(name + ": point data is PDAL's, byte for byte", { skip: skip }, async function () {
		var pdal = fixtureBytes(name), h = parseHeader(new MemorySource(pdal));
		var ours = await writeLas(toColumns(fixturePoints(fx)), { compress: true, version: "1." + h.versionMinor, pointFormat: h.pointFormat, scale: h.scale, offset: h.offset });
		var oh = parseHeader(new MemorySource(ours));
		assert.equal(oh.compressed, true);
		assert.equal(oh.recordLength, h.recordLength);
		assert.equal(oh.pointCount, h.pointCount);
		// chunks + chunk table: PDAL's bytes
		assert.deepEqual(ours.subarray(oh.offsetToPointData + 8), pdal.subarray(h.offsetToPointData + 8));
		// the table offset is absolute: it points at OUR table, the same distance into the point data as PDAL's
		var table = i64(ours, oh.offsetToPointData);
		assert.equal(table - oh.offsetToPointData, i64(pdal, h.offsetToPointData) - h.offsetToPointData);
		assert.equal(u32(ours, table), 0);                                  // chunk table version 0
		assert.equal(u32(ours, table + 4), Math.ceil(h.pointCount / 50000)); // chunk count
		// the LASzip VLR is PDAL's too
		var vlrOf = function (vlrs) { return vlrs.find(function (v) { return v.userId === LASZIP_USER_ID && v.recordId === LASZIP_RECORD_ID; }).bytes; };
		assert.deepEqual(vlrOf((await openLas(ours)).vlrs), vlrOf((await openLas(pdal)).vlrs));
	});
});

// The LAS writer's file of the same points is the reference: same records, same totals
async function checkAgainstLas(src, opts, label) {
	var laz = await writeLas(src, Object.assign({ compress: true }, opts));
	var las = await writeLas(src, opts);
	var zr = await openLas(laz, { threads: 1 }), sr = await openLas(las);
	assert.equal(zr.compressed, true, label);
	assert.equal(sr.compressed, false, label);
	var zh = zr.header, sh = sr.header;
	assert.equal(zh.pointCount, src.count, label);
	assert.equal(zh.recordLength, sh.recordLength, label);
	assert.deepEqual(zh.pointsByReturn, sh.pointsByReturn, label);
	assert.deepEqual(zh.bounds, sh.bounds, label);
	assert.deepEqual(await zr.readPoints({ fields: ALL }), await sr.readPoints({ fields: ALL }), label);
	// and the decompressed records are the LAS file's records
	var d = await decompressAll(laz);
	assert.deepEqual(d.records, las.subarray(sh.offsetToPointData, sh.offsetToPointData + src.count * sh.recordLength), label);
	return laz;
}

test("round trips: 0, 1, 50000 and 50001 points, formats 0-3; a custom chunkSize", async function () {
	for (var n of [0, 1, 50000, 50001]) {
		var src = columns(n);
		for (var f = 0; f <= 3; f++) await checkAgainstLas(src, { version: "1.2", pointFormat: f, scale: SCALE, offset: OFFSET, date: DATE }, n + " points, format " + f);
	}
	var laz = await checkAgainstLas(columns(2500), { version: "1.4", pointFormat: 3, scale: SCALE, offset: OFFSET, chunkSize: 1000 }, "chunkSize 1000");
	var zr = await openLas(laz);
	assert.equal(zr.laz.chunkSize, 1000);
	assert.equal((await decompressAll(laz)).chunks.length, 3);
	// scale / offset chosen from the bounds, as for LAS
	await checkAgainstLas(columns(300), { pointFormat: 1 }, "chosen scale and offset");
});

// Formats 6-8 with the scanner channel in blocks that come back (every context-switch path)
test("round trips: 0, 1, 50000 and 50001 points, formats 6-8 (LAS 1.4, layered)", async function () {
	for (var n of [0, 1, 50000, 50001]) {
		var src = columns(n);
		for (var i = 0; i < n; i++) src.scannerChannel[i] = [0, 1, 0, 2, 1, 3, 0][Math.floor(i / 700) % 7];
		for (var f = 6; f <= 8; f++) {
			src.nir = f === 8 ? Uint16Array.from(src.red, function (r) { return 65535 - r; }) : new Uint16Array(n);
			await checkAgainstLas(src, { version: "1.4", pointFormat: f, scale: SCALE, offset: OFFSET, date: DATE }, n + " points, format " + f);
		}
	}
	var laz = await checkAgainstLas(columns(2500), { version: "1.4", pointFormat: 8, scale: SCALE, offset: OFFSET, chunkSize: 1000 }, "format 8, chunkSize 1000");
	assert.equal((await decompressAll(laz)).chunks.length, 3);
	assert.equal((await openLas(laz)).laz.compressor, 3);
});

test("the header: compressed bit, uncompressed record length, LASzip VLR after the CRS records", async function () {
	var bytes = await writeLas(columns(10), { compress: true, version: "1.2", pointFormat: 2, crs: { epsg: 28350, wkt: "PROJCS[\"GDA94 / MGA zone 50\"]" } });
	assert.equal(bytes[104], 128 + 2);
	assert.equal(new DataView(bytes.buffer).getUint16(105, true), 26);
	var las = await openLas(bytes);
	assert.deepEqual(las.vlrs.map(function (v) { return v.recordId; }), [34735, 2112, LASZIP_RECORD_ID]);
	var lazVlr = las.vlrs[2];
	assert.equal(lazVlr.description, "http://laszip.org");              // as LAZperf writes it
	assert.equal(las.header.offsetToPointData, lazVlr.start + lazVlr.length);
	assert.equal(las.crs.epsg, 28350);
	assert.ok((await writeLas(columns(2), { compress: true, as: "blob" })) instanceof Blob);
});

// PDAL 2.10 (LAZperf) for a 0-point LAZ: the 8-byte offset to the table right after it, then the
// table — version 0, 0 chunks, and the 4 bytes an arithmetic encoder ends an empty stream with.
// (laz-rs writes one empty chunk entry instead; LAZperf's file is the oracle.)
test("0 points: the offset and PDAL's empty chunk table; opens with count 0", async function () {
	var bytes = await writeLas(columns(0), { compress: true, version: "1.2", pointFormat: 0, scale: SCALE, offset: OFFSET });
	var h = parseHeader(new MemorySource(bytes));
	assert.equal(i64(bytes, h.offsetToPointData), h.offsetToPointData + 8);
	assert.deepEqual(Array.from(bytes.subarray(h.offsetToPointData + 8)), [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
	var las = await openLas(bytes);
	assert.equal(las.header.pointCount, 0);
	assert.equal((await las.readPoints({ fields: ALL })).count, 0);
	// the streaming writer, closed with no points, writes the same file
	var sink = memorySink(16);
	var w = await createLasWriter(sink, { compress: true, version: "1.2", pointFormat: 0, scale: SCALE, offset: OFFSET, date: DATE });
	assert.deepEqual(await w.close(), { count: 0 });
	assert.deepEqual(sink.bytes(), await writeLas(columns(0), { compress: true, version: "1.2", pointFormat: 0, scale: SCALE, offset: OFFSET, date: DATE }));
});

var STREAM = { compress: true, chunkSize: 1000, version: "1.2", pointFormat: 3, scale: SCALE, offset: OFFSET, date: DATE };

test("batches give the same bytes: createLasWriter in batches of 1, 999 and 7777 equals writeLas", async function () {
	var all = columns(12345);
	var oneShot = await writeLas(all, STREAM);
	assert.equal(parseHeader(new MemorySource(oneShot)).compressed, true);
	for (var size of [1, 999, 7777]) {
		var sink = memorySink(64);
		var w = await createLasWriter(sink, STREAM);
		for (var a = 0; a < all.count; a += size) await w.writePoints(slice(all, a, Math.min(all.count, a + size)));
		assert.deepEqual(await w.close(), { count: all.count });
		assert.deepEqual(sink.bytes(), oneShot, "batches of " + size);
	}
});

test("unawaited writePoints calls keep their order", async function () {
	var all = columns(5000);
	var oneShot = await writeLas(all, STREAM);
	assert.equal(parseHeader(new MemorySource(oneShot)).compressed, true);
	var sink = memorySink(oneShot.length);
	var slow = { write: function (bytes, position) { return new Promise(function (res) { setTimeout(function () { sink.write(bytes, position); res(); }, 5); }); } };
	var w = await createLasWriter(slow, STREAM);
	var calls = [w.writePoints(slice(all, 0, 1700)), w.writePoints(slice(all, 1700, 3100)), w.writePoints(slice(all, 3100, 5000))];
	await w.close();
	await Promise.all(calls);
	assert.deepEqual(sink.bytes(), oneShot);
});

test("refusals: compress with formats 4, 5, 9, 10 is UNSUPPORTED", async function () {
	var src = columns(3);
	for (var c of [["1.3", 4], ["1.3", 5], ["1.4", 9], ["1.4", 10]]) {
		await assert.rejects(writeLas(src, { compress: true, version: c[0], pointFormat: c[1] }), { code: "UNSUPPORTED" }, c.join(" "));
		await assert.rejects(createLasWriter(memorySink(8), { compress: true, version: c[0], pointFormat: c[1], scale: SCALE, offset: OFFSET }), { code: "UNSUPPORTED" }, c.join(" "));
	}
});

test("refusals: chunkSize must be a whole number from 1 to 2^32 - 2", async function () {
	var src = columns(3);
	// 0xFFFFFFFF in the VLR means variable-size chunks, so the largest fixed size is one less
	for (var bad of [0, 1.5, -1, NaN, Infinity, "1000", 4294967295]) {
		await assert.rejects(writeLas(src, { compress: true, chunkSize: bad }), { code: "INVALID_ARGUMENT" }, String(bad));
		await assert.rejects(createLasWriter(memorySink(8), { compress: true, chunkSize: bad, scale: SCALE, offset: OFFSET }), { code: "INVALID_ARGUMENT" }, String(bad));
	}
	var one = await openLas(await writeLas(src, { compress: true, chunkSize: 1 }));
	assert.equal(one.laz.chunkSize, 1);
	assert.equal((await one.readPoints({ fields: ["x"] })).count, 3);
});

test("chunkSize without compress is ignored: the LAS bytes are unchanged", async function () {
	var src = columns(20), opts = { version: "1.2", pointFormat: 3, scale: SCALE, offset: OFFSET, date: DATE };
	var plain = await writeLas(src, opts);
	assert.deepEqual(await writeLas(src, Object.assign({ chunkSize: 0 }, opts)), plain);
	assert.deepEqual(await writeLas(src, Object.assign({ compress: false, chunkSize: 1000 }, opts)), plain);
	assert.equal(parseHeader(new MemorySource(plain)).compressed, false);
});

//==========================================================
// threads: compression on the worker pool. Chunks compress independently,
// so any thread count must give the threads-1 bytes; chunks that finish
// out of order are still written in order; the pool is always closed.
//==========================================================

var THROWS = new URL("../fixtures/workers/throwsOnLoad.js", import.meta.url);

function fixtureOpts(fx) {
	return { compress: true, chunkSize: 1000, version: fx.version, pointFormat: fx.pointFormat, scale: SCALE, offset: OFFSET, date: DATE };
}

// Real pools, counted: the size of each one made, and how often one was closed
function countedPools() {
	var c = { made: [], closed: 0 };
	c.create = function (n) {
		return createLazPool(n).then(function (p) {
			assert.ok(p, "no pool: the parallel writer tests would quietly run on one thread");
			c.made.push(n);
			var close = p.close;
			p.close = function () { c.closed++; return close.call(p); };
			return p;
		});
	};
	return c;
}

// A pool on this thread whose task t finishes after delayOf(t) ms (so later tasks can
// finish first), or fails if t is failAt; it records what the writer asks of it
function fakePool(n, delayOf, failAt) {
	var log = { tasks: 0, inFlight: 0, maxInFlight: 0, maxChunks: 0, finished: [], closed: 0 };
	log.pool = {
		size: n,
		compress: function (task) {
			var t = log.tasks++;
			log.inFlight++;
			log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
			log.maxChunks = Math.max(log.maxChunks, task.counts.length);
			return new Promise(function (resolve, reject) {
				setTimeout(function () {
					log.inFlight--;
					log.finished.push(t);
					if (t === failAt) return reject(new LasError(ERROR_CODES.UNSUPPORTED, "a LAZ worker failed: test failure"));
					// compressed when the delay is up, so the delays, not the work, set the finishing order
					var one = createChunkCompressor(task.vlr, task.recordLength), recs = new Uint8Array(task.records);
					var p = 0, parts = task.counts.map(function (count) { var ch = one(recs, p, count); p += count * task.recordLength; return ch; });
					var bytes = new Uint8Array(parts.reduce(function (s, c) { return s + c.length; }, 0)), o = 0;
					parts.forEach(function (c) { bytes.set(c, o); o += c.length; });
					resolve({ bytes: bytes, sizes: parts.map(function (c) { return c.length; }) });
				}, delayOf(t));
			});
		},
		close: function () { log.closed++; }
	};
	log.create = function (m) { log.asked = m; return Promise.resolve(log.pool); };
	return log;
}

function outOfOrder(finished) { return finished.some(function (t, i) { return i > 0 && t < finished[i - 1]; }); }

async function streamed(all, opts, batch, unawaited) {
	var sink = memorySink(64);
	var w = await createLasWriter(sink, opts);
	var calls = [];
	for (var a = 0; a < all.count; a += batch) {
		var job = w.writePoints(slice(all, a, Math.min(all.count, a + batch)));
		if (unawaited) calls.push(job); else await job;
	}
	assert.deepEqual(await w.close(), { count: all.count });
	await Promise.all(calls);
	return sink.bytes();
}

["f3", "f7"].forEach(function (name) {
	var fx = LAZ_FIXTURES.find(function (f) { return f.name === name; });
	test(name + ", chunkSize 1000 (51 chunks): threads 2 = threads 1, byte for byte (writeLas and createLasWriter)", async function () {
		var all = toColumns(fixturePoints(fx)), opts = fixtureOpts(fx);
		var one = await writeLas(all, Object.assign({ threads: 1 }, opts));
		assert.equal((await decompressAll(one)).chunks.length, 51);
		var pools = countedPools();
		var two = await writeLas(all, Object.assign({ threads: 2, _createPool: pools.create }, opts));
		assert.deepEqual(pools.made, [2]);
		assert.equal(pools.closed, 1, "writeLas closes its pool");
		assert.deepEqual(two, one);
		// streaming, 7777 points a call, awaited and not
		assert.deepEqual(await streamed(all, Object.assign({ threads: 2, _createPool: pools.create }, opts), 7777), one, "awaited batches");
		assert.deepEqual(await streamed(all, Object.assign({ threads: 2, _createPool: pools.create }, opts), 7777, true), one, "unawaited batches");
		assert.deepEqual(pools.made, [2, 2, 2]);
		assert.equal(pools.closed, 3, "close() closes the pool");
		assert.deepEqual(await streamed(all, Object.assign({ threads: 1 }, opts), 7777), one, "threads 1 streaming");
	});
});

test("no workers: a pool that cannot start means the same bytes on this thread", async function () {
	var fx = LAZ_FIXTURES.find(function (f) { return f.name === "f3"; });
	var all = toColumns(fixturePoints(fx)), opts = fixtureOpts(fx);
	var one = await writeLas(all, Object.assign({ threads: 1 }, opts));
	var asked = 0;
	var none = function () { asked++; return createLazPool(2, THROWS); };
	assert.equal(await none(), null);
	assert.deepEqual(await writeLas(all, Object.assign({ threads: 2, _createPool: none }, opts)), one);
	assert.deepEqual(await streamed(all, Object.assign({ threads: 2, _createPool: none }, opts), 7777), one);
	assert.equal(asked, 3);
	// a pool hook that fails outright: this thread too
	var broken = function () { return Promise.reject(new Error("no workers here")); };
	assert.deepEqual(await writeLas(all, Object.assign({ threads: 2, _createPool: broken }, opts)), one);
});

test("chunks that finish out of order (later ones first) are written in chunk order", async function () {
	var fx = LAZ_FIXTURES.find(function (f) { return f.name === "f7"; });
	var all = toColumns(fixturePoints(fx)), opts = fixtureOpts(fx);
	var one = await writeLas(all, Object.assign({ threads: 1 }, opts));
	var reversed = function (t) { return 5 + 10 * (7 - (t % 8)); };   // in each run of 8 tasks the last finishes first
	var fake = fakePool(4, reversed);
	assert.deepEqual(await writeLas(all, Object.assign({ threads: 4, _createPool: fake.create }, opts)), one);
	assert.equal(fake.asked, 4);
	assert.ok(outOfOrder(fake.finished), "completion order must differ from submission order: " + fake.finished);
	assert.equal(fake.maxChunks, 4, "chunks go in groups of up to 4");
	assert.equal(fake.tasks, 13);
	assert.ok(fake.maxInFlight <= 2 * 4, "bounded: at most two tasks per worker in flight (" + fake.maxInFlight + ")");
	assert.equal(fake.closed, 1);
	// streaming, unawaited calls, to a slow sink as well
	fake = fakePool(4, reversed);
	var sink = memorySink(one.length);
	var slow = { write: function (bytes, position) { return new Promise(function (res) { setTimeout(function () { sink.write(bytes, position); res(); }, 3); }); } };
	var w = await createLasWriter(slow, Object.assign({ threads: 4, _createPool: fake.create }, opts));
	var calls = [];
	for (var a = 0; a < all.count; a += 7777) calls.push(w.writePoints(slice(all, a, Math.min(all.count, a + 7777))));
	await w.close();
	await Promise.all(calls);
	assert.deepEqual(sink.bytes(), one);
	assert.ok(outOfOrder(fake.finished), "streaming: out of order too: " + fake.finished);
	assert.equal(fake.closed, 1);
});

test("a worker failing mid-write rejects writeLas / writePoints / close with its error, and the pool is closed", async function () {
	var fx = LAZ_FIXTURES.find(function (f) { return f.name === "f3"; });
	var all = toColumns(fixturePoints(fx)), opts = fixtureOpts(fx);
	var fake = fakePool(2, function () { return 1; }, 2);
	await assert.rejects(writeLas(all, Object.assign({ threads: 2, _createPool: fake.create }, opts)), { code: "UNSUPPORTED", message: /test failure/ });
	assert.equal(fake.closed, 1);
	fake = fakePool(2, function () { return 1; }, 2);
	var w = await createLasWriter(memorySink(64), Object.assign({ threads: 2, _createPool: fake.create }, opts));
	var err = null;
	try {
		for (var a = 0; a < all.count; a += 7777) await w.writePoints(slice(all, a, Math.min(all.count, a + 7777)));
		await w.close();
	} catch (e) { err = e; }
	assert.ok(err && /test failure/.test(err.message), "the worker's error: " + err);
	assert.equal(fake.closed, 1);
	// the writer stays failed: later calls give the same error
	await assert.rejects(w.writePoints(slice(all, 0, 10)), { message: /test failure/ });
	await assert.rejects(w.close(), { message: /test failure/ });
	assert.equal(fake.closed, 1);
});

test("a bad point (int32 overflow) mid-write closes the pool too", async function () {
	var fx = LAZ_FIXTURES.find(function (f) { return f.name === "f3"; });
	var all = toColumns(fixturePoints(fx)), opts = fixtureOpts(fx);
	all.x[40000] = 1e12;
	var fake = fakePool(2, function () { return 1; });
	await assert.rejects(writeLas(all, Object.assign({ threads: 2, _createPool: fake.create }, opts)), { code: "INVALID_ARGUMENT" });
	assert.equal(fake.closed, 1);
	fake = fakePool(2, function () { return 1; });
	var w = await createLasWriter(memorySink(64), Object.assign({ threads: 2, _createPool: fake.create }, opts));
	await w.writePoints(slice(all, 0, 7777));
	await assert.rejects(w.writePoints(slice(all, 7777, all.count)), { code: "INVALID_ARGUMENT" });
	assert.equal(fake.closed, 1);
	await assert.rejects(w.close(), { code: "INVALID_ARGUMENT" });
});

test("threads, automatic: writeLas uses a pool from 4 chunks, createLasWriter from its 4th full chunk; threads 1 never", async function () {
	var auto = await defaultThreads();
	var src = columns(4000), opts = Object.assign({}, STREAM);
	var fake = fakePool(2, function () { return 0; });
	await writeLas(slice(src, 0, 3000), Object.assign({ _createPool: fake.create }, opts));
	assert.equal(fake.asked, undefined, "3 chunks: this thread");
	var bytes = await writeLas(src, Object.assign({ _createPool: fake.create }, opts));
	assert.equal(fake.asked, auto >= 2 ? Math.min(auto, 4) : undefined, "4 chunks: a pool of min(default threads, chunks)");
	assert.deepEqual(bytes, await writeLas(src, opts));
	fake = fakePool(2, function () { return 0; });
	await writeLas(columns(51000), Object.assign({ threads: 1, _createPool: fake.create }, opts));
	assert.equal(fake.asked, undefined, "threads 1: this thread");
	await writeLas(slice(src, 0, 2000), Object.assign({ threads: 3, _createPool: fake.create }, opts));
	assert.equal(fake.asked, 2, "explicit threads, at most one per chunk");
	fake = fakePool(2, function () { return 0; });
	await writeLas(slice(src, 0, 1000), Object.assign({ threads: 3, _createPool: fake.create }, opts));
	assert.equal(fake.asked, undefined, "one chunk: nothing to share");
	// streaming: automatic waits for the 4th full chunk; explicit starts at the first
	fake = fakePool(2, function () { return 0; });
	var w = await createLasWriter(memorySink(64), Object.assign({ _createPool: fake.create }, opts));
	for (var c = 0; c < 3; c++) await w.writePoints(slice(src, c * 1000, c * 1000 + 1000));
	assert.equal(fake.asked, undefined, "3 full chunks: this thread");
	await w.writePoints(slice(src, 3000, 4000));
	assert.equal(fake.asked, auto >= 2 ? Math.min(auto, 4) : undefined, "the 4th full chunk starts the pool (automatic: at most 4 workers)");
	await w.close();
	assert.equal(fake.closed, auto >= 2 ? 1 : 0);
	fake = fakePool(2, function () { return 0; });
	w = await createLasWriter(memorySink(64), Object.assign({ threads: 3, _createPool: fake.create }, opts));
	await w.writePoints(slice(src, 0, 999));
	assert.equal(fake.asked, undefined);
	await w.writePoints(slice(src, 999, 1000));
	assert.equal(fake.asked, 3, "explicit threads: from the first full chunk");
	await w.close();
	assert.equal(fake.closed, 1);
	fake = fakePool(2, function () { return 0; });
	w = await createLasWriter(memorySink(64), Object.assign({ threads: 1, _createPool: fake.create }, opts));
	await w.writePoints(src);
	await w.close();
	assert.equal(fake.asked, undefined, "threads 1 streaming: this thread");
});

// threads, automatic (ruling R15): at most 4 workers — gains flatten there, while records in flight
// grow with every worker. Explicit threads are honoured as given.
test("threads, automatic: at most 4 compression workers; explicit threads as asked", async function () {
	var auto = await defaultThreads();
	var src = columns(20000), opts = Object.assign({}, STREAM);   // 20 chunks
	var fake = fakePool(2, function () { return 0; });
	await writeLas(src, Object.assign({ _createPool: fake.create }, opts));
	assert.equal(fake.asked, auto >= 2 ? Math.min(auto, 4) : undefined, "writeLas, automatic: min(default threads, 4)");
	assert.ok(!(fake.asked > 4));
	fake = fakePool(2, function () { return 0; });
	var w = await createLasWriter(memorySink(64), Object.assign({ _createPool: fake.create }, opts));
	await w.writePoints(src);
	await w.close();
	assert.equal(fake.asked, auto >= 2 ? Math.min(auto, 4) : undefined, "createLasWriter, automatic: min(default threads, 4)");
	fake = fakePool(2, function () { return 0; });
	await writeLas(src, Object.assign({ threads: 16, _createPool: fake.create }, opts));
	assert.equal(fake.asked, 16, "explicit threads: as asked");
	fake = fakePool(2, function () { return 0; });
	w = await createLasWriter(memorySink(64), Object.assign({ threads: 6, _createPool: fake.create }, opts));
	await w.writePoints(src);
	await w.close();
	assert.equal(fake.asked, 6, "explicit threads, streaming: as asked");
});

//==========================================================
// Fail-stop and closed (rulings R11): a streaming LAZ writer that failed — in a
// chunk, in close()'s own writes, or on this thread — keeps rejecting, and a
// closed one refuses more points: either would otherwise finish a corrupt file.
//==========================================================

// A sink that rejects its failAt-th write (1 = the header written at creation)
function failingSink(failAt) {
	var sink = memorySink(64), writes = 0, write = sink.write;
	sink.write = function (bytes, position) {
		if (++writes === failAt) return Promise.reject(new Error("disk full: write " + writes));
		write(bytes, position);
		return Promise.resolve();
	};
	return sink;
}

test("a sink write failing in close() (last chunk, chunk table, table offset, header): close() keeps rejecting", async function () {
	var all = columns(2500), opts = Object.assign({ threads: 1 }, STREAM);
	// writes: 1 header, 2-3 the full chunks, then in close(): 4 the partial chunk, 5 the table, 6 the offset, 7 the header
	for (var failAt = 4; failAt <= 7; failAt++) {
		var w = await createLasWriter(failingSink(failAt), opts);
		await w.writePoints(all);
		await assert.rejects(w.close(), { message: "disk full: write " + failAt }, "write " + failAt);
		await assert.rejects(w.close(), { message: "disk full: write " + failAt }, "write " + failAt + ": a second close()");
		await assert.rejects(w.writePoints(slice(all, 0, 10)), { message: "disk full: write " + failAt }, "write " + failAt + ": writePoints");
	}
});

test("a compressor error on this thread, in close() or writePoints: the writer stays failed", async function () {
	var all = columns(2500);
	var done = ArithmeticEncoder.prototype.done;
	function failing(fn) {
		ArithmeticEncoder.prototype.done = function () { throw new Error("encoder broke"); };
		var p;
		try { p = fn(); } finally { ArithmeticEncoder.prototype.done = done; }
		return p;
	}
	for (var threads of [1, 0]) {   // 0: automatic (under 4 full chunks: this thread)
		var opts = Object.assign({ threads: threads }, STREAM);
		var w = await createLasWriter(memorySink(64), opts);
		await w.writePoints(all);
		// the partial chunk compresses in close(), synchronously, after its records left the buffer
		await assert.rejects(failing(function () { return w.close(); }), { message: "encoder broke" });
		await assert.rejects(w.close(), { message: "encoder broke" }, "a second close()");
		await assert.rejects(w.writePoints(slice(all, 0, 10)), { message: "encoder broke" });
		w = await createLasWriter(memorySink(64), opts);
		await assert.rejects(failing(function () { return w.writePoints(all); }), { message: "encoder broke" });
		await assert.rejects(w.writePoints(slice(all, 0, 10)), { message: "encoder broke" });
		await assert.rejects(w.close(), { message: "encoder broke" });
	}
	// writeLas too
	await assert.rejects(failing(function () { return writeLas(all, Object.assign({ threads: 1 }, STREAM)); }), { message: "encoder broke" });
});

test("after close(), writePoints and close() reject (ABORTED) and the file is untouched; threads 1 and 2", async function () {
	var all = columns(2500);
	for (var threads of [1, 2]) {
		var fake = fakePool(2, function () { return 1; });
		var opts = Object.assign({ threads: threads, _createPool: fake.create }, STREAM);
		var sink = memorySink(64);
		var w = await createLasWriter(sink, opts);
		await w.writePoints(all);
		assert.deepEqual(await w.close(), { count: 2500 });
		var file = sink.bytes();
		await assert.rejects(w.writePoints(slice(all, 0, 1000)), { code: "ABORTED", message: /the LAZ writer is closed/ }, "threads " + threads);
		await assert.rejects(w.close(), { code: "ABORTED", message: /the LAZ writer is closed/ }, "threads " + threads + ": a second close()");
		assert.deepEqual(sink.bytes(), file, "threads " + threads + ": the finished file is untouched");
		assert.deepEqual(file, await writeLas(all, Object.assign({ threads: 1 }, STREAM)));
		assert.equal(fake.closed, threads === 2 ? 1 : 0);
		// points sent while close() runs are refused too
		w = await createLasWriter(memorySink(64), opts);
		await w.writePoints(all);
		var closing = w.close();
		await assert.rejects(w.writePoints(slice(all, 0, 1000)), { code: "ABORTED" });
		assert.deepEqual(await closing, { count: 2500 });
	}
});

test("int32 overflow: the LAZ writers name the point's index in the caller's points, as the LAS writer does", async function () {
	var all = columns(6000);
	all.x[4321] = 1e12;   // past the first chunk and past writeLas's first 4-chunk step
	var opts = Object.assign({ threads: 1 }, STREAM);
	await assert.rejects(writeLas(all, { version: "1.2", pointFormat: 3, scale: SCALE, offset: OFFSET }), { code: "INVALID_ARGUMENT", message: /^point 4321 / }, "LAS");
	await assert.rejects(writeLas(all, opts), { code: "INVALID_ARGUMENT", message: /^point 4321 / }, "writeLas, LAZ");
	var w = await createLasWriter(memorySink(64), opts);
	await w.writePoints(slice(all, 0, 500));
	// the batch starts half way into a chunk; the bad point is its 3821st
	await assert.rejects(w.writePoints(slice(all, 500, 6000)), { code: "INVALID_ARGUMENT", message: /^point 3821 / }, "createLasWriter, LAZ");
});
