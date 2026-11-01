// test/filter/dedupeParallel.test.js
//==========================================================
// dedupe's progress and stop, and dedupeParallel: on the worker pool
// it keeps exactly the points dedupe keeps (a brute-force oracle, then
// dedupe itself), in the same order, with every column following
// them, including when points a tolerance apart run in chains across
// the tiles' seams.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe, dedupeSelection } from "../../src/filter/dedupe.js";
import { dedupeSweep } from "../../src/filter/dedupeCore.js";
import { dedupeParallel } from "../../src/index.js";

function rng(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function bruteForce(cols, tol, use3d) {
	var kept = [];
	for (var i = 0; i < cols.count; i++) {
		var dup = false;
		for (var j = 0; j < kept.length && !dup; j++) {
			var k = kept[j], dx = cols.x[k] - cols.x[i], dy = cols.y[k] - cols.y[i], dz = use3d ? cols.z[k] - cols.z[i] : 0;
			if (dx * dx + dy * dy + dz * dz <= tol * tol) dup = true;
		}
		if (!dup) kept.push(i);
	}
	return kept;
}

// A cloud with duplicates near earlier points and, with chains, lines of points 0.8 tolerances apart (each only
// within tolerance of its neighbours, so a point's fate depends on a long run of earlier ones)
function cloud(seed, n, tol, chains) {
	var r = rng(seed), span = tol * 300, x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), ref = new Uint16Array(n);
	for (var i = 0; i < n; i++) {
		if (chains) {
			x[i] = Math.round((478000 + r() * span) / (tol * 0.8)) * tol * 0.8 + (r() - 0.5) * tol * 0.1;
			y[i] = 6771000 + Math.floor(r() * 40) * span / 40;
			z[i] = 240 + r() * tol * 0.3;
		} else if (i && r() < 0.35) {
			var j = Math.floor(r() * i);
			x[i] = x[j] + (r() - 0.5) * 3 * tol; y[i] = y[j] + (r() - 0.5) * 3 * tol; z[i] = z[j] + (r() - 0.5) * 3 * tol;
		} else {
			x[i] = 478000 + r() * span; y[i] = 6771000 + r() * span; z[i] = 240 + r() * span * 0.1;
		}
		ref[i] = i & 0xffff;
	}
	return { count: n, x: x, y: y, z: z, intensity: ref, triple: new Float32Array(3 * n).map(function (_, q) { return q; }) };
}

function sameColumns(a, b) {
	assert.equal(a.count, b.count);
	Object.keys(a).forEach(function (name) {
		if (name === "count" || name === "tiles" || name === "threads" || name === "rounds") return;
		assert.equal(a[name].length, b[name].length, name);
		for (var i = 0; i < a[name].length; i++) if (a[name][i] !== b[name][i]) assert.fail(name + " differs at " + i);
	});
}

test("dedupe reports a steady climb from 0 to its total, and the same result with or without a callback", function () {
	var c = cloud(1, 300000, 0.01, false), seen = [];
	var r = dedupe(c, 0.01, { z: true, onProgress: function (d, t) { seen.push([d, t]); } });
	assert.deepEqual(seen[0], [0, 300000]);
	assert.deepEqual(seen[seen.length - 1], [300000, 300000]);
	seen.forEach(function (e, i) { assert.equal(e[1], 300000); if (i) assert.ok(e[0] > seen[i - 1][0], "no step back"); });
	assert.ok(seen.length >= 5, seen.length + " reports");
	sameColumns(r, dedupe(c, 0.01, { z: true }));
	// with the map the total is twice the points, and the climb goes on through the map
	var withMap = [];
	dedupeSelection(c, 0.01, { z: true, onProgress: function (d, t) { withMap.push([d, t]); } });
	assert.equal(withMap[0][1], 600000);
	assert.deepEqual(withMap[withMap.length - 1], [600000, 600000]);
	withMap.forEach(function (e, i) { if (i) assert.ok(e[0] >= withMap[i - 1][0]); });
	assert.ok(withMap.some(function (e) { return e[0] > 300000 && e[0] < 600000; }), "the map pass ticks too");
});

