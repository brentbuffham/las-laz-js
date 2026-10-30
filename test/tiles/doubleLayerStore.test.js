// test/tiles/doubleLayerStore.test.js
//==========================================================
// selectDoubleLayerStore and snapToLayerStore at UTM scale: the store
// finds the ghost sheet a run on the whole cloud finds (across the work
// tiles' seams), workers and this thread agree, snapToLayerStore moves
// it onto the real surface, bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLas, writeLas, buildTiles, selectDoubleLayer, selectDoubleLayerStore, snapToLayerStore, suggestDoubleLayerStore, fixDoubleLayerStore } from "../../src/index.js";

var E = 478000, N = 6771000, H = 240;
var surface = function (x, y) { return 0.1 * x + 0.3 * Math.sin(y / 3); };
var drop = function (x) { return 1 + 0.03 * x; };
// a 24 x 24 m surface at 0.25 m, a ghost copy under every second point, at UTM scale
function cloud() {
	var xs = [], ys = [], zs = [], k = 0;
	for (var x = 0; x < 24; x += 0.25) for (var y = 0; y < 24; y += 0.25) {
		var z = surface(x, y);
		xs.push(E + x); ys.push(N + y); zs.push(H + z);
		if (k++ % 2 === 0) { xs.push(E + x + 0.01); ys.push(N + y); zs.push(H + z - drop(x)); }
	}
	return { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) };
}
var dirs = [], CLOUD = cloud();
async function store() {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazdbl-"));
	dirs.push(dir);
	return buildTiles(await openLas(await writeLas(CLOUD, { scale: { x: 0.001, y: 0.001, z: 0.001 } })), { where: { dir: dir }, tilePoints: 3000, replace: true });
}
test.after(function () { dirs.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); }); });

var OPTS = { cell: 1, minGap: 0.4 };

