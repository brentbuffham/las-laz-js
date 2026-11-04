// test/tiles/writeColumn.test.js
//==========================================================
// store.writeColumn: an added column written and others dropped in ONE
// pass (one generation of each node, one manifest) gives the store
// addColumn + setColumn + removeColumn give; with a selection; an
// existing column set again; refusals; a stop leaves the store as it
// was. A fragments run's dropColumns. An OPFS call that never answers
// (a fake OPFS) makes the edit reject naming the file, quickly, the
// store left as it was. Synthetic.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas, writeLas, buildTiles, openTiles, findFragmentsParallel } from "../../src/index.js";
import { opfsStall } from "../../src/tiles/backends.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";
import { rockPile } from "../helpers/rocks.js";

function cloud(n) { var c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) }; for (var i = 0; i < n; i++) { c.x[i] = 478000 + (i % 300) * 0.05; c.y[i] = 6771000 + Math.floor(i / 300) * 0.05; c.z[i] = 240 + (i % 7) * 0.01; } return c; }
async function storeOf(where) { return buildTiles(await openLas(await writeLas(cloud(30000))), { where: where || { memory: new Map() }, tilePoints: 2000, replace: true }); }
function keysOf(store) { return Object.keys(store.manifest.nodes).filter(function (k) { return store.manifest.nodes[k].count; }).sort(); }
// a value per point of every node, from its key and index
function valuesOf(store, f) { var out = {}; keysOf(store).forEach(function (k, q) { var n = store.manifest.nodes[k].count, a = new Uint32Array(n); for (var i = 0; i < n; i++) a[i] = f(q, i); out[k] = a; }); return out; }
async function column(store, name) { var out = {}; for (var k of keysOf(store)) out[k] = Array.from((await store.readTile(k, { fields: [name] }))[name]); return out; }
function gens(store) { var g = {}; Object.keys(store.manifest.nodes).forEach(function (k) { g[k] = store.manifest.nodes[k].gen; }); return g; }

test("writeColumn: a new column and a drop in one pass, as addColumn + setColumn + removeColumn", async function () {
	var a = await storeOf(), b = await storeOf();
	for (var s of [a, b]) { await s.addColumn("old", "u32", 7); await s.addColumn("keep", "u16", 3); }
	var va = valuesOf(a, function (q, i) { return q * 1000 + i; }), vb = valuesOf(b, function (q, i) { return q * 1000 + i; });
	// three rewrites
	await a.addColumn("run", "u32", 0);
	var all = { deletes: a.manifest.deletes, count: 0, tiles: {} };
	keysOf(a).forEach(function (k) { var n = a.manifest.nodes[k].count, idx = new Uint32Array(n); for (var i = 0; i < n; i++) idx[i] = i; all.tiles[k] = idx; all.count += n; });
	await a.setColumn(all, "run", va);
	await a.removeColumn("old");
	// one
	var edits = b.manifest.edits, before = gens(b), seen = [];
	await b.writeColumn("run", "u32", vb, { drop: ["old"], onProgress: function (e) { seen.push(e); } });
	assert.equal(b.manifest.edits, edits + 1, "one manifest");
	Object.keys(before).forEach(function (k) { assert.equal(b.manifest.nodes[k].gen, before[k] + 1, "node " + k + " written once"); });
	assert.deepEqual(b.manifest.columns, a.manifest.columns);
	assert.deepEqual(await column(b, "run"), await column(a, "run"));
	assert.deepEqual(await column(b, "keep"), await column(a, "keep"));
	assert.equal(seen[seen.length - 1].done, seen[seen.length - 1].total);
	assert.equal(seen[0].phase, "edit");
	// the store opened again reads the same
	var again = await openTiles(b.where);
	assert.deepEqual(await column(again, "run"), await column(a, "run"));
	again.close();
});

test("writeColumn: with a selection; an existing column set again on the named nodes only; fill", async function () {
	var s = await storeOf(), keys = keysOf(s), k0 = keys[0], k1 = keys[1];
	var sel = { deletes: s.manifest.deletes, count: 3, tiles: {} };
	sel.tiles[k0] = Uint32Array.from([0, 2]); sel.tiles[k1] = Uint32Array.from([5]);
	var v = {}; v[k0] = Uint32Array.from([11, 12]); v[k1] = Uint32Array.from([13]);
	await s.writeColumn("lab", "u32", v, { selection: sel, fill: 9 });
	var c = await column(s, "lab");
	assert.deepEqual([c[k0][0], c[k0][1], c[k0][2], c[k1][5], c[k1][0]], [11, 9, 12, 13, 9]);
	assert.equal(c[keys[2]][0], 9);
	// set again: only k1 is rewritten
	var g = gens(s), w = {};
	w[k1] = new Uint32Array(s.manifest.nodes[k1].count).fill(4);
	await s.writeColumn("lab", "u32", w);
	assert.equal(s.manifest.nodes[k1].gen, g[k1] + 1);
	assert.equal(s.manifest.nodes[k0].gen, g[k0]);
	c = await column(s, "lab");
	assert.equal(c[k1][5], 4);
	assert.equal(c[k0][0], 11);
	// plain numbers are checked
	var bad = {}; bad[k1] = Array.from({ length: s.manifest.nodes[k1].count }, function () { return -1; });
	await assert.rejects(s.writeColumn("lab", "u32", bad), /not a whole number from 0/);
});

