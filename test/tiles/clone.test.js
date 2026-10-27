// test/tiles/clone.test.js
//==========================================================
// cloneStore: the copy holds the same nodes, points and added columns
// (raw and compressed stores, memory and a folder, opened again),
// edits to either leave the other as it was; refused for the same
// place, a store already there (unless replace), a store changed
// elsewhere; an abort leaves nothing behind.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLas } from "../../src/LasReader.js";
import { buildTiles } from "../../src/tiles/build.js";
import { openTiles } from "../../src/tiles/TileStore.js";
import { cloneStore } from "../../src/tiles/clone.js";
import { tileLas } from "../helpers/tileFiles.js";

var BYTES = tileLas({ pointFormat: 3, n: 12000, seed: 81 });
var BOX = { minX: 478040, maxX: 478120, minY: 6772030, maxY: 6772150 };

async function build(extra) { return buildTiles(await openLas(BYTES), Object.assign({ where: { memory: new Map() }, tilePoints: 600 }, extra || {})); }

// every node's points and added columns, as plain arrays
async function contents(store) {
	var out = {}, cols = store.manifest.columns.map(function (c) { return c.name; });
	for (var key of Object.keys(store.manifest.nodes)) {
		var t = await store.readTile(key, { fields: ["x", "y", "z", "intensity", "gpsTime", "red"].concat(cols) });
		out[key] = {};
		["x", "y", "z", "intensity", "gpsTime", "red"].concat(cols).forEach(function (f) { out[key][f] = Array.from(t[f]); });
	}
	return out;
}

test("cloneStore: the same nodes, points and columns; edits stay apart", async function () {
	for (var compress of [false, true]) {
		var store = await build({ compress: compress });
		await store.addColumn("fragment", "u32", 7);
		var copy = await cloneStore(store, { memory: new Map() });
		assert.deepEqual(copy.manifest, store.manifest, "compress " + compress + ": the manifest");
		assert.deepEqual(copy.header, store.header);
		assert.deepEqual(await contents(copy), await contents(store), "compress " + compress + ": the points");
		var before = store.count;
		await copy.deletePoints(await copy.selectBox(BOX));
		assert.ok(copy.count < before);
		assert.equal(store.count, before, "the source keeps its points");
		await store.setColumn(await store.selectBox(BOX), "fragment", 9);
		var t = await copy.readTile("0-0-0-0", { fields: ["fragment"] });
		assert.ok(Array.from(t.fragment).every(function (v) { return v === 7; }), "the copy keeps its column");
	}
});

test("cloneStore to a folder: opened again, the same points", async function () {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "las-clone-"));
	try {
		var store = await build(), seen = [];
		var copy = await cloneStore(store, { dir: dir }, { onProgress: function (p) { seen.push(p); } });
		copy.close();
		var again = await openTiles({ dir: dir });
		assert.deepEqual(await contents(again), await contents(store));
		assert.equal(seen[seen.length - 1].done, seen[seen.length - 1].total);
		assert.equal(seen[0].phase, "clone");
		again.close();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("cloneStore refuses the same place, a store already there, a store changed elsewhere", async function () {
	var map = new Map(), store = await buildTiles(await openLas(BYTES), { where: { memory: map }, tilePoints: 600 });
	await assert.rejects(cloneStore(store, { memory: map }), /another where/);
	var there = new Map();
	await cloneStore(store, { memory: there });
	await assert.rejects(cloneStore(store, { memory: there }), /already exists/);
	var replaced = await cloneStore(store, { memory: there }, { replace: true });
	assert.equal(replaced.count, store.count);
	// another handle on the same store edits it: this one's copy is refused, and leaves nothing
	var other = await openTiles({ memory: map });
	await other.deletePoints(await other.selectBox(BOX));
	var target = new Map();
	await assert.rejects(cloneStore(store, { memory: target }), function (e) { return e.code === "BAD_STORE"; });
	assert.equal(target.size, 0);
});

test("cloneStore aborted leaves nothing behind", async function () {
	var store = await build(), target = new Map(), ac = new AbortController();
	var p = cloneStore(store, { memory: target }, { signal: ac.signal, onProgress: function () { ac.abort(); } });
	await assert.rejects(p, function (e) { return e.code === "ABORTED"; });
	assert.equal(target.size, 0);
});