test("the store finds the ghost sheet the whole cloud finds, workers or not", async function () {
	var want = selectDoubleLayer(CLOUD, OPTS).stats.selected;
	assert.ok(want > 1500, "ghost points " + want);
	var s = await store(), a = await selectDoubleLayerStore(s, Object.assign({ threads: 2, tile: 6 }, OPTS));
	assert.ok(a.tiles >= 9, a.tiles + " tiles");
	assert.ok(Math.abs(a.count - want) <= want * 0.01, a.count + " against " + want);
	assert.equal(a.selection.count, a.count);
	var b = await selectDoubleLayerStore(s, Object.assign({ threads: 1, tile: 6 }, OPTS));
	assert.equal(b.count, a.count);
	assert.ok(a.stats.min > 0.9 && a.stats.max < 1.8, a.stats.min + " to " + a.stats.max);
	Object.keys(a.selection.tiles).forEach(function (k) {
		var t = a.selection.tiles[k];
		for (var i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
	});
});

test("snapToLayerStore moves the ghost onto the real surface", async function () {
	var s = await store(), found = await selectDoubleLayerStore(s, Object.assign({ threads: 2, tile: 6 }, OPTS));
	var r = await snapToLayerStore(s, found);
	assert.equal(r.moved, found.count);
	var after = await selectDoubleLayerStore(s, Object.assign({ threads: 2, tile: 6 }, OPTS));
	assert.ok(after.count < found.count * 0.02, after.count + " left of " + found.count);
	var off = 0, seen = 0;
	for (var key of Object.keys(s.manifest.nodes)) {
		var pts = await s.readTile(key, { fields: ["x", "y", "z"] });
		for (var i = 0; i < pts.count; i++) { if (Math.abs(pts.z[i] - H - surface(pts.x[i] - E, pts.y[i] - N)) > 0.2) off++; seen++; }
	}
	assert.equal(seen, CLOUD.count);
	assert.ok(off < found.count * 0.02, off + " points still off the surface");
});

test("average mode needs the partner points, and moves both layers", async function () {
	var s = await store(), plain = await selectDoubleLayerStore(s, Object.assign({ threads: 1, tile: 6 }, OPTS));
	await assert.rejects(snapToLayerStore(s, plain, { mode: "average" }), { code: "INVALID_ARGUMENT" });
	var found = await selectDoubleLayerStore(s, Object.assign({ threads: 1, tile: 6, partner: true }, OPTS));
	assert.ok(found.stats.kept > found.count);
	var r = await snapToLayerStore(s, found, { mode: "average" });
	assert.ok(r.moved > found.count);
});

test("bad options are refused", async function () {
	var s = await store();
	for (var o of [{ minGap: 1 }, { cell: 1 }, { cell: -1, minGap: 1 }, { cell: 1, minGap: 1, smooth: 0.5 }])
		await assert.rejects(selectDoubleLayerStore(s, o), { code: "INVALID_ARGUMENT" });
	var found = await selectDoubleLayerStore(s, Object.assign({ threads: 1 }, OPTS));
	await assert.rejects(snapToLayerStore(s, found, { mode: "x" }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(snapToLayerStore(s, {}), { code: "INVALID_ARGUMENT" });
});

// the points a store selection names, as "x,y" strings in the file's units
async function placesOf(s, selection) {
	var out = [];
	for (var key of Object.keys(selection.tiles)) {
		var pts = await s.readTile(key, { fields: ["x", "y", "z"] }), idx = selection.tiles[key];
		for (var i = 0; i < idx.length; i++) out.push(pts.x[idx[i]].toFixed(3) + "," + pts.y[idx[i]].toFixed(3) + "," + pts.z[idx[i]].toFixed(3));
	}
	return out.sort();
}

test("box: only the points inside it are found, the same ones a run on the whole store finds there", async function () {
	var s = await store(), whole = await selectDoubleLayerStore(s, Object.assign({ threads: 1, tile: 6 }, OPTS));
	var box = { minX: E + 7, maxX: E + 17, minY: N + 7, maxY: N + 17 };
	var part = await selectDoubleLayerStore(s, Object.assign({ threads: 1, tile: 6, box: box }, OPTS));
	var inBox = function (p) { var q = p.split(",").map(Number); return q[0] >= box.minX && q[0] <= box.maxX && q[1] >= box.minY && q[1] <= box.maxY; };
	var want = (await placesOf(s, whole.selection)).filter(inBox), got = await placesOf(s, part.selection);
	assert.ok(got.length > 200, got.length + " points in the box");
	assert.deepEqual(got, want);
	assert.equal(part.tiles, 4, "tiles"); assert.ok(part.tiles < whole.tiles, part.tiles + " work tiles in the box, " + whole.tiles + " over the whole store");
	assert.equal(part.count, got.length);
	// workers agree
	var again = await selectDoubleLayerStore(s, Object.assign({ threads: 2, tile: 6, box: box }, OPTS));
	assert.equal(again.count, part.count);
});

test("box: Z limits count, a box off the store finds nothing, open sides are open", async function () {
	var s = await store(), base = Object.assign({ threads: 1, tile: 6 }, OPTS);
	assert.equal((await selectDoubleLayerStore(s, Object.assign({ box: { minX: E + 6, maxX: E + 18, minZ: H + 500 } }, base))).count, 0);
	assert.equal((await selectDoubleLayerStore(s, Object.assign({ box: { minX: E + 1000, maxX: E + 1010 } }, base))).count, 0);
	var whole = await selectDoubleLayerStore(s, base);
	assert.equal((await selectDoubleLayerStore(s, Object.assign({ box: {} }, base))).count, whole.count);
	assert.equal((await selectDoubleLayerStore(s, Object.assign({ box: { maxX: E + 1e6 } }, base))).count, whole.count);
});

test("minArea and coherence reach the store run", async function () {
	var s = await store(), base = Object.assign({ threads: 1, tile: 12 }, OPTS);
	var whole = await selectDoubleLayerStore(s, base);
	assert.equal((await selectDoubleLayerStore(s, Object.assign({ minArea: 50 }, base))).count, whole.count);   // the sheet is a 24 x 24 m patch
	assert.equal((await selectDoubleLayerStore(s, Object.assign({ minArea: 5000 }, base))).count, 0);
	assert.equal((await selectDoubleLayerStore(s, Object.assign({ minArea: 50, coherence: 0.0001 }, base))).count, 0);   // offsets never agree that closely
});

test("bad box, minArea and coherence are refused", async function () {
	var s = await store();
	for (var o of [{ box: { minX: 5, maxX: 1 } }, { box: { minY: NaN } }, { box: 3 }, { box: { maxZ: "1" } }, { minArea: -1 }, { coherence: 0 }])
		await assert.rejects(selectDoubleLayerStore(s, Object.assign({ threads: 1 }, OPTS, o)), { code: "INVALID_ARGUMENT" });
});

// --- settings from the store's own points, and the one-call fix -------------------------------------------------------
// the same surface with no ghost
var CLEAN = (function () {
	var xs = [], ys = [], zs = [];
	for (var x = 0; x < 24; x += 0.25) for (var y = 0; y < 24; y += 0.25) { xs.push(E + x); ys.push(N + y); zs.push(H + surface(x, y)); }
	return { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) };
})();
async function cleanStore() {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazdbl-"));
	dirs.push(dir);
	return buildTiles(await openLas(await writeLas(CLEAN, { scale: { x: 0.001, y: 0.001, z: 0.001 } })), { where: { dir: dir }, tilePoints: 3000, replace: true });
}
// this ghost lies 1 m or more under the surface, past the suggested maxGap of 0.5 m, so these runs lay their own over it
var FIX = { threads: 1, tile: 6, settings: { maxGap: 5 } };

test("suggestDoubleLayerStore measures the store, or the box, in the work tiles", async function () {
	var s = await store(), a = await suggestDoubleLayerStore(s, { threads: 2, tile: 6 });
	assert.equal(a.ok, true);
	assert.equal(a.cell, 1);
	assert.equal(a.tiles, 8, "a sample of the 16 work tiles, not all");
	assert.ok(a.minGap >= 0.06 && a.minGap <= 0.15 && a.minPoints === 3 && a.bridge === 3, JSON.stringify(a));
	assert.ok(a.splitFraction > 0.1, "split " + a.splitFraction);
	var b = await suggestDoubleLayerStore(s, { threads: 1, tile: 6, box: { minX: E + 7, maxX: E + 17, minY: N + 7, maxY: N + 17 } });
	assert.equal(b.ok, true);
	assert.equal(b.tiles, 4);
	var none = await suggestDoubleLayerStore(s, { threads: 1, tile: 6, box: { minX: E + 1000, maxX: E + 1010 } });
	assert.equal(none.ok, false);
	assert.match(none.reason, /box/);
	var g = await suggestDoubleLayerStore(s, { threads: 1, tile: 6, strength: "gentle" });
	assert.ok(g.minGap >= a.minGap && g.minPoints === 4);
	await assert.rejects(suggestDoubleLayerStore(s, { threads: 1, strength: "strong" }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(suggestDoubleLayerStore(s, { threads: 1, box: 3 }), { code: "INVALID_ARGUMENT" });
});

test("suggestDoubleLayerStore on a clean store sees no splitting", async function () {
	var a = await suggestDoubleLayerStore(await cleanStore(), { threads: 1, tile: 6 });
	assert.equal(a.ok, true);
	assert.ok(a.splitFraction < 0.01, "split " + a.splitFraction);
});

test("fixDoubleLayerStore finds and moves the ghost in one call, and a second look finds nothing", async function () {
	var s = await store(), want = selectDoubleLayer(CLOUD, OPTS).stats.selected, seen = [];
	var r = await fixDoubleLayerStore(s, Object.assign({ onPass: function (p) { seen.push(p); } }, FIX));
	assert.equal(r.ok, true);
	assert.ok(r.moved >= 0.98 * want, r.moved + " of " + want);
	assert.equal(r.found, r.passes[0].found);
	assert.deepEqual(seen, r.passes);
	assert.equal(r.settings.cell, 1);
	assert.equal(r.settings.maxGap, 5);
	assert.ok(r.passes.length >= 1 && r.passes.length <= 4);
	var after = await selectDoubleLayerStore(s, Object.assign({ threads: 2, tile: 6 }, OPTS));
	assert.ok(after.count < want * 0.02, after.count + " left of " + want);
	var again = await fixDoubleLayerStore(s, FIX);
	assert.equal(again.moved, 0);
	assert.equal(again.ok, true);
});

test("fixDoubleLayerStore: a box moves only what is inside it, and a dry run moves nothing", async function () {
	var s = await store(), box = { minX: E + 7, maxX: E + 17, minY: N + 7, maxY: N + 17 };
	var dry = await fixDoubleLayerStore(s, Object.assign({ dryRun: true, box: box }, FIX));
	assert.ok(dry.found > 200 && dry.moved === 0 && dry.passes.length === 1, JSON.stringify(dry.passes));
	var whole = await selectDoubleLayerStore(s, Object.assign({ threads: 1, tile: 6 }, OPTS));
	assert.equal(whole.count, (await selectDoubleLayerStore(s, Object.assign({ threads: 1, tile: 6 }, OPTS))).count);   // untouched
	var r = await fixDoubleLayerStore(s, Object.assign({ box: box }, FIX));
	assert.ok(r.moved >= 0.98 * dry.found && r.moved <= 1.05 * dry.found, r.moved + " against " + dry.found);
	var left = await selectDoubleLayerStore(s, Object.assign({ threads: 1, tile: 6 }, OPTS));
	assert.ok(left.count > 0.5 * whole.count, "the outside is still there: " + left.count + " of " + whole.count);
	assert.ok(left.count < whole.count - 0.9 * dry.found);
});

test("fixDoubleLayerStore on a clean store moves nothing, and bad options are refused", async function () {
	var c = await cleanStore(), r = await fixDoubleLayerStore(c, { threads: 1, tile: 6 });
	assert.equal(r.ok, true);
	assert.equal(r.moved, 0);
	var empty = await fixDoubleLayerStore(await store(), { threads: 1, tile: 6, box: { minX: E + 1000, maxX: E + 1010 } });
	assert.equal(empty.ok, false);
	assert.equal(empty.moved, 0);
	for (var o of [{ maxPasses: 0 }, { maxPasses: 1.5 }, { strength: "x" }, { mode: "x" }])
		await assert.rejects(fixDoubleLayerStore(await store(), Object.assign({ threads: 1, tile: 6, settings: { maxGap: 5 } }, o)), { code: "INVALID_ARGUMENT" });
});
