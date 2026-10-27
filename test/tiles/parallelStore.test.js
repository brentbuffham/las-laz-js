// test/tiles/parallelStore.test.js
//==========================================================
// findFragmentsParallel / findFacetsParallel on a tile store: a pile and
// a roof at UTM scale (478 km E, 6771 km N) built into stores; the
// workers read their own regions and the result matches the run on the
// same points in memory; the labels per node, and written as a column
// (set again on a second run, refused on a taken name); an abort leaves
// the store untouched; a store with deletes and a transform; two stores
// at once; a store in memory runs here.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLas, writeLas, buildTiles, findFragmentsParallel, findFacetsParallel, findFacets, makeTransform } from "../../src/index.js";
import { rockPile } from "../helpers/rocks.js";

var E = 478000, N = 6771000, H = 240;

function utm(cols) {
	var n = cols.count, out = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { out.x[i] = cols.x[i] + E; out.y[i] = cols.y[i] + N; out.z[i] = cols.z[i] + H; }
	return out;
}
function roof() {
	var pts = [], t = Math.tan(20 * Math.PI / 180), s = 0.05, a = 1;
	for (var x = 0; x < 10; x += s) for (var y = 0; y < 10; y += s) { a = (a * 16807) % 2147483647; var j = (a / 2147483647 - 0.5) * 0.02; pts.push(x + j, y - j, (5 - Math.abs(y - 5)) * t); }
	var n = pts.length / 3, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = pts[3 * i]; c.y[i] = pts[3 * i + 1]; c.z[i] = pts[3 * i + 2]; }
	return c;
}
var dirs = [];
async function storeOf(cols, kind) {
	var bytes = await writeLas(utm(cols), { scale: { x: 0.001, y: 0.001, z: 0.001 } });
	var where = kind === "memory" ? { memory: new Map() } : { dir: fs.mkdtempSync(path.join(os.tmpdir(), "lazstore-")) };
	if (where.dir) dirs.push(where.dir);
	return buildTiles(await openLas(bytes), { where: where, tilePoints: 20000, replace: true });
}
test.after(function () { dirs.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); }); });

var PILE = rockPile({ count: 30, swebrec: { x50: 0.5, xmax: 1.2, b: 2 }, extent: 8, spacing: 0.02, noise: 0.002, seed: 4, fines: "pebbles" });
var OPTS = { method: "watershed", tile: 3, overlap: 1.5 };
function labelled(byTile) { var n = 0; Object.keys(byTile).forEach(function (k) { var a = byTile[k]; for (var i = 0; i < a.length; i++) if (a[i]) n++; }); return n; }

test("fragments on a UTM-scale store match the run in memory", async function () {
	var store = await storeOf(PILE.cols, "dir");
	var mem = await findFragmentsParallel(PILE.cols, Object.assign({ threads: 2 }, OPTS));
	var st = await findFragmentsParallel(store, Object.assign({ threads: 2 }, OPTS));
	assert.ok(st.tiles >= 4 && st.threads === 2, st.tiles + " tiles, " + st.threads + " threads");
	assert.ok(Math.abs(st.fragments.length - mem.fragments.length) <= 0.1 * mem.fragments.length + 2, st.fragments.length + " vs " + mem.fragments.length);
	assert.ok(Math.abs(st.spacing - mem.spacing) < 0.1 * mem.spacing, st.spacing + " vs " + mem.spacing);
	assert.ok(Math.abs(st.unassignedArea / st.surfaceArea - mem.unassignedArea / mem.surfaceArea) < 0.05);
	// no Float32 jitter at 6,771 km: the largest rocks measure as in memory
	for (var i = 0; i < 10; i++) assert.ok(Math.abs(st.fragments[i].size - mem.fragments[i].size) < 0.03 * mem.fragments[i].size, "rock " + i + ": " + st.fragments[i].size + " vs " + mem.fragments[i].size);
	assert.ok(Math.abs(st.origin.y - (N + 4)) < 5, "origin " + JSON.stringify(st.origin));
	// labels per node, every node, one per point; ids by size
	var nodes = store.manifest.nodes, keys = Object.keys(st.byTile);
	keys.forEach(function (k) { assert.equal(st.byTile[k].length, nodes[k].count); });
	var inMem = 0; for (i = 0; i < mem.fragment.length; i++) if (mem.fragment[i]) inMem++;
	assert.ok(Math.abs(labelled(st.byTile) - inMem) < 0.05 * inMem, labelled(st.byTile) + " vs " + inMem);
	for (i = 1; i < st.fragments.length; i++) assert.ok(st.fragments[i - 1].size >= st.fragments[i].size);
	assert.equal(st.fragment, undefined);
});

