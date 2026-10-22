// test/index/kdtree.test.js
//==========================================================
// The k-d tree's k-nearest search against a plain scan sorted by
// (distance², point number): uniform, clustered and flat clouds, a
// cloud whose density changes 1,000-fold, heavy duplicates, Float32
// and Float64, x / y / z and positions; skip, maxDistance, k above
// the count; count 0 and 1; and the tree's invariant (every left
// point ≤ its node's split, every right point ≥ it).
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKdTree, kdNearest } from "../../src/index/kdtree.js";
import { randomCloud, pointReader, rng } from "../helpers/clouds.js";

function brute(cols, q, k, maxD2, skip) {
	var at = pointReader(cols), all = [];
	for (var i = 0; i < cols.count; i++) {
		if (i === skip) continue;
		var p = at(i), dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2], d = dx * dx + dy * dy + dz * dz;
		if (d <= maxD2) all.push([d, i]);
	}
	all.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
	return all.slice(0, k);
}
function check(cols, label) {
	var tree = buildKdTree(cols, "t"), at = pointReader(cols), r = rng(cols.count);
	[1, 8, 16, 40].forEach(function (k) {
		var P = new Uint32Array(k), D = new Float64Array(k);
		[Infinity, 0.25, 4].forEach(function (maxD2) {
			for (var t = 0; t < 40; t++) {
				var own = t % 2 === 0, i = Math.floor(r() * cols.count), q = own ? at(i) : [r() * 120 - 10, r() * 120 - 10, r() * 120 - 10];
				var skip = own ? i : -1, m = kdNearest(tree, q[0], q[1], q[2], k, maxD2, skip, P, D), want = brute(cols, q, k, maxD2, skip);
				assert.equal(m, want.length, label + " k=" + k + " maxD2=" + maxD2 + " q=" + q);
				assert.deepEqual(Array.from(P.subarray(0, m)), want.map(function (w) { return w[1]; }), label + " k=" + k + " maxD2=" + maxD2 + " q=" + q);
				assert.deepEqual(Array.from(D.subarray(0, m)), want.map(function (w) { return w[0]; }), label + " d");
			}
		});
	});
}

test("kdNearest equals brute force", function () {
	var seed = 1;
	["uniform", "clustered", "plane"].forEach(function (kind) {
		[false, true].forEach(function (float32) {
			[false, true].forEach(function (positions) {
				check(randomCloud(1500, { seed: seed++, kind: kind, float32: float32, positions: positions }), kind + " f32=" + float32 + " pos=" + positions);
			});
		});
	});
});

test("density changing 1,000-fold, and heavy duplicates", function () {
	var r = rng(3), n = 3000, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) {
		var s = i < 2000 ? 0.1 : 100;   // a dense patch and a sparse spread
		c.x[i] = r() * s; c.y[i] = r() * s; c.z[i] = r() * s * 0.1;
	}
	check(c, "density");
	var d = { count: 800, x: new Float64Array(800), y: new Float64Array(800), z: new Float64Array(800) };
	for (i = 0; i < 800; i++) { d.x[i] = i % 4; d.y[i] = (i % 3) * 0.5; d.z[i] = 0; }   // 12 locations, ~67 copies each
	check(d, "duplicates");
});

test("count 0 and 1, and k above the count", function () {
	var P = new Uint32Array(5), D = new Float64Array(5);
	var e = buildKdTree({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }, "t");
	assert.equal(kdNearest(e, 0, 0, 0, 5, Infinity, -1, P, D), 0);
	var one = buildKdTree({ count: 1, x: new Float64Array([1]), y: new Float64Array([2]), z: new Float64Array([3]) }, "t");
	assert.equal(kdNearest(one, 0, 0, 0, 5, Infinity, -1, P, D), 1);
	assert.equal(D[0], 14);
	assert.equal(kdNearest(one, 1, 2, 3, 5, Infinity, 0, P, D), 0);
	var c = randomCloud(7, { seed: 4 }), t7 = buildKdTree(c, "t"), P9 = new Uint32Array(9), D9 = new Float64Array(9);
	assert.equal(kdNearest(t7, 50, 50, 50, 9, Infinity, -1, P9, D9), 7);
});

