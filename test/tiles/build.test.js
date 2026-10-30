// test/tiles/build.test.js
//==========================================================
// buildTiles: every point once (LAS and LAZ sources, formats 0 / 3 /
// 6 / 8, extra bytes), in its node's box; chunked equals one chunk as
// a whole; wrong header bounds, degenerate and empty clouds; an
// existing store, abort and compress refusals; progress by phase;
// reopen, orphan sweep and matches; compressed nodes.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { writeLas } from "../../src/write/writeLas.js";
import { buildTiles, planChunks } from "../../src/tiles/build.js";
import { openTiles, removeTiles, listTiles } from "../../src/tiles/TileStore.js";
import { nodeBox, parseKey } from "../../src/tiles/octree.js";
import { openBackend } from "../../src/tiles/backends.js";
import { eachBackend } from "../helpers/tileStores.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";
import { tileLas, sourceRecords, storeRecords, nodeRecords } from "../helpers/tileFiles.js";

// every field a point format holds, so a LAZ copy keeps each record byte for byte
export function allFields(fmt) {
	var f = ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scanAngle", "userData", "pointSourceId"];
	if (fmt !== 0 && fmt !== 2) f.push("gpsTime");
	if ([2, 3, 5, 7, 8, 10].indexOf(fmt) >= 0) f.push("red", "green", "blue");
	if (fmt >= 6) f.push("scannerChannel");
	if (fmt === 8 || fmt === 10) f.push("nir");
	return f.concat(["extra"]);
}

async function lazOf(bytes, fmt) {
	var las = await openLas(bytes);
	var pts = await las.readPoints({ fields: allFields(fmt) });
	return writeLas(pts, { version: fmt >= 6 ? "1.4" : "1.2", pointFormat: fmt, scale: las.header.scale, offset: las.header.offset, compress: true, extraBytes: las.extraBytes.length ? las.extraBytes : undefined });
}

async function checkStore(store, bytes, tilePoints) {
	assert.deepEqual(await storeRecords(store), sourceRecords(bytes));
	var m = store.manifest, total = 0, cube = m.cube, s = m.scale, o = m.offset;
	for (var key of Object.keys(m.nodes)) {
		var node = m.nodes[key], recs = await nodeRecords(store, key), v = new DataView(recs.buffer, recs.byteOffset, recs.byteLength), box = nodeBox(cube, key);
		total += node.count;
		assert.equal(recs.length, node.count * m.recordLength);
		for (var at = 0; at < recs.length; at += m.recordLength) {
			var X = v.getInt32(at, true), Y = v.getInt32(at + 4, true), Z = v.getInt32(at + 8, true);
			assert.ok(X >= box.min[0] && X <= box.max[0] && Y >= box.min[1] && Y <= box.max[1] && Z >= box.min[2] && Z <= box.max[2], "a point outside " + key);
			var x = X * s.x + o.x, y = Y * s.y + o.y, z = Z * s.z + o.z, b = node.box;
			assert.ok(x >= b[0] && y >= b[1] && z >= b[2] && x <= b[3] && y <= b[4] && z <= b[5], "a point outside the tight box of " + key);
		}
		var leaf = ![0, 1, 2, 3, 4, 5, 6, 7].some(function (q) { var k = parseKey(key); return m.nodes[(k[0] + 1) + "-" + (2 * k[1] + q % 2) + "-" + (2 * k[2] + Math.floor(q / 2) % 2) + "-" + (2 * k[3] + Math.floor(q / 4))]; });
		if (leaf && tilePoints) assert.ok(node.count <= tilePoints || parseKey(key)[0] >= 20, "leaf " + key + " holds " + node.count);
	}
	assert.equal(total, m.pointCount);
	assert.equal(store.count, m.pointCount);
}

eachBackend("every point once: formats 0, 3, 6 (extra bytes) and 8, LAS", async function (where) {
	for (var fmt of [0, 3, 6, 8]) {
		var bytes = tileLas({ pointFormat: fmt, n: 20000, seed: fmt + 1, extraBytes: fmt === 6 ? 2 : 0 });
		var store = await buildTiles(await openLas(bytes), { where: where, tilePoints: 1000, replace: true });
		await checkStore(store, bytes, 1000);
		assert.equal(store.manifest.pointFormat, fmt);
		if (fmt === 6) assert.equal(store.extraBytes.length, 1);   // the 2 bytes with no VLR: one raw field
		store.close();
	}
});