test("the labels as a column, set again, and a taken name refused", async function () {
	var store = await storeOf(PILE.cols, "dir");
	var a = await findFragmentsParallel(store, Object.assign({ threads: 2, column: "rock" }, OPTS));
	assert.ok(store.manifest.columns.some(function (c) { return c.name === "rock" && c.type === "u32"; }));
	var key = Object.keys(a.byTile).filter(function (k) { return a.byTile[k].length; })[0];
	var back = await store.readTile(key, { fields: ["rock"] });
	assert.deepEqual(Array.from(back.rock), Array.from(a.byTile[key]));
	var b = await findFragmentsParallel(store, Object.assign({ threads: 2, column: "rock" }, OPTS));   // a second run after the edit
	assert.equal(b.fragments.length, a.fragments.length);
	await assert.rejects(findFragmentsParallel(store, Object.assign({ threads: 1, column: "classification" }, OPTS)), /taken/);
});

test("an abort leaves the store untouched", async function () {
	var store = await storeOf(PILE.cols, "dir"), c = new AbortController();
	await assert.rejects(findFragmentsParallel(store, Object.assign({ threads: 2, column: "rock", signal: c.signal, onProgress: function (d) { if (d > 0) c.abort(); } }, OPTS)), /stopped/);
	assert.equal(store.manifest.columns.length, 0);
});

test("a store with deletes and a transform; two stores at once; a store in memory", async function () {
	var store = await storeOf(PILE.cols, "dir");
	var sel = await store.selectBox({ minX: E + 3, maxX: E + 5, minY: N + 3, maxY: N + 5 });
	await store.deletePoints(sel);
	await store.transform(makeTransform({ shift: [10, -5, 2] }));
	var other = await storeOf(PILE.cols, "dir");
	var both = await Promise.all([findFragmentsParallel(store, Object.assign({ threads: 2 }, OPTS)), findFragmentsParallel(other, Object.assign({ threads: 2 }, OPTS))]);
	var n = 0; Object.keys(store.manifest.nodes).forEach(function (k) { n += store.manifest.nodes[k].count; });
	var got = 0; Object.keys(both[0].byTile).forEach(function (k) { got += both[0].byTile[k].length; });
	assert.equal(got, n, "a label for every point left");
	assert.ok(labelled(both[0].byTile) < 0.97 * labelled(both[1].byTile), "the deleted 2 m square: fewer points in rocks");
	assert.ok(Math.abs(both[0].origin.x - both[1].origin.x - 10) < 1, "moved by the transform");
	var mem = await findFragmentsParallel(await storeOf(PILE.cols, "memory"), Object.assign({ threads: 2 }, OPTS));
	assert.equal(mem.threads, 1);
	assert.ok(Math.abs(mem.fragments.length - both[1].fragments.length) <= 2, mem.fragments.length + " vs " + both[1].fragments.length);
});

test("facets on a UTM-scale store: a roof wider than a tile is two facets, as in memory", async function () {
	var cols = roof(), store = await storeOf(cols, "dir"), o = { maxDistance: 0.2, maxAngle: 10 };
	var one = findFacets(cols, o), big = function (r) { return r.facets.filter(function (f) { return f.area > 10; }); };
	var st = await findFacetsParallel(store, Object.assign({ threads: 2, tile: 2.5, overlap: 0.5, column: "facet" }, o));
	assert.ok(st.tiles >= 9 && st.threads === 2);
	assert.equal(big(st).length, 2, st.facets.slice(0, 6).map(function (f) { return f.area.toFixed(1); }).join());
	big(st).forEach(function (f, k) {
		assert.ok(Math.abs(f.area - big(one)[k].area) < 0.05 * big(one)[k].area, f.area + " vs " + big(one)[k].area);
		assert.ok(Math.abs(f.dip - 20) < 1, "dip " + f.dip);
		assert.ok(f.outlineParts.length > 1);
	});
	assert.ok(store.manifest.columns.some(function (c) { return c.name === "facet"; }));
	await assert.rejects(findFacetsParallel(store, Object.assign({ normals: {} }, o)), /normals cannot/);
});
