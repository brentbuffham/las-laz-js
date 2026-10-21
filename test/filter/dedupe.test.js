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
import { dedupe } from "../../src/filter/dedupe.js";

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
	// string-keyed grid: ~27,000 ms. Not timed under coverage, which instruments src about 3x slower
	if (!process.env.NODE_V8_COVERAGE) assert.ok(ms < 10000, "2D + 3D took " + Math.round(ms) + " ms");
});
