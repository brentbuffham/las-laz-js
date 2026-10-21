// test/laz/reader.test.js
//==========================================================
// LAZ through the public reader: openLas / readPoints / chunks /
// readPointsToScratch / the worker. Oracle: the uncompressed LAS each
// fixture was made from (helpers/lazFixtureData.js) — PDAL kept those
// records byte for byte (manifest pdalKeptRecords), so reading the
// LAZ and reading the LAS must give identical columns, with every
// option, in any window size.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { FIELD_TYPES } from "../../src/read/decodeRecords.js";
import { readChunks } from "../../src/laz/chunkTable.js";
import { createWorkerHandler } from "../../src/workers/workerProtocol.js";
import { openScratchReader } from "../../src/io/ScratchBinaryFile.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";
import { LAZ_FIXTURES, fixtureLas } from "../helpers/lazFixtureData.js";
import { LAZ_MANIFEST, fixtureBytes } from "../helpers/lazFixtureFiles.js";

var ALL = Object.keys(FIELD_TYPES);

function same(a, b, what) {
	assert.equal(a.count, b.count, what + " count");
	Object.keys(b).forEach(function (k) {
		if (ArrayBuffer.isView(b[k])) assert.deepEqual(Array.from(a[k]), Array.from(b[k]), what + " " + k);
	});
}

var ALL_FIXTURES = LAZ_FIXTURES;

ALL_FIXTURES.forEach(function (fx) {
	test(fx.name + ": readPoints of the LAZ equals readPoints of its LAS, every field", async function () {
		var laz = await openLas(fixtureBytes(fx.name));
		var las = await openLas(fixtureLas(fx));
		assert.equal(laz.compressed, true);
		assert.equal(laz.header.pointFormat, fx.pointFormat);
		same(await laz.readPoints({ fields: ALL }), await las.readPoints({ fields: ALL }), fx.name);
	});
});

test("windows smaller than a chunk, and larger than several, read the same points", async function () {
	var bytes = fixtureBytes("f3");
	var whole = await (await openLas(bytes)).readPoints({ fields: ["x", "y", "z", "gpsTime", "red"] });
	for (var size of [1000, 34 * 60000, 1 << 30]) {
		var r = await openLas(bytes, { windowSize: size });
		same(await r.readPoints({ fields: ["x", "y", "z", "gpsTime", "red"] }), whole, "window " + size);
		var n = 0, windows = 0;
		for await (var c of r.chunks({ fields: ["x"] })) { n += c.count; windows++; }
		assert.equal(n, LAZ_MANIFEST.f3.points);
		assert.equal(windows, size === 1000 ? 2 : 1, "window " + size + ": one window per chunk when the chunk is bigger");
	}
});

test("filters, maxPoints, localOrigin + float32 on LAZ give what they give on the LAS", async function () {
	var fx = LAZ_FIXTURES.find(function (f) { return f.name === "f3"; });
	var opts = { fields: ["x", "y", "z", "classification", "returnNumber"], classes: [2, 6], returns: [1], maxPoints: 1500, localOrigin: { x: 477050, y: 6770100, z: 300 }, float32: true };
	var a = await (await openLas(fixtureBytes("f3"), { windowSize: 200000 })).readPoints(opts);
	var b = await (await openLas(fixtureLas(fx))).readPoints(opts);
	assert.equal(a.count, 1500);                         // 2,031 pass the filters; thinned to 1,500
	assert.ok(a.x instanceof Float32Array);
	same(a, b, "filtered");
});

test("readPointsToScratch reads a LAZ into OPFS scratch files", async function () {
	var root = createFakeRoot();
	var las = await openLas(fixtureBytes("f1"));
	var res = await las.readPointsToScratch({ fields: ["x", "gpsTime"], root: root, prefix: "z" });
	var mem = await las.readPoints({ fields: ["x", "gpsTime"] });
	assert.equal(res.count, LAZ_MANIFEST.f1.points);
	var r = await openScratchReader(res.fields.gpsTime, { root: root });
	var copy = r.slice(0, r.length()).slice();
	r.close();
	assert.deepEqual(Array.from(new Float64Array(copy.buffer, copy.byteOffset, copy.byteLength / 8)), Array.from(mem.gpsTime));
});

test("the worker streams a LAZ file's chunks", async function () {
	var msgs = [];
	var handle = createWorkerHandler(function (m) { msgs.push(m); });
	await handle({ id: 1, type: "open", payload: { blob: new Blob([fixtureBytes("f3")]) } });
	assert.equal(msgs.pop().result.compressed, true);
	await handle({ id: 2, type: "chunks", payload: { fields: ["x", "y", "z"], colour: { by: "elevation" } } });
	var result = msgs.pop();
	assert.equal(result.type, "result", result.message);
	assert.equal(result.result.count, LAZ_MANIFEST.f3.points);
	assert.equal(msgs.filter(function (m) { return m.type === "chunk"; }).reduce(function (n, m) { return n + m.chunk.colours.length / 3; }, 0), LAZ_MANIFEST.f3.points);
});

test("a LAZ file cut short is TRUNCATED", async function () {
	var bytes = fixtureBytes("f3");
	await assert.rejects((await openLas(bytes.subarray(0, Math.floor(bytes.length / 2)))).readPoints({ fields: ["x"] }), { code: "TRUNCATED" });
});

