// test/tiles/review.test.js
//==========================================================
// The final review's findings, each pinned:
//  C1  edits on one store one at a time; a store changed elsewhere is
//      refused, not overwritten; the open-time sweep and a read racing
//      an edit; a manifest that landed before its write threw
//  I1  a far outlier (or a dense spot) still gives chunks within
//      chunkPoints
//  I2  an edit writes each node as it goes, not all at the end
//  I2b replace refuses before it deletes the old store
//  I3  a tile's children are found where they reach past its own points
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { buildTiles } from "../../src/tiles/build.js";
import { openTiles } from "../../src/tiles/TileStore.js";
import { selectTiles } from "../../src/tiles/select.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";
import { buildLas } from "../helpers/buildLas.js";
import { rng } from "../helpers/clouds.js";
import { tileLas, sourceRecords, storeRecords } from "../helpers/tileFiles.js";
import { orthographic, lookAt, multiply } from "../helpers/cameras.js";

var BOX = { minX: 478040, maxX: 478120, minY: 6772030, maxY: 6772150 };

async function classCount(store, cls) {
	var n = 0;
	for (var key of Object.keys(store.manifest.nodes)) {
		var t = await store.readTile(key, { fields: ["classification"] });
		for (var i = 0; i < t.count; i++) if (t.classification[i] === cls) n++;
	}
	return n;
}

// C1 ------------------------------------------------------------------------

test("C1: two edits at once on one store both land", async function () {
	var map = new Map(), store = await buildTiles(await openLas(tileLas({ pointFormat: 7, n: 8000, seed: 201 })), { where: { memory: map }, tilePoints: 500 });
	var sel = await store.selectBox(BOX);
	await Promise.all([store.addColumn("facet", "i32", -1), store.setColumn(sel, "classification", 9)]);
	var again = await openTiles({ memory: map });
	assert.deepEqual(again.manifest.columns.map(function (c) { return c.name; }), ["facet"]);
	assert.equal(await classCount(again, 9), sel.count);
	var del = await again.selectBox(BOX);
	await Promise.all([again.deletePoints(del), again.addColumn("set", "u8", 0)]);
	var third = await openTiles({ memory: map });
	assert.equal(third.count, 8000 - sel.count);
	assert.equal(third.manifest.deletes, 1);
	assert.deepEqual(third.manifest.columns.map(function (c) { return c.name; }), ["facet", "set"]);
});

test("C1: a store changed elsewhere refuses a stale edit; the store stays whole", async function () {
	var map = new Map();
	await buildTiles(await openLas(tileLas({ pointFormat: 7, n: 8000, seed: 202 })), { where: { memory: map }, tilePoints: 500 });
	var a = await openTiles({ memory: map }), b = await openTiles({ memory: map });
	var stale = await a.selectClasses([1, 2]), gone = await b.selectBox(BOX);
	await b.deletePoints(gone);
	await assert.rejects(a.readTile("0-0-0-0"), function (e) { return e.code === "BAD_STORE" && /another tab/.test(e.message); });
	await assert.rejects(a.setColumn(stale, "classification", 3), function (e) { return e.code === "BAD_STORE" && /changed/.test(e.message); });
	await assert.rejects(a.addColumn("facet", "i32", 0), function (e) { return e.code === "BAD_STORE"; });
	var c = await openTiles({ memory: map });
	assert.equal(c.count, 8000 - gone.count);
	for (var key of Object.keys(c.manifest.nodes)) await c.readTile(key);   // every file there
});

test("C1: the open-time sweep keeps an edit committed while it opened", async function () {
	var root = createFakeRoot("root"), where = { opfs: "s", root: root };
	await buildTiles(await openLas(tileLas({ n: 6000, seed: 203, flatZ: 300 })), { where: where, tilePoints: 400 });
	var b = await openTiles(where), sel = await b.selectBox(BOX);
	var dir = await (await root.getDirectoryHandle("las-tiles")).getDirectoryHandle("s");
	var head = await dir.getFileHandle("source.head"), getFile = head.getFile, once = true;
	head.getFile = async function () {
		if (once) { once = false; await b.deletePoints(sel); }   // another worker edits while this one opens
		return getFile.call(head);
	};
	await openTiles(where);
	var c = await openTiles(where);
	assert.equal(c.count, 6000 - sel.count);
	for (var key of Object.keys(c.manifest.nodes)) await c.readTile(key);
});

test("C1: a read racing an edit reads the new generation", async function () {
	var store = await buildTiles(await openLas(tileLas({ pointFormat: 7, n: 6000, seed: 204 })), { where: { memory: true }, tilePoints: 500 });
	var sel = await store.selectBox(BOX), key = Object.keys(sel.tiles)[0];
	var be = store._backend, get = be.get, once = true;
	be.get = async function (name) {
		if (once && name === key + "." + store.manifest.nodes[key].gen + ".tile") { once = false; await store.setColumn(sel, "classification", 12); }
		return get.call(be, name);
	};
	var t = await store.readTile(key, { fields: ["classification"] });
	assert.equal(t.classification[sel.tiles[key][0]], 12);
});

