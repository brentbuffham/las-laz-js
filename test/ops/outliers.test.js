// test/ops/outliers.test.js
//==========================================================
// selectOutliers against PDAL's statistical rule done by brute force:
// every point's mean distance to its k nearest other points, the mean
// and sample standard deviation (n - 1, Welford as PDAL) of those
// means, and the points above mean + multiplier · sd. Points whose
// mean lies on the threshold (within 1e-9 of it) are left out of the
// comparison: summation order may differ there.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOutliers } from "../../src/ops/outliers.js";
import * as lib from "../../src/index.js";
import { randomCloud, pointReader } from "../helpers/clouds.js";

function bruteMeans(cols, k) {
	var at = pointReader(cols), n = cols.count, pts = [], means = new Float64Array(n);
	for (var i = 0; i < n; i++) pts.push(at(i));
	for (i = 0; i < n; i++) {
		var ds = [];
		for (var j = 0; j < n; j++) {
			if (j === i) continue;
			var dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1], dz = pts[j][2] - pts[i][2];
			ds.push(dx * dx + dy * dy + dz * dz);
		}
		ds.sort(function (a, b) { return a - b; });
		var s = 0;
		for (j = 0; j < k; j++) s += Math.sqrt(ds[j]);
		means[i] = s / k;
	}
	return means;
}
function bruteRule(cols, k, mult) {
	var means = bruteMeans(cols, k), n = cols.count, M1 = 0, M2 = 0;
	for (var i = 0; i < n; i++) { var d = means[i] - M1, dn = d / (i + 1); M1 += dn; M2 += d * dn * i; }
	var thr = M1 + mult * Math.sqrt(M2 / (n - 1)), out = [], edge = new Set();
	for (i = 0; i < n; i++) {
		if (Math.abs(means[i] - thr) <= 1e-9 * Math.max(1, Math.abs(thr))) edge.add(i);
		if (means[i] > thr) out.push(i);
	}
	return { flagged: out, edge: edge };
}
function sameOffEdge(got, want, label) {
	var g = Array.from(got).filter(function (i) { return !want.edge.has(i); });
	var w = want.flagged.filter(function (i) { return !want.edge.has(i); });
	assert.deepEqual(g, w, label);
}

test("selectOutliers is exported from the package", function () {
	assert.equal(lib.selectOutliers, selectOutliers);
});

test("selectOutliers equals the brute-force statistical rule", function () {
	var seed = 1;
	["uniform", "clustered", "plane"].forEach(function (kind) {
		[false, true].forEach(function (float32) {
			[false, true].forEach(function (positions) {
				var cols = randomCloud(700, { seed: seed++, kind: kind, float32: float32, positions: positions });
				[1, 8, 20].forEach(function (k) {
					[0, 1, 2, 3].forEach(function (mult) {
						var got = selectOutliers(cols, { k: k, multiplier: mult });
						assert.ok(got instanceof Uint32Array);
						sameOffEdge(got, bruteRule(cols, k, mult), kind + " f32=" + float32 + " pos=" + positions + " k=" + k + " m=" + mult);
					});
				});
			});
		});
	});
});

test("one far point among a grid is the only outlier", function () {
	var n = 901, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < 900; i++) { c.x[i] = (i % 30) * 0.1; c.y[i] = Math.floor(i / 30) * 0.1; }
	c.x[900] = 1.5; c.y[900] = 1.5; c.z[900] = 5;
	assert.deepEqual(Array.from(selectOutliers(c)), [900]);
});

test("a 10 × 10 × 10 lattice flags exactly its 8 corners at multiplier 2", function () {
	// a corner's 8 nearest average 1.40 apart, an interior point's 1.10: the corners stand out
	var n = 1000, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = i % 10; c.y[i] = Math.floor(i / 10) % 10; c.z[i] = Math.floor(i / 100); }
	assert.deepEqual(Array.from(selectOutliers(c)), [0, 9, 90, 99, 900, 909, 990, 999]);
});

test("a cloud of k points or fewer selects nothing; count 0 gives an empty selection", function () {
	var c = randomCloud(8, { seed: 5 });
	assert.equal(selectOutliers(c).length, 0);
	assert.equal(selectOutliers(c, { k: 3 }).length, bruteRule(c, 3, 2).flagged.length);
	assert.equal(selectOutliers({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }).length, 0);
});

test("coincident points count as distance 0", function () {
	var n = 403, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < 400; i++) { c.x[i] = (i % 20) * 0.1; c.y[i] = Math.floor(i / 20) * 0.1; }
	for (i = 400; i < 403; i++) { c.x[i] = 0.55; c.y[i] = 0.55; c.z[i] = 0; }
	var got = selectOutliers(c), want = bruteRule(c, 8, 2);
	sameOffEdge(got, want, "copies");
	[400, 401, 402].forEach(function (p) { assert.ok(Array.from(got).indexOf(p) < 0); });
});

test("onProgress is called with the point count at the end", function () {
	var c = randomCloud(500, { seed: 6 }), last = null, calls = 0;
	selectOutliers(c, { onProgress: function (done, total) { calls++; last = [done, total]; } });
	assert.ok(calls > 1);
	assert.deepEqual(last, [500, 500]);
});

test("bad arguments are refused, naming the argument", function () {
	var c = randomCloud(20, { seed: 7 });
	assert.throws(function () { selectOutliers(c, { k: 0 }); }, { code: "INVALID_ARGUMENT", message: /k/ });
	[NaN, Infinity, "2"].forEach(function (m) {
		assert.throws(function () { selectOutliers(c, { multiplier: m }); }, { code: "INVALID_ARGUMENT", message: /multiplier/ });
	});
	assert.throws(function () { selectOutliers(c, { onProgress: 5 }); }, { code: "INVALID_ARGUMENT", message: /onProgress/ });
	assert.throws(function () { selectOutliers({ count: 2, x: new Float64Array(2), y: new Float64Array(2) }); }, { code: "INVALID_ARGUMENT", message: /selectOutliers needs x, y, z/ });
});
