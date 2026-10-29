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
import { openLas, writeLas, buildTiles, selectDoubleLayer, selectDoubleLayerStore, snapToLayerStore } from "../../src/index.js";

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
