// test/tiles/edges.test.js
//==========================================================
// The tile store's edge paths: OPFS writes on a thread with no sync
// handles; header bounds too small on every axis (the count pass runs
// again); EVLRs kept through a reopen; where named in errors; an empty
// OPFS; 64-bit and float added columns and their refusals; a selection
// box over an emptied node; the store's pool replaced for a new thread
// count; an empty node in a pooled read; writeTiles with no scratchId.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLas } from "../../src/LasReader.js";
import { buildTiles } from "../../src/tiles/build.js";
import { openTiles, listTiles } from "../../src/tiles/TileStore.js";
import { openBackend } from "../../src/tiles/backends.js";
import { compareKeys } from "../../src/tiles/octree.js";
import { createWorkerHandler } from "../../src/workers/workerProtocol.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";
import { buildLas } from "../helpers/buildLas.js";
import { tileLas, sourceRecords, storeRecords } from "../helpers/tileFiles.js";

// an OPFS root as the main thread sees it: files, but no synchronous access handles
function mainThreadRoot() {
	var root = createFakeRoot("root"), get = root.getDirectoryHandle;
	function strip(dir) {
		var fh = dir.getFileHandle, gd = dir.getDirectoryHandle;
		dir.getFileHandle = async function (n, o) { var h = await fh.call(dir, n, o); return { kind: "file", name: n, getFile: h.getFile }; };
		dir.getDirectoryHandle = async function (n, o) { return strip(await gd.call(dir, n, o)); };
		return dir;
	}
	root.getDirectoryHandle = async function (n, o) { return strip(await get.call(root, n, o)); };
	return root;
}

test("OPFS writes without sync handles are UNSUPPORTED, naming the Worker", async function () {
	var be = await openBackend({ opfs: "m", root: mainThreadRoot() });
	for (var op of [function () { return be.put("a.tile", new Uint8Array(4)); }, function () { return be.appender("build/a.rec"); }, function () { return be.lock(); }]) {
		await assert.rejects(op(), function (e) { return e.code === "UNSUPPORTED" && /needs a Worker/.test(e.message); });
	}
	assert.equal(await be.get("a.tile"), null);
});

test("header bounds too small on every axis: the count pass runs again on the true bounds", async function () {
	var bytes = tileLas({ n: 6000, seed: 13 }), v = new DataView(bytes.buffer);
	v.setFloat64(179, v.getFloat64(187, true), true); v.setFloat64(195, v.getFloat64(203, true), true); v.setFloat64(211, v.getFloat64(219, true), true);
	var calls = [];
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 300, onProgress: function (p) { if (p.phase === "count") calls.push(p.done); } });
	assert.deepEqual(await storeRecords(store), sourceRecords(bytes));
	assert.equal(calls.filter(function (d) { return d === 6000; }).length, 1, "the count phase ends once, the second pass silent");
	assert.ok(store.manifest.cube.edge > 100000, "the cube is the true extent, not the header's point");
});

test("EVLRs survive a reopen", async function () {
	var pts = [{ x: 1, y: 2, z: 3, gpsTime: 1 }, { x: 4, y: 5, z: 6, gpsTime: 2 }];
	var bytes = buildLas({ version: "1.4", pointFormat: 6, points: pts, evlrs: [{ userId: "acme", recordId: 77, description: "notes", bytes: new Uint8Array([1, 2, 250, 251, 0, 9]) }] });
	var map = new Map();
	await buildTiles(await openLas(bytes), { where: { memory: map } });
	var store = await openTiles({ memory: map });
	assert.equal(store.evlrs.length, 1);
	assert.deepEqual(Array.from(store.evlrs[0].bytes), [1, 2, 250, 251, 0, 9]);
	assert.equal(store.evlrs[0].userId, "acme");
});

test("errors name the where; an empty OPFS lists no stores", async function () {
	var root = createFakeRoot("root");
	await assert.rejects(openTiles({ opfs: "none", root: root }), function (e) { return e.code === "BAD_STORE" && /\{ opfs: "none" \}/.test(e.message); });
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "las-tiles-"));
	try { await assert.rejects(openTiles({ dir: dir }), function (e) { return e.code === "BAD_STORE" && e.message.indexOf(dir) >= 0; }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
	assert.deepEqual(await listTiles({ root: root }), []);
	var map = new Map();
	await buildTiles(await openLas(tileLas({ n: 50 })), { where: { memory: map } });
	map.delete("source.head");
	await assert.rejects(openTiles({ memory: map }), function (e) { return e.code === "BAD_STORE" && /source header/.test(e.message); });
});