test("a LAZ file without its LASzip VLR is BAD_VLR", async function () {
	var bytes = fixtureBytes("f0").slice();
	var v = new DataView(bytes.buffer);
	var at = v.getUint16(94, true);                       // first VLR follows the header
	bytes[at + 18] = 1; bytes[at + 19] = 0;              // record id 22204 -> 1
	await assert.rejects((await openLas(bytes)).readPoints({ fields: ["x"] }), { code: "BAD_VLR" });
});

// Rewrite item k of the LASzip VLR in a copy of a fixture
function withItem(name, k, type, version) {
	var bytes = fixtureBytes(name).slice(), v = new DataView(bytes.buffer);
	var at = v.getUint16(94, true);
	while (v.getUint16(at + 18, true) !== 22204) at += 54 + v.getUint16(at + 20, true);
	var item = at + 54 + 34 + k * 6;
	if (type !== null) v.setUint16(item, type, true);
	v.setUint16(item + 4, version, true);
	return bytes;
}

test("LASzip item version 1 and wave-packet items are UNSUPPORTED, by name", async function () {
	await assert.rejects((await openLas(withItem("f0", 0, null, 1))).readPoints({ fields: ["x"] }), function (e) { return e.code === "UNSUPPORTED" && /Point10 version 1/.test(e.message); });
	await assert.rejects((await openLas(withItem("f1", 1, 9, 2))).readPoints({ fields: ["x"] }), function (e) { return e.code === "UNSUPPORTED" && /WavePacket13/.test(e.message); });
	await assert.rejects((await openLas(withItem("f6", 0, null, 2))).readPoints({ fields: ["x"] }), function (e) { return e.code === "UNSUPPORTED" && /Point14 version 2/.test(e.message); });
	await assert.rejects((await openLas(withItem("f7", 1, 13, 3))).readPoints({ fields: ["x"] }), function (e) { return e.code === "UNSUPPORTED" && /WavePacket14/.test(e.message); });
});

test("reader.laz describes the compression; a LAS file has none", async function () {
	var laz = await openLas(fixtureBytes("f3"));
	assert.equal(laz.laz.compressor, 2);
	assert.equal(laz.laz.chunkSize, 50000);
	assert.deepEqual(laz.laz.items.map(function (i) { return i.type; }), [6, 7, 8]);
	assert.equal((await openLas(fixtureLas(LAZ_FIXTURES[3]))).laz, null);
});

test("LAS 1.4 layered LAZ: filters and windows on format 7 give what they give on its LAS", async function () {
	var fx = LAZ_FIXTURES.find(function (f) { return f.name === "f7"; });
	var opts = { fields: ["x", "z", "gpsTime", "red", "scannerChannel", "classification"], classes: [2, 9], maxPoints: 2000 };
	var a = await (await openLas(fixtureBytes("f7"), { windowSize: 1000 })).readPoints(opts);
	var b = await (await openLas(fixtureLas(fx))).readPoints(opts);
	assert.equal(a.count, 2000);
	same(a, b, "f7 filtered");
	assert.deepEqual(Array.from(new Set(b.scannerChannel)).sort(), [0, 1, 2, 3]);
});

test("a layered chunk cut short is TRUNCATED", async function () {
	var bytes = fixtureBytes("f6").slice();
	var las = await openLas(bytes);
	var start = las.header.offsetToPointData + 8 + 30 + 4;   // first record raw, then the point count, then layer sizes
	new DataView(bytes.buffer).setUint32(start + 4, 0x7FFFFFFF, true);   // the Z layer claims 2 GB
	await assert.rejects((await openLas(bytes)).readPoints({ fields: ["z"] }), { code: "TRUNCATED" });
});

test("a layered chunk whose first layer (channel, returns, XY) is empty is TRUNCATED, not a TypeError", async function () {
	var bytes = fixtureBytes("f6").slice();
	var start = (await openLas(bytes)).header.offsetToPointData + 8 + 30 + 4;
	new DataView(bytes.buffer).setUint32(start, 0, true);                // layer 0 size -> 0
	await assert.rejects((await openLas(bytes)).readPoints({ fields: ["x"] }), { code: "TRUNCATED" });
});

test("LAZ decode errors carry the FILE offset of the fault", async function () {
	var bytes = fixtureBytes("f3").slice();
	var las = await openLas(bytes);
	var src = { size: bytes.length, read: async function (s, e) { return bytes.subarray(s, e); } };
	var c1 = (await readChunks(src, las.header, las.laz))[1];              // the second chunk, ~390 KB into the file
	for (var i = c1.start + 200; i < c1.end; i++) bytes[i] = 0xFF;         // its data turns to garbage after 200 bytes
	var err = await (await openLas(bytes, { windowSize: 1000 })).readPoints({ fields: ["x"] }).then(function () { return null; }, function (e) { return e; });   // one chunk per window
	assert.ok(err, "the damaged chunk must fail");
	assert.equal(err.code, "TRUNCATED");
	assert.ok(err.offset >= c1.start + 200 && err.offset <= c1.end, "offset " + err.offset + " should lie in chunk 1 (" + c1.start + ".." + c1.end + ")");
});
