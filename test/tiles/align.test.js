// test/tiles/align.test.js
//==========================================================
// alignStores: a rock pile at UTM scale stored twice, one copy turned
// 1.5 degrees about Z and shifted 0.6 m; picks 5 cm off and ICP on the
// stores' thinned copies bring it back within millimetres, and apply
// moves the stored cloud; a store against columns; storeSample takes
// whole top levels; bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLas, writeLas, buildTiles, alignStores, storeSample } from "../../src/index.js";
import { rockPile } from "../helpers/rocks.js";

var E = 478000, N = 6771000, H = 240, A = 1.5 * Math.PI / 180, SHIFT = [0.6, -0.4, 0.2], C = [E + 4, N + 4];
var PILE = rockPile({ count: 30, swebrec: { x50: 0.5, xmax: 1.2, b: 2 }, extent: 8, spacing: 0.02, noise: 0.002, seed: 4, fines: "pebbles" });
// world positions; moved: turned about the pile's centre, then shifted
function world(i) { return [PILE.cols.x[i] + E, PILE.cols.y[i] + N, PILE.cols.z[i] + H]; }
function move(p) { var dx = p[0] - C[0], dy = p[1] - C[1]; return [C[0] + Math.cos(A) * dx - Math.sin(A) * dy + SHIFT[0], C[1] + Math.sin(A) * dx + Math.cos(A) * dy + SHIFT[1], p[2] + SHIFT[2]]; }
function apply(T, p) { var m = T.m, t = T.t; return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + t[0], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + t[1], m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + t[2]]; }
function cloud(moved) {
	var n = PILE.cols.count, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { var p = world(i); if (moved) p = move(p); c.x[i] = p[0]; c.y[i] = p[1]; c.z[i] = p[2]; }
	return c;
}
var dirs = [];
async function store(cols) {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazalign-"));
	dirs.push(dir);
	return buildTiles(await openLas(await writeLas(cols, { scale: { x: 0.001, y: 0.001, z: 0.001 } })), { where: { dir: dir }, tilePoints: 5000, replace: true });
}
test.after(function () { dirs.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); }); });
// picks: four points of the moved copy and where they belong, 5 cm off
function pairs() {
	var from = [], to = [];
	[100, 40000, 90000, 150000].forEach(function (i, k) { var p = world(i), q = move(p); from.push(q[0] + 0.05 * (k % 2 ? 1 : -1), q[1], q[2]); to.push(p[0], p[1], p[2]); });
	return { from: from, to: to };
}

test("two stores at UTM scale: the moved copy comes back, and apply moves it", async function () {
	var fixed = await store(cloud(false)), moving = await store(cloud(true));
	var res = await alignStores(moving, fixed, { pairs: pairs(), icp: { maxDistance: 0.3 }, movingPoints: 60000, fixedPoints: 150000, apply: true });
	assert.ok(res.moving.count <= 60000 && res.moving.count > 1000 && res.moving.of === PILE.cols.count, JSON.stringify(res.moving));
	assert.ok(res.fixed.count <= 150000 && res.fixed.levels >= 2, JSON.stringify(res.fixed));
	assert.ok(res.icp && res.icp.rmsAfter < 0.01, "rms " + (res.icp && res.icp.rmsAfter));
	[5, 70000, 170000].forEach(function (i) {
		var back = apply(res.transform, move(world(i))), p = world(i), err = Math.hypot(back[0] - p[0], back[1] - p[1], back[2] - p[2]);
		assert.ok(err < 0.005, "point " + i + " off by " + err);
	});
	assert.ok(moving.manifest.transform, "the store's transform is set");
});

test("a store against columns; storeSample; bad options", async function () {
	var moving = await store(cloud(true)), fixedCols = cloud(false), o = [E + 4, N + 4, H];
	var local = { count: fixedCols.count, x: new Float32Array(fixedCols.count), y: new Float32Array(fixedCols.count), z: new Float32Array(fixedCols.count) };
	for (var i = 0; i < local.count; i++) { local.x[i] = fixedCols.x[i] - o[0]; local.y[i] = fixedCols.y[i] - o[1]; local.z[i] = fixedCols.z[i] - o[2]; }
	var res = await alignStores(moving, { cols: local, origin: o }, { pairs: pairs(), icp: { maxDistance: 0.3 }, movingPoints: 60000 });
	assert.ok(res.icp.rmsAfter < 0.01);
	assert.equal(moving.manifest.transform, null, "no apply: the store is not moved");
	var s = await storeSample(moving, 1);   // the root level at least
	assert.equal(s.levels, 1); assert.ok(s.count > 0);
	assert.ok(Math.abs(s.origin.y - (N + 4)) < 5);
	await assert.rejects(alignStores(moving, { cols: local, origin: o }), /needs options/);
	await assert.rejects(alignStores({ cols: local }, moving, { pairs: pairs(), apply: true }), /apply needs/);
	await assert.rejects(alignStores(moving, {}, { pairs: pairs() }), /fixed must be/);
	await assert.rejects(storeSample(moving, 0), /maxPoints/);
});