test("64-bit and float added columns; their refusals", async function () {
	var store = await buildTiles(await openLas(tileLas({ pointFormat: 3, n: 3000, seed: 14 })), { where: { memory: true }, tilePoints: 400 });
	await store.addColumn("id64", "u64", 5n);
	assert.deepEqual(store.manifest.columns[0], { name: "id64", type: "u64", fill: "5" });
	var sel = await store.selectBox({ minX: 478000, maxX: 478060 });
	await store.setColumn(sel, "id64", 18446744073709551615n);
	var k = Object.keys(sel.tiles)[0], t = await store.readTile(k, { fields: ["id64"] });
	assert.equal(t.id64[sel.tiles[k][0]], 18446744073709551615n);
	await store.addColumn("w", "f32", 0.5);
	await assert.rejects(store.setColumn(sel, "id64", 1.5), /whole number \(or BigInt\)/);
	await assert.rejects(store.setColumn(sel, "id64", -1n), /outside 0 to 18446744073709551615/);
	await assert.rejects(store.setColumn(sel, "w", "a"), /must be a number/);
	await assert.rejects(store.setColumn(sel, "w", 1e39), /out of range/);
	await assert.rejects(store.addColumn("", "u8", 0), /1 to 32 characters/);
	var perTile = {};
	Object.keys(sel.tiles).forEach(function (key) { perTile[key] = new Uint8Array(1); });
	await assert.rejects(store.setColumn(sel, "classification", perTile), /one value for each/);
	var s0 = await buildTiles(await openLas(tileLas({ pointFormat: 0, n: 200 })), { where: { memory: true } });
	await assert.rejects(s0.setColumn(await s0.selectBox({}), "red", 1), /point format 0 has no colour/);
	await assert.rejects(store.setColumn({ deletes: 0, count: 1, tiles: { "9-9-9-9": Uint32Array.of(0) } }, "classification", 1), /not in the store/);
	await assert.rejects(store.deletePoints(null), /tile selection is needed/);
});

test("a selection box over an emptied node skips it", async function () {
	var store = await buildTiles(await openLas(tileLas({ n: 20000, seed: 15, flatZ: 300 })), { where: { memory: true }, tilePoints: 400 });
	await store.keepPoints(await store.selectBox({ minX: 478000, maxX: 478020, minY: 6772000, maxY: 6772020 }));
	var empty = Object.keys(store.manifest.nodes).filter(function (k) { return !store.manifest.nodes[k].count; });
	assert.ok(empty.length);
	var sel = await store.select(function (cols) { return cols.count ? Uint32Array.of(0) : null; }, { box: { minX: 478000, maxX: 478200 } });
	Object.keys(sel.tiles).forEach(function (k) { assert.ok(store.manifest.nodes[k].count > 0); });
	await assert.rejects(store.select(3), /needs a function/);
	await assert.rejects(store.selectBox(null), /box must be an object/);
	await assert.rejects(store.selectPolygon([1, 2]), /3 or more vertices/);
	var z = await store.selectPolygon([478000, 6772000, 478020, 6772000, 478020, 6772020], { minZ: 0, maxZ: 1000, tolerance: 0.5 });
	assert.ok(z.count > 0);
	assert.ok(compareKeys("1-0-0-0", "1-0-0-0") === 0);
});

test("the store's pool is replaced for another thread count; empty nodes read on a pool", { timeout: 60000 }, async function () {
	var store = await buildTiles(await openLas(tileLas({ n: 20000, seed: 16, flatZ: 300 })), { where: { memory: true }, tilePoints: 400, compress: true });
	await store.keepPoints(await store.selectBox({ minX: 478000, maxX: 478030, minY: 6772000, maxY: 6772030 }));
	var keys = Object.keys(store.manifest.nodes), got = [];
	for await (var a of store.readTiles(keys, { fields: ["x"], threads: 2 })) got.push(a.points.count);
	assert.deepEqual(got, keys.map(function (k) { return store.manifest.nodes[k].count; }));
	var first = store._pool;
	for await (var b of store.readTiles(keys.slice(0, 3), { fields: ["x"], threads: 3 })) assert.ok(b.points.count >= 0);
	assert.notEqual(store._pool, first);
	store.close();
});