test("every left point is at most its node's split, every right point at least", function () {
	var c = randomCloud(5000, { seed: 9, kind: "clustered" }), at = pointReader(c);
	for (var i = 0; i < 300; i++) { c.x[i] = 7; c.y[i] = 8; c.z[i] = 9; }   // a cluster, for uniform nodes
	var tree = buildKdTree(c, "t");
	var bad = 0;
	(function walk(node, lo, hi) {
		if (hi - lo <= tree.leafSize) return;
		if (tree.axis[node] === 3) {   // uniform: one point, numbers ascending
			for (var u = lo + 1; u < hi; u++) if (tree.perm[u] < tree.perm[u - 1] || at(tree.perm[u]).join() !== at(tree.perm[lo]).join()) bad++;
			return;
		}
		var mid = Math.floor((lo + hi) / 2), a = tree.axis[node], s = tree.split[node];
		for (var j = lo; j < mid; j++) if (at(tree.perm[j])[a] > s) bad++;
		for (j = mid; j < hi; j++) if (at(tree.perm[j])[a] < s) bad++;
		walk(2 * node + 1, lo, mid); walk(2 * node + 2, mid, hi);
	})(0, 0, c.count);
	assert.equal(bad, 0);
	var seen = new Uint8Array(c.count);
	tree.perm.forEach(function (p) { seen[p]++; });
	assert.ok(seen.every(function (v) { return v === 1; }), "perm is a permutation");
});

test("a 1 M-point tree builds in a few seconds and costs under 5 bytes a point", function () {
	var c = randomCloud(1000000, { seed: 10, kind: "clustered", float32: true });
	var t0 = performance.now(), tree = buildKdTree(c, "t"), ms = performance.now() - t0;
	if (!process.env.NODE_V8_COVERAGE) assert.ok(ms < 5000, "built in " + Math.round(ms) + " ms");
	assert.ok((tree.perm.byteLength + tree.axis.byteLength + tree.split.byteLength) / c.count < 5);
});

test("bad columns are refused, naming the caller", function () {
	assert.throws(function () { buildKdTree({ count: 2, x: new Float64Array(2), y: new Float64Array(2) }, "selectOutliers"); }, { code: "INVALID_ARGUMENT", message: /selectOutliers needs x, y, z/ });
	var c = { count: 3, x: new Float64Array([0, NaN, 1]), y: new Float64Array(3), z: new Float64Array(3) };
	assert.throws(function () { buildKdTree(c, "t"); }, { code: "INVALID_ARGUMENT", message: /point 1 has a non-finite x/ });
});

test("a cluster of 20,000 coincident points stays fast (ties need not visit every copy)", function () {
	// 20,000 copies of one point among 20,000 others: every copy ties, and the lowest numbers
	// win, so a search that cannot rule out a tie visits all 20,000 (quadratic over the cloud)
	var r = rng(12), n = 40000, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) if (i % 2) { c.x[i] = r() * 50; c.y[i] = r() * 50; c.z[i] = r() * 5; } else { c.x[i] = 25; c.y[i] = 25; c.z[i] = 2; }
	var tree = buildKdTree(c, "t"), P = new Uint32Array(8), D = new Float64Array(8);
	var t0 = performance.now();
	for (i = 0; i < n; i++) kdNearest(tree, c.x[i], c.y[i], c.z[i], 8, Infinity, i, P, D);
	var ms = performance.now() - t0;
	if (!process.env.NODE_V8_COVERAGE) assert.ok(ms < 500, "40,000 searches took " + Math.round(ms) + " ms");
	// and still the lowest-numbered copies
	assert.equal(kdNearest(tree, 25, 25, 2, 8, Infinity, 0, P, D), 8);
	assert.deepEqual(Array.from(P), [2, 4, 6, 8, 10, 12, 14, 16]);
});
