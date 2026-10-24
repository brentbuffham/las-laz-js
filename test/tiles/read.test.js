// test/tiles/read.test.js
//==========================================================
// readTile / readTiles against readPoints of the source: each tile
// point found in the source by its GPS time (unique per point), every
// field equal; local origin and Float32; the store transform as
// readPoints' transform; LAZ tiles on a pool; unknown keys and fields.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { buildTiles } from "../../src/tiles/build.js";
import { makeTransform } from "../../src/ops/transform.js";
import { tileLas } from "../helpers/tileFiles.js";

var FIELDS = ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "classification", "classificationFlags", "userData", "pointSourceId", "gpsTime", "red", "green", "blue", "extra"];
var bytes = tileLas({ pointFormat: 3, n: 12000, seed: 41, extraBytes: 3 });

async function compare(store, opts, readOpts, check) {
	var src = await (await openLas(bytes)).readPoints(Object.assign({ fields: FIELDS }, readOpts));
	var at = new Map();
	for (var i = 0; i < src.count; i++) at.set(Math.round(src.gpsTime[i] * 1000), i);
	var seen = 0;
	for (var key of Object.keys(store.manifest.nodes)) {
		var t = await store.readTile(key, Object.assign({ fields: FIELDS }, opts));
		assert.equal(t.count, store.manifest.nodes[key].count);
		for (var j = 0; j < t.count; j++) {
			var s = at.get(Math.round(t.gpsTime[j] * 1000));
			FIELDS.filter(function (f) { return f !== "extra"; }).concat(["extraBytes"]).forEach(function (f) {
				if (f === "extraBytes") { for (var e = 0; e < 3; e++) assert.equal(t.extraBytes[3 * j + e], src.extraBytes[3 * s + e]); return; }
				check(f, t[f][j], src[f][s], key);
			});
			seen++;
		}
		if (opts.float32) assert.ok(t.x instanceof Float32Array);
	}
	assert.equal(seen, 12000);
}

function exact(f, a, b, key) { assert.equal(a, b, f + " in " + key); }

test("readTile equals readPoints of the same points", async function () {
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 800 });
	await compare(store, {}, {}, exact);
	var origin = { x: 478000, y: 6772000, z: 0 };
	await compare(store, { localOrigin: origin, float32: true }, { localOrigin: origin, float32: true }, exact);
});

test("the store transform reads as readPoints' transform", async function () {
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 800 });
	var T = makeTransform({ rotateZ: 12, shift: [100, -50, 3], about: [478100, 6772100, 0] });
	store.manifest.transform = { m: Array.from(T.m), t: Array.from(T.t) };
	await compare(store, {}, { transform: T }, function (f, a, b, key) {
		if (f === "x" || f === "y" || f === "z") assert.ok(Math.abs(a - b) < 1e-9, f + " in " + key + ": " + a + " vs " + b);
		else assert.equal(a, b, f + " in " + key);
	});
});

test("readTiles on a pool equals readTile", { timeout: 60000 }, async function () {
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 800, compress: true });
	var keys = Object.keys(store.manifest.nodes), got = [];
	for await (var t of store.readTiles(keys, { fields: FIELDS, threads: 2 })) got.push(t);
	assert.deepEqual(got.map(function (t) { return t.key; }), keys);
	for (var i = 0; i < keys.length; i++) assert.deepEqual(got[i].points, await store.readTile(keys[i], { fields: FIELDS }));
	await compare(store, {}, {}, exact);
});

test("added columns are read by name and with extra", async function () {
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 800 });
	var { encodeTile, decodeTile } = await import("../../src/tiles/tileFile.js");
	store.manifest.columns = [{ name: "facet", type: "i32", fill: -1 }];
	for (var key of Object.keys(store.manifest.nodes)) {   // what addColumn (Task 6) writes: a column of fill
		var name = key + ".0.tile", t = decodeTile(await store._backend.get(name), [], key);
		await store._backend.put(name, encodeTile({ count: t.count, records: t.records, compressed: false, columns: [new Int32Array(t.count).fill(-1)] }));
	}
	var k0 = Object.keys(store.manifest.nodes)[0];
	var a = await store.readTile(k0, { fields: ["x", "facet"] }), b = await store.readTile(k0, { fields: ["x", "extra"] });
	assert.ok(a.facet instanceof Int32Array && a.facet.every(function (v) { return v === -1; }));
	assert.deepEqual(b.facet, a.facet);
	assert.ok(b.extraBytes);
});

test("an unknown key or field is refused; a damaged node is BAD_STORE", async function () {
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 800 });
	await assert.rejects(store.readTile("9-0-0-0"), function (e) { return e.code === "INVALID_ARGUMENT" && /no tile 9-0-0-0/.test(e.message); });
	await assert.rejects(store.readTile("0-0-0-0", { fields: ["nope"] }), function (e) { return e.code === "INVALID_ARGUMENT" && /nope/.test(e.message); });
	await store._backend.put("0-0-0-0.0.tile", new Uint8Array(40));
	await assert.rejects(store.readTile("0-0-0-0"), function (e) { return e.code === "BAD_STORE"; });
	await store._backend.remove("0-0-0-0.0.tile");
	await assert.rejects(store.readTile("0-0-0-0"), function (e) { return e.code === "BAD_STORE" && /missing/.test(e.message); });
});

test("readTiles keeps one decode pool on the store; close() ends it", { timeout: 60000 }, async function () {
	var store = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 800, compress: true });
	var keys = Object.keys(store.manifest.nodes).slice(0, 4);
	for await (var a of store.readTiles(keys, { fields: ["x"], threads: 2 })) assert.ok(a.points.count >= 0);
	var pool = store._pool;
	assert.ok(pool, "a pool was started");
	for await (var b of store.readTiles(keys, { fields: ["x"], threads: 2 })) assert.ok(b.points.count >= 0);
	assert.equal(store._pool, pool, "the same pool serves the next call");
	store.close();
	assert.equal(store._pool, null);
	var got = [];
	for await (var c of store.readTiles(keys, { fields: ["x"], threads: 2 })) got.push(c.key);
	assert.deepEqual(got, keys);
	store.close();
});