test("C1: a manifest that landed before its write threw keeps its files", async function () {
	var map = new Map(), store = await buildTiles(await openLas(tileLas({ pointFormat: 7, n: 6000, seed: 205 })), { where: { memory: map }, tilePoints: 500 });
	var be = store._backend, put = be.put, failed = false;
	be.put = async function (name, bytes) {
		await put.call(be, name, bytes);
		if (/^store-[ab]\.json$/.test(name) && !failed) { failed = true; throw new Error("flush failed after the write"); }
	};
	var sel = await store.selectBox(BOX);
	await assert.rejects(store.deletePoints(sel), /flush failed/);
	var again = await openTiles({ memory: map });
	assert.equal(again.count, 6000 - sel.count);
	for (var key of Object.keys(again.manifest.nodes)) await again.readTile(key);
});

// I1 ------------------------------------------------------------------------

test("I1: a far outlier still gives chunks within chunkPoints", async function () {
	var r = rng(206), pts = [];
	for (var i = 0; i < 50000; i++) pts.push({ x: 478000 + r() * 200, y: 6772000 + r() * 200, z: 300 + r() * 20, gpsTime: i, intensity: i % 65536 });
	pts.push({ x: 578000, y: 6772000, z: 300, gpsTime: 50000 });   // one noise return 100 km away
	var bytes = buildLas({ pointFormat: 1, points: pts, offset: { x: 478000, y: 6772000, z: 0 } });
	var chunks = null;
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, chunkPoints: 10000, tilePoints: 2000, _chunks: function (c) { chunks = c; } });
	assert.ok(chunks.length >= 5, chunks.length + " chunks");
	chunks.forEach(function (c) { assert.ok(c.count <= 10000, "chunk " + c.key + " holds " + c.count); });
	assert.deepEqual(await storeRecords(store), sourceRecords(bytes));
});

// I2 ------------------------------------------------------------------------

test("I2: an edit writes each node as it goes", async function () {
	var store = await buildTiles(await openLas(tileLas({ n: 20000, seed: 207, flatZ: 300 })), { where: { memory: true }, tilePoints: 300 });
	var be = store._backend, get = be.get, put = be.put, log = [];
	be.get = function (name) { if (/\.tile$/.test(name)) log.push("get"); return get.call(be, name); };
	be.put = function (name, bytes) { if (/\.tile$/.test(name)) log.push("put"); return put.call(be, name, bytes); };
	await store.addColumn("facet", "i32", 0);
	assert.ok(Object.keys(store.manifest.nodes).length > 20);
	assert.ok(log.indexOf("put") < log.lastIndexOf("get"), "a node is written before the last one is read");
});

// I2b -----------------------------------------------------------------------

function noSyncHandles(root) {
	function strip(dir) {
		var fh = dir.getFileHandle, gd = dir.getDirectoryHandle, wrapped = Object.create(dir);
		wrapped.getFileHandle = async function (n, o) { var h = await fh.call(dir, n, o); return { kind: "file", name: n, getFile: h.getFile }; };
		wrapped.getDirectoryHandle = async function (n, o) { return strip(await gd.call(dir, n, o)); };
		wrapped.values = dir.values;
		wrapped.removeEntry = dir.removeEntry;
		return wrapped;
	}
	return strip(root);
}

test("I2b: replace on a thread that cannot write refuses before deleting the old store", async function () {
	var root = createFakeRoot("root"), bytes = tileLas({ n: 3000, seed: 208 });
	await buildTiles(await openLas(bytes), { where: { opfs: "keep", root: root } });
	await assert.rejects(buildTiles(await openLas(bytes), { where: { opfs: "keep", root: noSyncHandles(root) }, replace: true }), function (e) { return e.code === "UNSUPPORTED"; });
	assert.equal((await openTiles({ opfs: "keep", root: root })).count, 3000);
});

// I3 ------------------------------------------------------------------------

test("I3: a view of a cloud's edge finds the tiles there, past their parent's own points", async function () {
	var bytes = tileLas({ n: 200000, seed: 209, span: 2000, flatZ: 300 });
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 2000 });
	var m = store.manifest, maxX = -Infinity;
	var pts = [];
	for (var key of Object.keys(m.nodes)) {
		var t = await store.readTile(key, { fields: ["x", "y"] });
		for (var i = 0; i < t.count; i++) { pts.push([key, t.x[i], t.y[i]]); if (t.x[i] > maxX) maxX = t.x[i]; }
	}
	assert.ok(m.nodes["0-0-0-0"].box[3] < maxX - 0.3, "the root's own points stop short of the edge");
	// looking straight down at a 0.6 m strip along the cloud's max-X edge
	var cx = maxX - 0.3, cy = 6772000 + 1000;
	var view = { viewProjection: multiply(orthographic(-0.3, 0.3, 1000, -1000, 1, 1000), lookAt([cx, cy, 600], [cx, cy, 300], [0, 1, 0])), width: 400, height: 1000, pointBudget: 1e9, minPixels: 0 };
	var picked = new Set(selectTiles(store, view).map(function (n) { return n.key; }));
	var inStrip = pts.filter(function (p) { return p[1] >= maxX - 0.6; });
	assert.ok(inStrip.length > 10);
	inStrip.forEach(function (p) { assert.ok(picked.has(p[0]), "a point in the strip is in tile " + p[0] + ", which was not picked"); });
});
