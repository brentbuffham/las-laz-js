// test/filter/dedupe.test.js
//==========================================================
// dedupe against a brute-force oracle: walk the points in order and
// keep one when no point already kept lies within the tolerance
// (first point wins). The grid must give exactly that set — for UTM
// coordinates, for spreads too wide for a dense cell index, in 2D
// and 3D — and stay fast on millions of points.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe, dedupeSelection } from "../../src/filter/dedupe.js";
import { keepPoints } from "../../src/index.js";
import * as lib from "../../src/index.js";

function bruteForce(cols, tol, use3d) {
	var kept = [];
	for (var i = 0; i < cols.count; i++) {
		var dup = false;
		for (var j = 0; j < kept.length && !dup; j++) {
			var k = kept[j];
			var dx = cols.x[k] - cols.x[i], dy = cols.y[k] - cols.y[i], dz = use3d ? cols.z[k] - cols.z[i] : 0;
			if (dx * dx + dy * dy + dz * dz <= tol * tol) dup = true;
		}
		if (!dup) kept.push(i);
	}
	return kept;
}

// Seeded generator, so a failure reproduces
function rng(seed) { return function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

function cloud(n, seed, ox, oy, spread) {
	var r = rng(seed), c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), id: new Uint32Array(n) };
	for (var i = 0; i < n; i++) {
		c.x[i] = ox + r() * spread; c.y[i] = oy + r() * spread; c.z[i] = 300 + r() * 0.5; c.id[i] = i;
		if (i > 0 && r() < 0.3) { var p = Math.floor(r() * i); c.x[i] = c.x[p] + (r() - 0.5) * 0.02; c.y[i] = c.y[p] + (r() - 0.5) * 0.02; }
	}
	return c;
}

test("dedupe keeps exactly the brute-force set (UTM, 2D and 3D)", function () {
	var c = cloud(3000, 7, 478000, 6772000, 2);
	[false, true].forEach(function (use3d) {
		var got = dedupe(c, 0.01, { z: use3d });
		assert.deepEqual(Array.from(got.id), bruteForce(c, 0.01, use3d), use3d ? "3D" : "2D");
	});
});

test("dedupe is exact when the spread is too wide for a dense cell index", function () {
	// 0.001 m cells over 100 km: far more cells than 2^53, so keys are hashed
	var c = cloud(3000, 11, 400000, 6700000, 100000);
	for (var i = 0; i < 1000; i++) { c.x[i] = 400000 + i * 0.0004; c.y[i] = 6700000; }   // a dense run in one corner
	assert.deepEqual(Array.from(dedupe(c, 0.001, { z: true }).id), bruteForce(c, 0.001, true));
	assert.deepEqual(Array.from(dedupe(c, 0.001).id), bruteForce(c, 0.001, false));
});

test("dedupe handles 2 million points in 2D and 3D in a few seconds", { timeout: 60000 }, function () {
	var n = 2000000, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = 478000 + (i % 1414) * 0.05; c.y[i] = 6772000 + Math.floor(i / 1414) * 0.05; c.z[i] = 300 + (i % 7) * 0.01; }
	var t = performance.now();
	assert.equal(dedupe(c, 0.01).count, n);
	assert.equal(dedupe(c, 0.01, { z: true }).count, n);
	var ms = performance.now() - t;
	// string-keyed grid: ~27,000 ms; the typed table: ~3,000 ms alone, up to ~10,000 ms with the
	// suite's files running in parallel. Not timed under coverage (src instrumented, ~3x slower)
	if (!(process.env.NODE_V8_COVERAGE || process.env.CI)) assert.ok(ms < 20000, "2D + 3D took " + Math.round(ms) + " ms");
});

test("dedupe moves every column, k values per point, with the kept points", function () {
	// x = 0, 0.001, 1, 1.001, 2 with tolerance 0.01: points 1 and 3 repeat 0 and 2, so 0, 2, 4 stay
	var c = {
		count: 5,
		x: new Float64Array([0, 0.001, 1, 1.001, 2]), y: new Float64Array(5),
		positions: new Float32Array(15), rgb: new Uint8Array(15),
		classification: new Uint8Array([2, 3, 4, 5, 6]),
		bounds: { minX: 0 }, label: "kad"
	};
	for (var i = 0; i < 5; i++) for (var j = 0; j < 3; j++) { c.positions[i * 3 + j] = i * 3 + j; c.rgb[i * 3 + j] = i * 10 + j; }
	var r = dedupe(c, 0.01);
	assert.equal(r.count, 3);
	assert.deepEqual(Array.from(r.x), [0, 1, 2]);
	assert.deepEqual(Array.from(r.positions), [0, 1, 2, 6, 7, 8, 12, 13, 14]);
	assert.deepEqual(Array.from(r.rgb), [0, 1, 2, 20, 21, 22, 40, 41, 42]);
	assert.deepEqual(Array.from(r.classification), [2, 4, 6]);
	assert.ok(r.positions instanceof Float32Array && r.rgb instanceof Uint8Array);
	assert.equal(r.bounds, c.bounds);        // not a column: passes through
	assert.equal(r.label, "kad");
	// the same kept indices through keepPoints, which is the independent path
	var viaKeep = keepPoints(c, Uint32Array.from([0, 2, 4]));
	["x", "y", "positions", "rgb", "classification"].forEach(function (name) {
		assert.deepEqual(Array.from(r[name]), Array.from(viaKeep[name]), name);
	});
});

