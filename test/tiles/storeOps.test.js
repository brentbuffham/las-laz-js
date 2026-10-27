// test/tiles/storeOps.test.js
//==========================================================
// Whole-cloud edits on a tile store at UTM scale: dedupeStore removes
// what dedupe removes on the same points (the same count, XY and 3D,
// across the work tiles' seams), apply false only finds them, workers
// and this thread agree, bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLas, writeLas, buildTiles, dedupeStore, dedupe, mergeStores, splitStore } from "../../src/index.js";

var E = 478000, N = 6771000, H = 240;
// a 12 x 12 m grid at 5 cm, every 7th point given a twin 4 mm away (and 2 cm up), at UTM scale
function cloud() {
	var xs = [], ys = [], zs = [], k = 0;
	for (var x = 0; x < 12; x += 0.05) for (var y = 0; y < 12; y += 0.05) {
		var z = 0.3 * Math.sin(x) * Math.cos(y);
		xs.push(E + x); ys.push(N + y); zs.push(H + z);
		if (k++ % 7 === 0) { xs.push(E + x + 0.004); ys.push(N + y); zs.push(H + z + 0.02); }
	}
	return { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) };
}
var dirs = [], CLOUD = cloud();
async function store() {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazops-"));
	dirs.push(dir);
	return buildTiles(await openLas(await writeLas(CLOUD, { scale: { x: 0.001, y: 0.001, z: 0.001 } })), { where: { dir: dir }, tilePoints: 3000, replace: true });
}
function count(s) { var n = 0; Object.keys(s.manifest.nodes).forEach(function (k) { n += s.manifest.nodes[k].count; }); return n; }
test.after(function () { dirs.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); }); });

test("dedupeStore removes what dedupe removes, across the tiles' seams", async function () {
	var want = CLOUD.count - dedupe(CLOUD, 0.01).count, want3 = CLOUD.count - dedupe(CLOUD, 0.01, { z: true }).count;
	assert.ok(want > 1000 && want3 < want, want + " / " + want3);
	var s = await store(), found = await dedupeStore(s, 0.01, { apply: false, threads: 2, tile: 3 });
	assert.ok(found.tiles >= 16 && found.threads === 2, found.tiles + " tiles");
	assert.equal(found.removed, want);
	assert.equal(count(s), CLOUD.count, "apply false: nothing deleted");
	var here = await dedupeStore(s, 0.01, { apply: false, threads: 1, tile: 3 });
	assert.deepEqual(Object.keys(here.selection.tiles).sort(), Object.keys(found.selection.tiles).sort());
	var z3 = await dedupeStore(s, 0.01, { apply: false, threads: 2, tile: 3, z: true });
	assert.equal(z3.removed, want3);
	var done = await dedupeStore(s, 0.01, { threads: 2, tile: 3 });
	assert.equal(count(s), CLOUD.count - want);
	assert.equal((await dedupeStore(s, 0.01, { apply: false, threads: 2, tile: 3 })).removed, 0, "nothing left to drop");
	assert.equal(done.removed, want);
	await assert.rejects(dedupeStore(s, 0), /tolerance/);
});

// two halves of the grid at UTM scale, one with colour (format 7), one without (format 6)
async function half(west, colour) {
	var keep = [];
	for (var i = 0; i < CLOUD.count; i++) if ((CLOUD.x[i] < E + 6) === west) keep.push(i);
	var c = { count: keep.length, x: new Float64Array(keep.length), y: new Float64Array(keep.length), z: new Float64Array(keep.length), classification: new Uint8Array(keep.length).fill(west ? 2 : 6) };
	keep.forEach(function (p, q) { c.x[q] = CLOUD.x[p]; c.y[q] = CLOUD.y[p]; c.z[q] = CLOUD.z[p]; });
	if (colour) { c.red = new Uint16Array(keep.length).fill(60000); c.green = new Uint16Array(keep.length); c.blue = new Uint16Array(keep.length); }
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazops-"));
	dirs.push(dir);
	return buildTiles(await openLas(await writeLas(c, { version: "1.4", pointFormat: colour ? 7 : 6, scale: { x: 0.001, y: 0.001, z: 0.001 } })), { where: { dir: dir }, tilePoints: 3000, replace: true });
}
async function all(store, fields) {
	var out = [];
	for (var k of Object.keys(store.manifest.nodes)) { if (!store.manifest.nodes[k].count) continue; var p = await store.readTile(k, { fields: fields }); for (var i = 0; i < p.count; i++) out.push(fields.map(function (f) { return p[f][i]; })); }
	return out;
}

test("mergeStores: two stores, one with colour, into one; the moved one where it was moved to", async function () {
	var a = await half(true, true), b = await half(false, false);
	await b.transform({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 5] });   // lifted 5 m
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazops-")); dirs.push(dir);
	var calls = 0, m = await mergeStores([a, b], { where: { dir: dir }, tilePoints: 3000, onProgress: function () { calls++; } });
	assert.equal(count(m), count(a) + count(b));
	assert.equal(m.manifest.pointFormat, 7);
	assert.ok(calls > 2);
	var pts = await all(m, ["x", "z", "classification", "red"]);
	var west = pts.filter(function (p) { return p[0] < E + 6; }), east = pts.filter(function (p) { return p[0] >= E + 6; });
	assert.equal(west.length, count(a)); assert.equal(east.length, count(b));
	assert.ok(west.every(function (p) { return p[2] === 2 && p[3] === 60000 && p[1] < H + 1; }), "west: class 2, red, not lifted");
	assert.ok(east.every(function (p) { return p[2] === 6 && p[3] === 0 && p[1] > H + 4; }), "east: class 6, no colour (0), lifted 5 m");
	await assert.rejects(mergeStores([a, {}], { where: { dir: dir } }), /array of open tile stores/);
	await assert.rejects(mergeStores([a, b], {}), /needs a where/);
});

test("splitStore: a box of a store into a new store, deleted from the source", async function () {
	var s = await store(), before = count(s);
	var sel = await s.selectBox({ minX: E + 2, maxX: E + 5, minY: N + 2, maxY: N + 5 });
	assert.ok(sel.count > 1000);
	var mem = await splitStore(s, sel, { where: { memory: true }, tilePoints: 3000 });
	assert.equal(count(mem), sel.count);
	assert.equal(count(s), before - sel.count);
	var pts = await all(mem, ["x", "y"]);
	assert.ok(pts.every(function (p) { return p[0] >= E + 2 - 1e-6 && p[0] <= E + 5 + 1e-6 && p[1] >= N + 2 - 1e-6 && p[1] <= N + 5 + 1e-6; }));
	await assert.rejects(splitStore(s, sel, { where: { memory: true } }), /current selection/);   // made before the delete
	var keep = await s.selectBox({ minX: E + 6, maxX: E + 7, minY: N, maxY: N + 1 }), n2 = count(s);
	await splitStore(s, keep, { where: { memory: true }, keep: true });
	assert.equal(count(s), n2, "keep: the source keeps them");
});