test("dedupe stops with ABORTED when its signal is aborted as it ticks", function () {
	var c = cloud(2, 300000, 0.01, false), stop = new AbortController();
	assert.throws(function () { dedupe(c, 0.01, { signal: stop.signal, onProgress: function (d) { if (d > 100000) stop.abort(); } }); }, { code: "ABORTED" });
	assert.throws(function () { dedupeSelection(c, 0.01, { signal: AbortSignal.abort(), onProgress: function () {} }); }, { code: "ABORTED" });
	var mapStop = new AbortController();
	assert.throws(function () { dedupeSelection(c, 0.01, { signal: mapStop.signal, onProgress: function (d, t) { if (d > t / 2 + 70000) mapStop.abort(); } }); }, { code: "ABORTED" });
});

test("the sweep keeps the brute-force set at every cell size the density picks, and honours points already decided", function () {
	[0.01, 0.2].forEach(function (tol) {
		var c = cloud(3, 4000, tol, false);
		[false, true].forEach(function (use3d) {
			var want = bruteForce(c, tol, use3d), got = dedupeSweep(c.x, c.y, use3d ? c.z : null, c.count, tol).kept;
			assert.deepEqual(Array.from(got), want);
		});
	});
	// frozen: 1 stands as kept without a test, 2 is dropped, 0 is swept
	var x = Float64Array.from([0, 0.001, 0.002, 5]), y = new Float64Array(4), n = 4;
	assert.deepEqual(Array.from(dedupeSweep(x, y, null, n, 0.01).kept), [0, 3]);
	assert.deepEqual(Array.from(dedupeSweep(x, y, null, n, 0.01, { frozen: Uint8Array.from([2, 0, 0, 0]) }).kept), [1, 3]);
	assert.deepEqual(Array.from(dedupeSweep(x, y, null, n, 0.01, { frozen: Uint8Array.from([1, 1, 0, 0]) }).kept), [0, 1, 3]);
	assert.deepEqual(Array.from(dedupeSweep(new Float64Array(0), new Float64Array(0), null, 0, 0.01).kept), []);
	assert.equal(dedupeSweep(new Float64Array(0), new Float64Array(0), null, 0, 0.01).nearest(0), -1);
});

test("dedupe copes with a cloud on a line, in one point and in no area", function () {
	var line = { count: 5, x: Float64Array.from([0, 1, 2, 3, 0.001]), y: new Float64Array(5), z: new Float64Array(5) };
	assert.deepEqual(Array.from(dedupeSelection(line, 0.01, { z: true }).keep), [0, 1, 2, 3]);
	var one = { count: 1, x: Float64Array.from([5]), y: Float64Array.from([5]), z: Float64Array.from([5]) };
	assert.deepEqual(Array.from(dedupeSelection(one, 0.01).keep), [0]);
	var wall = { count: 4, x: Float64Array.from([5, 5, 5, 5]), y: Float64Array.from([5, 5, 5, 5]), z: Float64Array.from([0, 0.001, 1, 1.0005]) };
	assert.deepEqual(Array.from(dedupeSelection(wall, 0.01, { z: true }).keep), [0, 2]);
	assert.deepEqual(Array.from(dedupeSelection(wall, 0.01).keep), [0]);
});

test("dedupeParallel keeps what dedupe keeps, in the same order with every column, across the seams (2D and 3D)", { timeout: 120000 }, async function () {
	var rounds = {};
	for (var trial = 0; trial < 12; trial++) {
		var tol = [0.01, 0.05, 0.5][trial % 3], c = cloud(100 + trial, 15000 + trial * 2500, tol, trial % 4 === 0);
		for (var use of [false, true]) {
			var want = dedupe(c, tol, { z: use }), side = tol * 300 / (2 + (trial % 5));
			var got = await dedupeParallel(c, tol, { z: use, threads: 3, tile: Math.max(side, 8 * tol) });
			sameColumns(got, want);
			assert.ok(got.tiles >= 2 && got.threads >= 2, "tiles " + got.tiles + ", threads " + got.threads);
			rounds[got.rounds] = true;
		}
	}
	assert.ok(rounds[0] && Object.keys(rounds).length > 1, "some runs settled at once and some needed another sweep of a tile: " + Object.keys(rounds));
	// the brute-force oracle on one of them
	var small = cloud(7, 3000, 0.05, true), res = await dedupeParallel(small, 0.05, { z: true, threads: 2, tile: 0.8 });
	assert.deepEqual(Array.from(res.x), bruteForce(small, 0.05, true).map(function (i) { return small.x[i]; }));
});