test("writeColumn refuses bad input, and a stop leaves the store as it was", async function () {
	var s = await storeOf(), k = keysOf(s)[0], ok = {};
	await s.addColumn("old", "u32", 1);
	ok[k] = new Uint32Array(s.manifest.nodes[k].count);
	await assert.rejects(s.writeColumn("x", "u33", ok), /type u33/);
	await assert.rejects(s.writeColumn("intensity", "u32", ok), /taken/);
	await assert.rejects(s.writeColumn("old", "u16", ok), /is u32, not u16/);
	await assert.rejects(s.writeColumn("x2", "u32", ok, { drop: ["nope"] }), /not an added column/);
	await assert.rejects(s.writeColumn("old", "u32", ok, { drop: ["old"] }), /cannot name the column being written/);
	await assert.rejects(s.writeColumn("x2", "u32", { "9-9-9-9": ok[k] }), /not in the store/);
	var short = {}; short[k] = new Uint32Array(3);
	await assert.rejects(s.writeColumn("x2", "u32", short), /one value for each/);
	var before = JSON.stringify(s.manifest), ac = new AbortController();
	ac.abort();
	await assert.rejects(s.writeColumn("x2", "u32", ok, { drop: ["old"], signal: ac.signal }), function (e) { return e.code === "ABORTED"; });
	assert.equal(JSON.stringify(s.manifest), before);
	var again = await openTiles(s.where);
	assert.deepEqual(again.manifest.columns.map(function (c) { return c.name; }), ["old"]);
	again.close();
});

test("a fragments run on a store drops the last run's column in the edit that writes its own", async function () {
	var P = rockPile({ count: 12, swebrec: { x50: 0.5, xmax: 1.2, b: 2 }, extent: 5, spacing: 0.03, noise: 0.002, seed: 8, fines: "pebbles" });
	var n = P.cols.count, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = P.cols.x[i] + 478000; c.y[i] = P.cols.y[i] + 6771000; c.z[i] = P.cols.z[i] + 240; }
	var store = await buildTiles(await openLas(await writeLas(c, { scale: { x: 0.001, y: 0.001, z: 0.001 } })), { where: { memory: new Map() }, tilePoints: 20000, replace: true });
	var first = await findFragmentsParallel(store, { method: "watershed", column: "rock_1", tile: 3, overlap: 1.5, threads: 1 });
	var edits = store.manifest.edits, bar = [];
	var second = await findFragmentsParallel(store, { method: "watershed", column: "rock_2", dropColumns: ["rock_1"], tile: 3, overlap: 1.5, threads: 1, onProgress: function (d, t) { bar.push(d / t); } });
	assert.equal(store.manifest.edits, edits + 1, "the column written and the old one dropped in one edit");
	assert.deepEqual(store.manifest.columns.map(function (x) { return x.name; }), ["rock_2"]);
	assert.equal(second.fragments.length, first.fragments.length);
	assert.equal(bar[bar.length - 1], 1);
	assert.ok(bar.some(function (f) { return f > 0.86 && f < 1; }), "the write moves the bar");
	await assert.rejects(findFragmentsParallel(store, { method: "watershed", dropColumns: ["rock_2"], threads: 1 }), /dropColumns needs column/);
	await assert.rejects(findFragmentsParallel(store, { method: "watershed", column: "rock_3", dropColumns: ["rock_9"], threads: 1 }), /not an added column/);
	await assert.rejects(findFragmentsParallel(store, { method: "watershed", column: "rock_2", dropColumns: ["rock_2"], threads: 1 }), /cannot name column/);
});

test("an OPFS call that never answers: the edit rejects naming the file, quickly, and the store is as it was", async function () {
	var root = createFakeRoot("root"), where = { opfs: "stall", root: root }, s = await storeOf(where);
	await s.addColumn("old", "u32", 1);
	var dir = await (await root.getDirectoryHandle("las-tiles")).getDirectoryHandle("stall");
	var keys = Object.keys(s.manifest.nodes).sort(), k = keys[Math.floor(keys.length / 2)], name = k + "." + s.manifest.nodes[k].gen + ".tile";
	var fh = await dir.getFileHandle(name), real = fh.getFile;
	fh.getFile = function () { return new Promise(function () {}); };   // OPFS stuck on this file
	var was = opfsStall(150), t0 = Date.now(), before = JSON.stringify(s.manifest);
	try {
		await assert.rejects(s.removeColumn("old"), function (e) { return e.code === "BAD_STORE" && /did not answer/.test(e.message) && e.message.indexOf(name) >= 0; });
		assert.ok(Date.now() - t0 < 5000, (Date.now() - t0) + " ms");
		assert.equal(JSON.stringify(s.manifest), before);
	} finally { opfsStall(was); fh.getFile = real; }
	// opened again: the store as it was, the orphans swept, and the edit goes through
	var again = await openTiles(where);
	assert.deepEqual(again.manifest.columns.map(function (c) { return c.name; }), ["old"]);
	await again.removeColumn("old");
	assert.deepEqual(again.manifest.columns, []);
	again.close();
});