test("writeTiles needs a scratchId", async function () {
	var msgs = [], h = createWorkerHandler(function (m) { msgs.push(m); });
	await h({ id: 1, type: "open", payload: { blob: new Blob([tileLas({ n: 50 })]) } });
	await h({ id: 2, type: "buildTiles", payload: { where: { memory: true } } });
	await h({ id: 3, type: "writeTiles", payload: {} });
	assert.match(msgs.filter(function (m) { return m.id === 3; }).pop().message, /scratchId/);
	await h({ id: 4, type: "closeTiles" });
	await h({ id: 5, type: "selectBox", payload: { box: {} } });
	assert.match(msgs.filter(function (m) { return m.id === 5; }).pop().message, /no tile store is open/);
});

test("OPFS from navigator.storage when no root is given; other errors pass through", async function () {
	var root = createFakeRoot("root"), real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { hardwareConcurrency: 2, storage: { getDirectory: async function () { return root; } } } });
	try {
		await buildTiles(await openLas(tileLas({ n: 100 })), { where: { opfs: "nav" } });
		assert.deepEqual((await listTiles()).map(function (s) { return s.id; }), ["nav"]);
		assert.equal((await openTiles({ opfs: "nav" })).count, 100);
	} finally {
		Object.defineProperty(globalThis, "navigator", real);
	}
	// a file that will not read, and a lock refused for another reason: their errors, as they are
	var bad = createFakeRoot("bad"), gd = bad.getDirectoryHandle;
	bad.getDirectoryHandle = async function (n, o) {
		var d = await gd.call(bad, n, o), dd = d.getDirectoryHandle;
		d.getDirectoryHandle = async function (n2, o2) {
			var e = await dd.call(d, n2, o2);
			e.getFileHandle = async function () { return { getFile: async function () { throw new Error("disk read failed"); }, createSyncAccessHandle: async function () { throw new Error("quota"); } }; };
			return e;
		};
		return d;
	};
	var be = await openBackend({ opfs: "x", root: bad });
	await assert.rejects(be.get("a.tile"), /disk read failed/);
	await assert.rejects(be.lock(), /quota/);
});