test("dedupeParallel on Float32 columns, with no z column, and with a z column but a plan comparison", { timeout: 60000 }, async function () {
	var c = cloud(21, 20000, 0.05, false);
	var f = { count: c.count, x: Float32Array.from(c.x.map(function (v) { return v - 478000; })), y: Float32Array.from(c.y.map(function (v) { return v - 6771000; })), z: Float32Array.from(c.z) };
	sameColumns(await dedupeParallel(f, 0.05, { z: true, threads: 2, tile: 3 }), dedupe(f, 0.05, { z: true }));
	var flat = { count: c.count, x: c.x, y: c.y };
	sameColumns(await dedupeParallel(flat, 0.05, { z: true, threads: 2, tile: 4 }), dedupe(flat, 0.05, { z: true }));
	sameColumns(await dedupeParallel(c, 0.05, { threads: 2, tile: 4 }), dedupe(c, 0.05));
});

test("dedupeParallel reports one climbing bar of 1000 from 0 to the end", { timeout: 60000 }, async function () {
	var c = cloud(31, 30000, 0.05, false), seen = [];
	await dedupeParallel(c, 0.05, { z: true, threads: 3, tile: 4, onProgress: function (d, t) { seen.push([d, t]); } });
	assert.deepEqual(seen[0], [0, 1000]);
	assert.deepEqual(seen[seen.length - 1], [1000, 1000]);
	seen.forEach(function (e, i) { assert.equal(e[1], 1000); if (i) assert.ok(e[0] > seen[i - 1][0]); });
	assert.ok(seen.length >= 4);
	var one = [];
	await dedupeParallel(c, 0.05, { z: true, threads: 1, onProgress: function (d, t) { one.push([d, t]); } });
	assert.deepEqual(one[0], [0, 1000]);
	assert.deepEqual(one[one.length - 1], [1000, 1000]);
});

test("dedupeParallel on a small cloud, one thread or no points is dedupe on this thread; options are checked", { timeout: 60000 }, async function () {
	var c = cloud(41, 5000, 0.05, false);
	var a = await dedupeParallel(c, 0.05, { z: true });
	assert.equal(a.tiles, 1); assert.equal(a.threads, 1); assert.equal(a.rounds, 0);
	sameColumns(a, dedupe(c, 0.05, { z: true }));
	var b = await dedupeParallel(c, 0.05, { z: true, threads: 1, tile: 4 });
	assert.equal(b.tiles, 1);
	var none = await dedupeParallel({ count: 0, x: new Float64Array(0), y: new Float64Array(0) }, 0.05, { threads: 3 });
	assert.equal(none.count, 0);
	var plain = await dedupeParallel({ count: 3, x: [0, 0.001, 1], y: [0, 0, 0] }, 0.05, { threads: 3, tile: 1 });   // arrays that are not typed
	assert.equal(plain.count, 2);   // swept here, as dedupe does
	for (var bad of [{ threads: 0 }, { threads: 1.5 }, { tile: -1 }, { tile: "a" }])
		await assert.rejects(dedupeParallel(c, 0.05, bad), { code: "INVALID_ARGUMENT" });
	await assert.rejects(dedupeParallel(c, 0), { code: "INVALID_ARGUMENT" });
	await assert.rejects(dedupeParallel(c, 0.05, { signal: AbortSignal.abort() }), { code: "ABORTED" });
});

test("dedupeParallel can be stopped while its tiles run", { timeout: 60000 }, async function () {
	var c = cloud(51, 60000, 0.05, false), stop = new AbortController();
	await assert.rejects(dedupeParallel(c, 0.05, { z: true, threads: 2, tile: 3, signal: stop.signal, onProgress: function (d) { if (d > 100) stop.abort(); } }), { code: "ABORTED" });
});