test("every point once from a LAZ source (formats 3 and 7)", async function () {
	for (var fmt of [3, 7]) {
		var bytes = tileLas({ pointFormat: fmt, n: 20000, seed: 40 + fmt });
		var laz = await lazOf(bytes, fmt);
		var store = await buildTiles(await openLas(laz, { threads: 1 }), { where: { memory: true }, tilePoints: 1000 });
		await checkStore(store, bytes, 1000);
	}
});

test("chunked equals one chunk, as a whole store", async function () {
	var bytes = tileLas({ n: 50000, seed: 9, span: 400 });
	var one = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 500, chunkPoints: 1e9 });
	var many = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 500, chunkPoints: 1000 });
	await checkStore(one, bytes, 500);
	await checkStore(many, bytes, 500);
	assert.ok(Object.keys(many.manifest.nodes).length > 20);
});

test("planChunks merges cells up while a group fits", function () {
	var G = 128, counts = new Uint32Array(G * G * G);
	counts[0] = 10; counts[1] = 10;                         // two cells of one depth-6 parent
	counts[G * G * G - 1] = 5000;                           // a cell over the limit on its own
	var chunks = planChunks(counts, 100);
	assert.equal(chunks.reduce(function (s, c) { return s + c.count; }, 0), 5020);
	assert.ok(chunks.some(function (c) { return c.key === "7-127-127-127" && c.count === 5000; }));
	var small = chunks.filter(function (c) { return c.count === 20; });
	assert.equal(small.length, 1);
	assert.ok(parseKey(small[0].key)[0] < 7, "the two small cells merged up");
	assert.deepEqual(planChunks(counts, 1e9).map(function (c) { return c.key; }), ["0-0-0-0"]);
	assert.deepEqual(planChunks(new Uint32Array(G * G * G), 100), []);
});

test("header bounds too small: every point kept", async function () {
	var bytes = tileLas({ n: 8000, seed: 3 });
	var v = new DataView(bytes.buffer);
	var minX = v.getFloat64(187, true), maxX = v.getFloat64(179, true);
	v.setFloat64(179, minX + (maxX - minX) / 2, true);
	v.setFloat64(211, v.getFloat64(219, true), true);       // maxZ = minZ
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 400 });
	await checkStore(store, bytes, 400);
});

test("degenerate clouds: one point 60,000 times, and a flat cloud", async function () {
	var same = tileLas({ n: 60000, same: true });
	var s1 = await buildTiles(await openLas(same), { where: { memory: true }, tilePoints: 1000 });
	await checkStore(s1, same, 0);
	assert.ok(s1.manifest.cube.edge >= 1);
	var flat = tileLas({ n: 20000, flatZ: 300, seed: 4 });
	var s2 = await buildTiles(await openLas(flat), { where: { memory: true }, tilePoints: 1000 });
	await checkStore(s2, flat, 1000);
});

test("an empty file builds a root of 0 points", async function () {
	var bytes = tileLas({ n: 0 });
	var store = await buildTiles(await openLas(bytes), { where: { memory: true } });
	assert.equal(store.count, 0);
	assert.deepEqual(Object.keys(store.manifest.nodes), ["0-0-0-0"]);
	assert.equal(store.manifest.nodes["0-0-0-0"].count, 0);
});

eachBackend("an existing store needs replace", async function (where) {
	var bytes = tileLas({ n: 3000, seed: 5 });
	await buildTiles(await openLas(bytes), { where: where });
	await assert.rejects(buildTiles(await openLas(bytes), { where: where }), function (e) { return e.code === "INVALID_ARGUMENT" && /replace: true/.test(e.message); });
	var again = await buildTiles(await openLas(bytes), { where: where, replace: true, tilePoints: 100 });
	await checkStore(again, bytes, 100);
});

eachBackend("abort removes the partial store", async function (where) {
	var bytes = tileLas({ n: 30000, seed: 6 });
	var ac = new AbortController();
	await assert.rejects(buildTiles(await openLas(bytes, { windowSize: 4096 }), { where: where, signal: ac.signal, onProgress: function (p) { if (p.phase === "distribute") ac.abort(); } }), function (e) { return e.code === "ABORTED"; });
	assert.deepEqual(await (await openBackend(where)).list(), []);
});

test("compress is refused for format 4 before any work", async function () {
	var bytes = tileLas({ pointFormat: 4, n: 10, version: "1.3" });
	var calls = 0;
	await assert.rejects(buildTiles(await openLas(bytes), { where: { memory: true }, compress: true, onProgress: function () { calls++; } }), function (e) { return e.code === "UNSUPPORTED"; });
	assert.equal(calls, 0);
});