test("matches: name and date when both sides know them; a path; a file that is not LAS", async function () {
	var bytes = tileLas({ n: 300, seed: 17 }), file = new File([bytes], "scan.las", { lastModified: 1000 });
	var store = await buildTiles(await openLas(file), { where: { memory: true } });
	assert.equal(store.manifest.source.name, "scan.las");
	assert.equal(await store.matches(new File([bytes], "scan.las", { lastModified: 1000 })), true);
	assert.equal(await store.matches(new File([bytes], "other.las", { lastModified: 1000 })), false);
	assert.equal(await store.matches(new File([bytes], "scan.las", { lastModified: 2000 })), false);
	assert.equal(await store.matches(await openLas(bytes)), true);
	assert.equal(await store.matches(new Uint8Array(10)), false);
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "las-tiles-")), p = path.join(dir, "scan.las");
	try { fs.writeFileSync(p, bytes); assert.equal(await store.matches(p), true); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("listTiles leaves an unfinished build that another worker holds", async function () {
	var root = createFakeRoot("root");
	var busy = await openBackend({ opfs: "busy", root: root });
	await busy.put("0-0-0-0.0.tile", new Uint8Array(4));
	await busy.lock();
	assert.deepEqual(await listTiles({ root: root }), []);
	assert.ok((await busy.list()).length, "its files are still there");
	busy.unlock();
});

test("write-out: CRS, class names, version and point format", async function () {
	var { geoKeyBytes } = await import("../helpers/buildLas.js");
	var { buildClassLookup } = await import("../../src/format/ClassLookup.js");
	var pts = [];
	for (var i = 0; i < 200; i++) pts.push({ x: 478000 + i, y: 6772000 + i, z: 300, classification: 2, gpsTime: i });
	var wkt = 'PROJCS["GDA94 / MGA zone 50"]';
	var vlrs = [{ userId: "LASF_Projection", recordId: 2112, bytes: new TextEncoder().encode(wkt) }, { userId: "LASF_Spec", recordId: 0, bytes: buildClassLookup({ 64: "Bench face" }) }];
	var store = await buildTiles(await openLas(buildLas({ version: "1.4", pointFormat: 6, points: pts, vlrs: vlrs, globalEncoding: 16 })), { where: { memory: true } });
	var { memorySink } = await import("../helpers/sinks.js");
	var sink = memorySink();
	await store.writeLas(sink, { version: "1.4", pointFormat: 7 });
	var back = await openLas(sink.bytes());
	assert.equal(back.header.pointFormat, 7);
	assert.equal(back.crs.wkt, wkt);
	assert.deepEqual(back.classNames, { 64: "Bench face" });
	// an EPSG code alone cannot go into formats 6-10: written without a CRS, as any save
	var epsg = await buildTiles(await openLas(buildLas({ version: "1.4", pointFormat: 6, points: pts, vlrs: [{ userId: "LASF_Projection", recordId: 34735, bytes: geoKeyBytes([[1024, 1], [3072, 28350]]) }] })), { where: { memory: true } });
	var s2 = memorySink();
	await epsg.writeLas(s2);
	assert.equal((await openLas(s2.bytes())).crs.kind, null);
	var s3 = memorySink(), legacy = await buildTiles(await openLas(buildLas({ version: "1.2", pointFormat: 1, points: pts, vlrs: [{ userId: "LASF_Projection", recordId: 34735, bytes: geoKeyBytes([[1024, 1], [3072, 28350]]) }] })), { where: { memory: true } });
	await legacy.writeLas(s3);
	assert.equal((await openLas(s3.bytes())).crs.epsg, 28350);
});

test("readTile without options, and readTiles on one thread", async function () {
	var store = await buildTiles(await openLas(tileLas({ pointFormat: 3, n: 2000, seed: 18 })), { where: { memory: true }, tilePoints: 300, compress: true });
	var t = await store.readTile("0-0-0-0");
	assert.ok(t.x && t.classification && t.red, "readPoints' default fields");
	var keys = Object.keys(store.manifest.nodes), n = 0;
	for await (var r of store.readTiles(keys, { threads: 1 })) n += r.points.count;
	assert.equal(n, 2000);
	assert.equal(store._pool, undefined, "one thread: no pool");
});

test("small paths: a tile with no columns, a slot with no body, folder errors, option types, NaN in a float column", async function () {
	var { encodeTile, decodeTile } = await import("../../src/tiles/tileFile.js");
	var { readManifest, writeManifest } = await import("../../src/tiles/manifest.js");
	var t = decodeTile(encodeTile({ count: 1, records: new Uint8Array(20), compressed: false }), [], "a");
	assert.deepEqual(t.columns, []);
	var be = await openBackend({ memory: new Map() });
	await writeManifest(be, { n: 1 });
	await be.put("store-b.json", new TextEncoder().encode(JSON.stringify({ seq: 9, sum: 0 })));
	assert.deepEqual(await readManifest(be), { seq: 1, body: { n: 1 } });
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "las-tiles-"));
	try {
		var d = await openBackend({ dir: dir + "/" });
		fs.mkdirSync(path.join(dir, "sub.tile"));
		await assert.rejects(d.get("sub.tile"), function (e) { return e.code !== "ENOENT"; });
		await assert.rejects(d.remove("sub.tile"), function (e) { return e.code !== "ENOENT"; });
		fs.writeFileSync(path.join(dir, "flat"), "x");
		var f = await openBackend({ dir: path.join(dir, "flat") });
		await assert.rejects(f.list(), function (e) { return e.code !== "ENOENT"; });
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	var las = await openLas(tileLas({ n: 20 }));
	await assert.rejects(buildTiles(las, { where: { memory: true }, tilePoints: "5" }), /whole number/);
	await assert.rejects(buildTiles(las, { where: { memory: true }, threads: -1 }), /whole number/);
	await assert.rejects(buildTiles({}, { where: { memory: true } }), /needs a LasReader/);
	var store = await buildTiles(await openLas(tileLas({ n: 500, seed: 19 })), { where: { memory: true } });
	await store.addColumn("g", "f64", NaN);
	await store.addColumn("h", "i64", -3);
	var sel = await store.selectBox({});
	await store.setColumn(sel, "g", Infinity);
	var r = await store.readTile("0-0-0-0", { fields: ["g", "h"] });
	assert.equal(r.g[0], Infinity);
	assert.equal(r.h[0], -3n);
});