test("dedupe on count 0 and on a k = 3 column with all points kept", function () {
	var e = dedupe({ count: 0, x: new Float64Array(0), y: new Float64Array(0), positions: new Float32Array(0) }, 0.01);
	assert.equal(e.count, 0);
	assert.equal(e.positions.length, 0);
	var all = dedupe({ count: 2, x: new Float64Array([0, 5]), y: new Float64Array(2), positions: new Float32Array([1, 2, 3, 4, 5, 6]) }, 0.01);
	assert.deepEqual(Array.from(all.positions), [1, 2, 3, 4, 5, 6]);
});

test("dedupe moves a column named like an Object.prototype member", function () {
	var c = { count: 3, x: new Float64Array([0, 0.001, 5]), y: new Float64Array([0, 0, 5]) };
	Object.defineProperty(c, "__proto__", { value: new Uint8Array([1, 2, 3]), enumerable: true, writable: true, configurable: true });
	var r = dedupe(c, 0.01);
	assert.equal(r.count, 2);
	assert.deepEqual(Array.from(Object.getOwnPropertyDescriptor(r, "__proto__").value), [1, 3]);
});

// The map's oracle: for a dropped point, the nearest kept point within the
// tolerance (lowest number on a tie), as its position in keep
function bruteMap(cols, keep, tol, use3d) {
	var pos = new Map(), map = [];
	keep.forEach(function (k, j) { pos.set(k, j); });
	for (var i = 0; i < cols.count; i++) {
		if (pos.has(i)) { map.push(pos.get(i)); continue; }
		var best = -1, bd = Infinity;
		keep.forEach(function (k) {
			var dx = cols.x[k] - cols.x[i], dy = cols.y[k] - cols.y[i], dz = use3d ? cols.z[k] - cols.z[i] : 0;
			var d = dx * dx + dy * dy + dz * dz;
			if (d <= tol * tol && d < bd) { bd = d; best = k; }
		});
		map.push(pos.get(best));
	}
	return map;
}

test("dedupeSelection is exported from the package", function () {
	assert.equal(lib.dedupeSelection, dedupeSelection);
});

test("dedupeSelection.keep is what dedupe keeps (UTM, 2D and 3D)", function () {
	[false, true].forEach(function (use3d) {
		var c = cloud(3000, 11, 500000, 7000000, 3);
		var sel = dedupeSelection(c, 0.01, { z: use3d });
		assert.ok(sel.keep instanceof Uint32Array);
		assert.deepEqual(Array.from(sel.keep), bruteForce(c, 0.01, use3d));
		var a = keepPoints(c, sel.keep), b = dedupe(c, 0.01, { z: use3d });
		["x", "y", "z", "id"].forEach(function (k) { assert.deepEqual(Array.from(a[k]), Array.from(b[k])); });
		assert.equal(a.count, b.count);
	});
});

test("dedupeSelection.map: kept points map to themselves, dropped to their nearest kept point", function () {
	[false, true].forEach(function (use3d) {
		var c = cloud(3000, 12, 500000, 7000000, 3);
		var sel = dedupeSelection(c, 0.01, { z: use3d });
		assert.ok(sel.map instanceof Uint32Array);
		assert.equal(sel.map.length, c.count);
		for (var j = 0; j < sel.keep.length; j++) assert.equal(sel.map[sel.keep[j]], j);
		assert.deepEqual(Array.from(sel.map), bruteMap(c, Array.from(sel.keep), 0.01, use3d));
	});
});

test("map: false skips the map and keeps exactly the same points", function () {
	[false, true].forEach(function (use3d) {
		var c = cloud(3000, 13, 500000, 7000000, 3);
		var full = dedupeSelection(c, 0.01, { z: use3d }), keepOnly = dedupeSelection(c, 0.01, { z: use3d, map: false });
		assert.equal(keepOnly.map, null);
		assert.deepEqual(Array.from(keepOnly.keep), Array.from(full.keep));
		assert.deepEqual(Array.from(keepOnly.keep), bruteForce(c, 0.01, use3d));
	});
});

test("map names the nearest kept point, not the one that caused the drop", function () {
	// 0 kept; 1 dropped (0.9 from 0); 2 kept (1.7 from 0, and 1 is dropped so it does not block)
	var c = { count: 3, x: new Float64Array([0, 0.9, 1.7]), y: new Float64Array(3) };
	var sel = dedupeSelection(c, 1);
	assert.deepEqual(Array.from(sel.keep), [0, 2]);
	assert.deepEqual(Array.from(sel.map), [0, 1, 1]);
});

test("dedupeSelection on count 0, and its tolerance check", function () {
	var sel = dedupeSelection({ count: 0, x: new Float64Array(0), y: new Float64Array(0) }, 0.5);
	assert.equal(sel.keep.length, 0);
	assert.equal(sel.map.length, 0);
	assert.throws(function () { dedupeSelection({ count: 0, x: new Float64Array(0), y: new Float64Array(0) }, 0); }, { code: "INVALID_ARGUMENT", message: /tolerance/ });
});

test("dedupe keeps more than 2^24 cells (a JS Map stops at 16,777,216 entries)", { timeout: 300000 }, function () {
	// 2^24 + 1 points on a 1 m lattice at a 0.4 m tolerance, each its own cell, and a copy of point 5
	var n = 16777218, c = { count: n, x: new Float32Array(n), y: new Float32Array(n) };
	for (var i = 0; i < n - 1; i++) { c.x[i] = i % 4096; c.y[i] = Math.floor(i / 4096); }
	c.x[n - 1] = c.x[5]; c.y[n - 1] = c.y[5];
	var sel = dedupeSelection(c, 0.4);
	assert.equal(sel.keep.length, n - 1);
	assert.equal(sel.keep[n - 2], n - 2);
	assert.equal(sel.map[n - 1], 5);
	assert.equal(sel.map[n - 2], n - 2);
});
