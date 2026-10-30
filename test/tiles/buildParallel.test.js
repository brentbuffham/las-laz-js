// test/tiles/buildParallel.test.js
//==========================================================
// buildTiles on the worker pool gives the same store, node for node
// and byte for byte, as one thread: raw and compressed, from a LAS
// and from a LAZ (decoded in the reader's pool, each window grouped by
// chunk in the build's).
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { buildTiles } from "../../src/tiles/build.js";
import { createLazPool } from "../../src/laz/pool.js";
import { tileLas } from "../helpers/tileFiles.js";
import { writeLas } from "../../src/write/writeLas.js";

async function blobs(store) {
	var out = {};
	for (var key of Object.keys(store.manifest.nodes)) out[key] = await store._backend.get(key + ".0.tile");
	return out;
}

test("threads 1 and 4 give the same store", { timeout: 120000 }, async function () {
	var bytes = tileLas({ pointFormat: 3, n: 120000, seed: 21, span: 500 });
	for (var compress of [false, true]) {
		var one = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 2000, chunkPoints: 20000, threads: 1, compress: compress });
		var four = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 2000, chunkPoints: 20000, threads: 4, compress: compress });
		assert.deepEqual(four.manifest.nodes, one.manifest.nodes);
		assert.ok(Object.keys(one.manifest.nodes).length > 30);
		var a = await blobs(one), b = await blobs(four);
		Object.keys(a).forEach(function (k) { assert.deepEqual(b[k], a[k], "node " + k + (compress ? " (compressed)" : "")); });
	}
});

test("from a LAZ: threads 1 and 4 give the same store", { timeout: 120000 }, async function () {
	var las = tileLas({ pointFormat: 3, n: 150000, seed: 22, span: 500 });
	var laz = await writeLas(await (await openLas(las)).readPoints(), { compress: true, pointFormat: 3, chunkSize: 5000 });
	var one = await buildTiles(await openLas(laz, { threads: 1 }), { where: { memory: true }, tilePoints: 2000, chunkPoints: 20000, threads: 1 });
	var four = await buildTiles(await openLas(laz, { threads: 4 }), { where: { memory: true }, tilePoints: 2000, chunkPoints: 20000, threads: 4 });
	assert.deepEqual(four.manifest.nodes, one.manifest.nodes);
	var a = await blobs(one), b = await blobs(four);
	Object.keys(a).forEach(function (k) { assert.deepEqual(b[k], a[k], "node " + k); });
});

test("pool.octree builds a chunk as buildChunkOctree does", { timeout: 60000 }, async function () {
	var { buildChunkOctree } = await import("../../src/tiles/octree.js");
	var { rawRecords, randomRaw } = await import("../helpers/tileClouds.js");
	var recs = rawRecords(randomRaw(20000, 4, 0, 100000), 20), cube = { min: [0, 0, 0], edge: 100000 }, opts = { tilePoints: 1000, maxDepth: 20, minEdge: 100 };
	var pool = await createLazPool(2);
	try {
		var got = await pool.octree({ records: recs.slice().buffer, recordLength: 20, cube: cube, rootKey: "0-0-0-0", opts: opts });
		var want = buildChunkOctree(recs, 20, cube, "0-0-0-0", opts);
		assert.deepEqual(got.map(function (n) { return n.key; }), want.map(function (n) { return n.key; }));
		got.forEach(function (n, i) { assert.equal(n.count, want[i].count); assert.deepEqual(n.records, want[i].records); });
	} finally {
		pool.close();
	}
});

test("a pool that does not answer step 5 in time: the nodes are packed on this thread, the same store", { timeout: 120000 }, async function () {
	var bytes = tileLas({ pointFormat: 3, n: 120000, seed: 23, span: 500 });
	var base = { where: { memory: true }, tilePoints: 2000, chunkPoints: 20000, compress: true };
	var ok = await buildTiles(await openLas(bytes), Object.assign({}, base, { threads: 4 }));
	var seen = [];
	// _packWait 0: every pool answer comes after the wait, as a lost reply would never come at all
	var late = await buildTiles(await openLas(bytes), Object.assign({}, base, { threads: 4, _packWait: 0, onProgress: function (p) { seen.push(p); } }));
	assert.deepEqual(late.manifest.nodes, ok.manifest.nodes);
	var a = await blobs(ok), b = await blobs(late);
	Object.keys(a).forEach(function (k) { assert.deepEqual(b[k], a[k], "node " + k); });
	var packs = seen.filter(function (p) { return p.phase === "pack"; });
	assert.ok(packs.length >= 2 && packs[packs.length - 1].done === packs[packs.length - 1].total, "the pack phase ends");
});