test("bad options are refused", async function () {
	var las = await openLas(tileLas({ n: 10 }));
	for (var o of [{}, { where: { memory: true }, tilePoints: 0 }, { where: { memory: true }, chunkPoints: 1.5 }, { where: { memory: true }, onProgress: 3 }]) {
		await assert.rejects(buildTiles(las, o), function (e) { return e.code === "INVALID_ARGUMENT"; });
	}
});

test("progress climbs once per phase", async function () {
	var bytes = tileLas({ n: 20000, seed: 7 });
	var calls = [];
	await buildTiles(await openLas(bytes, { windowSize: 8192 }), { where: { memory: true }, tilePoints: 500, chunkPoints: 3000, compress: true, onProgress: function (p) { calls.push(p); } });
	var phases = [];
	calls.forEach(function (c) { if (phases[phases.length - 1] !== c.phase) phases.push(c.phase); });
	assert.deepEqual(phases, ["count", "distribute", "tiles", "pack"]);   // "pack": the chunk roots and the levels above, compressed last
	phases.forEach(function (ph) {
		var mine = calls.filter(function (c) { return c.phase === ph; });
		for (var i = 1; i < mine.length; i++) assert.ok(mine[i].done > mine[i - 1].done, ph + " does not climb");
		assert.equal(mine.filter(function (c) { return c.done === c.total; }).length, 1, ph + " ends once");
		assert.equal(mine[mine.length - 1].done, mine[mine.length - 1].total);
	});
});

eachBackend("reopen: the same manifest, orphans swept, matches", async function (where) {
	var bytes = tileLas({ n: 5000, seed: 8 });
	var built = await buildTiles(await openLas(bytes), { where: where, tilePoints: 500 });
	var be = await openBackend(where);
	await be.put("0-0-0-0.9.tile", new Uint8Array(4));
	await be.put("build/1-0-0-0.rec", new Uint8Array(4));
	built.close();
	var store = await openTiles(where);
	assert.deepEqual(store.manifest, built.manifest);
	var names = await be.list();
	assert.ok(names.indexOf("0-0-0-0.9.tile") < 0 && names.indexOf("build/1-0-0-0.rec") < 0, names.join());
	assert.equal(await store.matches(bytes), true);
	var changed = bytes.slice(); changed[300] = changed[300] ^ 1; // bits-ok
	assert.equal(await store.matches(changed), false);
	assert.equal(await store.matches(bytes.slice(0, bytes.length - 20)), false);
	await checkStore(store, bytes, 500);
	assert.equal(store.header.pointCount, 5000);
	await removeTiles(where);
	await assert.rejects(openTiles(where), function (e) { return e.code === "BAD_STORE" && /no tile store/.test(e.message); });
});

test("openTiles refuses a newer layout", async function () {
	var map = new Map();
	await buildTiles(await openLas(tileLas({ n: 100 })), { where: { memory: map } });
	var be = await openBackend({ memory: map });
	var { readManifest, writeManifest } = await import("../../src/tiles/manifest.js");
	var m = await readManifest(be);
	m.body.layout = 2;
	await writeManifest(be, m.body);
	await assert.rejects(openTiles({ memory: map }), function (e) { return e.code === "UNSUPPORTED" && /newer las-laz-js/.test(e.message); });
});

test("listTiles lists OPFS stores and clears unfinished ones", async function () {
	var root = createFakeRoot("root");
	var bytes = tileLas({ n: 2000, seed: 2 });
	await buildTiles(await openLas(bytes), { where: { opfs: "scan-a", root: root } });
	var half = await openBackend({ opfs: "scan-b", root: root });
	await half.put("0-0-0-0.0.tile", new Uint8Array(8));    // no manifest: an unfinished build
	var list = await listTiles({ root: root });
	assert.deepEqual(list.map(function (s) { return s.id; }), ["scan-a"]);
	assert.equal(list[0].points, 2000);
	assert.ok(list[0].bytes > 2000 * 20);
	assert.equal(list[0].source.size, bytes.length);
	assert.equal(typeof list[0].built, "number");
	assert.deepEqual(await half.list(), []);
});

test("compressed nodes decode to the raw nodes", async function () {
	var bytes = tileLas({ pointFormat: 3, n: 15000, seed: 12 });
	var raw = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 700 });
	var laz = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 700, compress: true });
	assert.deepEqual(Object.keys(laz.manifest.nodes), Object.keys(raw.manifest.nodes));
	assert.ok(laz.manifest.laz);
	for (var key of Object.keys(raw.manifest.nodes)) assert.deepEqual(await nodeRecords(laz, key), await nodeRecords(raw, key));
	assert.ok(laz.manifest.bytes < raw.manifest.bytes);
});
