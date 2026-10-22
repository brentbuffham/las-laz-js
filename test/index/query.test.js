// test/index/query.test.js
//==========================================================
// pointsInRadius and nearestPoint against plain scans in Float64
// (ties to the lowest point number), over uniform, clustered and
// flat clouds, Float32 and Float64, x / y / z and positions, cell
// sizes far below and far above the query radius, and query points
// inside and outside the grid; plus hand-worked edges.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex } from "../../src/index/grid.js";
import { pointsInRadius, nearestPoint } from "../../src/index/query.js";
import * as lib from "../../src/index.js";
import { randomCloud, pointReader, rng } from "../helpers/clouds.js";

function d2(p, q, xy) {
	var dx = p[0] - q[0], dy = p[1] - q[1], dz = xy ? 0 : p[2] - q[2];
	return dx * dx + dy * dy + dz * dz;
}
function bruteRadius(cols, q, r, xy) {
	var at = pointReader(cols), out = [];
	for (var i = 0; i < cols.count; i++) if (d2(at(i), q, xy) <= r * r) out.push(i);
	return out;
}
function bruteNearest(cols, q, maxD, xy) {
	var at = pointReader(cols), best = -1, bd = Infinity;
	for (var i = 0; i < cols.count; i++) {
		var d = d2(at(i), q, xy);
		if (maxD !== undefined && d > maxD * maxD) continue;
		if (d < bd) { bd = d; best = i; }
	}
	return best;
}
function queries(seed, n) {
	var r = rng(seed), out = [];
	for (var i = 0; i < n; i++) {
		if (i % 2 === 0) out.push([r() * 100, r() * 100, r() * 100]);
		else out.push([-50 + r() * 200, -50 + r() * 200, -50 + r() * 200]);
	}
	return out;
}
function sweep(fn) {
	var seed = 1;
	["uniform", "clustered", "plane"].forEach(function (kind) {
		[false, true].forEach(function (float32) {
			[false, true].forEach(function (positions) {
				var cols = randomCloud(1500, { seed: seed++, kind: kind, float32: float32, positions: positions });
				[0.05, 0.5, 2, 20, 200].forEach(function (cs) {
					fn(cols, buildIndex(cols, { cellSize: cs }), queries(seed++, 50), kind + " f32=" + float32 + " pos=" + positions + " cs=" + cs);
				});
			});
		});
	});
}

test("the queries are exported from the package", function () {
	assert.equal(lib.pointsInRadius, pointsInRadius);
	assert.equal(lib.nearestPoint, nearestPoint);
});

test("pointsInRadius equals brute force", function () {
	sweep(function (cols, ix, qs, label) {
		qs.forEach(function (q) {
			[0.3, 3, 30].forEach(function (r) {
				[false, true].forEach(function (xy) {
					assert.deepEqual(Array.from(pointsInRadius(ix, q, r, { xy: xy })), bruteRadius(cols, q, r, xy), label + " q=" + q + " r=" + r + " xy=" + xy);
				});
			});
		});
	});
});

test("pointsInRadius returns a Uint32Array selection", function () {
	var cols = randomCloud(200, { seed: 9 });
	var s = pointsInRadius(buildIndex(cols), [50, 50, 50], 40);
	assert.ok(s instanceof Uint32Array);
	assert.ok(s.length > 0);
});

test("nearestPoint equals brute force, inside and outside the grid", function () {
	sweep(function (cols, ix, qs, label) {
		qs.forEach(function (q) {
			[undefined, 0.5, 5].forEach(function (maxD) {
				[false, true].forEach(function (xy) {
					assert.equal(nearestPoint(ix, q, { maxDistance: maxD, xy: xy }), bruteNearest(cols, q, maxD, xy), label + " q=" + q + " maxD=" + maxD + " xy=" + xy);
				});
			});
		});
	});
});

test("points exactly at the radius are included; coincident points all returned", function () {
	var c = { count: 5, x: new Float64Array([0, 3, 3, 3, 7]), y: new Float64Array(5), z: new Float64Array(5) };
	var ix = buildIndex(c);
	assert.deepEqual(Array.from(pointsInRadius(ix, [0, 0, 0], 3)), [0, 1, 2, 3]);
	assert.equal(nearestPoint(ix, [3, 0, 0]), 1);
	assert.equal(nearestPoint(ix, [3, 0, 0], { maxDistance: 0.001 }), 1);
	assert.equal(nearestPoint(ix, [7, 0, 4], { maxDistance: 4 }), 4);
});

test("xy: a crest point above a toe point", function () {
	// 0: crest (10, 0, 20), 1: toe (10.4, 0, 10)
	var c = { count: 2, x: new Float64Array([10, 10.4]), y: new Float64Array(2), z: new Float64Array([20, 10]) };
	var ix = buildIndex(c);
	assert.equal(nearestPoint(ix, [10.3, 0, 0], { xy: true }), 1);
	assert.equal(nearestPoint(ix, [10.3, 0, 0]), 1);
	assert.equal(nearestPoint(ix, [10.1, 0, 25], { xy: true }), 0);
	assert.equal(nearestPoint(ix, [10.1, 0, 25]), 0);
	assert.equal(nearestPoint(ix, [10.1, 0], { xy: true }), 0);
	assert.deepEqual(Array.from(pointsInRadius(ix, [10.2, 0], 0.25, { xy: true })), [0, 1]);
});

test("a small maxDistance on a big empty grid returns -1 quickly", function () {
	var c = { count: 2, x: new Float64Array([0, 10000]), y: new Float64Array(2), z: new Float64Array(2) };
	var ix = buildIndex(c, { cellSize: 0.1 });
	var t0 = performance.now();
	assert.equal(nearestPoint(ix, [5000, 0, 0], { maxDistance: 1 }), -1);
	assert.ok(performance.now() - t0 < 50);
	assert.equal(nearestPoint(ix, [5000, 0, 0]), 0);
	assert.equal(nearestPoint(ix, [5001, 0, 0]), 1);
});

test("an empty index answers -1 and an empty selection", function () {
	var ix = buildIndex({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) });
	assert.equal(nearestPoint(ix, [0, 0, 0]), -1);
	assert.equal(pointsInRadius(ix, [0, 0, 0], 5).length, 0);
});

test("Float32 positions at local-origin magnitude equal the Float64 x / y / z", function () {
	var r = rng(77), n = 10000;
	var pos = new Float32Array(3 * n), c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) {
		pos[3 * i] = -500 + r() * 1000; pos[3 * i + 1] = -500 + r() * 1000; pos[3 * i + 2] = -20 + r() * 60;
		c.x[i] = pos[3 * i]; c.y[i] = pos[3 * i + 1]; c.z[i] = pos[3 * i + 2];
	}
	var a = buildIndex({ count: n, positions: pos }), b = buildIndex(c);
	for (var k = 0; k < 200; k++) {
		var q = [-520 + r() * 1040, -520 + r() * 1040, -30 + r() * 80];
		assert.equal(nearestPoint(a, q), nearestPoint(b, q));
		assert.equal(nearestPoint(a, q, { xy: true }), nearestPoint(b, q, { xy: true }));
		assert.deepEqual(Array.from(pointsInRadius(a, q, 15)), Array.from(pointsInRadius(b, q, 15)));
	}
});

test("bad arguments are refused, naming the argument", function () {
	var ix = buildIndex(randomCloud(10, { seed: 3 }));
	assert.throws(function () { nearestPoint(ix, [1, 2]); }, { code: "INVALID_ARGUMENT", message: /point/ });
	assert.throws(function () { nearestPoint(ix, [1, NaN, 2]); }, { message: /point/ });
	assert.throws(function () { nearestPoint(ix, [1, 2, 3, 4]); }, { message: /point/ });
	assert.throws(function () { nearestPoint(ix, "1,2,3"); }, { message: /point/ });
	assert.throws(function () { pointsInRadius(ix, [1, 2, 3], 0); }, { message: /radius/ });
	assert.throws(function () { pointsInRadius(ix, [1, 2, 3]); }, { message: /radius/ });
	assert.throws(function () { pointsInRadius(ix, [1, Infinity], 2, { xy: true }); }, { message: /point/ });
	assert.throws(function () { nearestPoint(ix, [1, 2, 3], { maxDistance: -1 }); }, { message: /maxDistance/ });
	assert.throws(function () { nearestPoint(Object.assign({}, ix, { count: 99 }), [1, 2, 3]); }, { message: /nearestPoint: index is not self-consistent/ });
	assert.throws(function () { pointsInRadius({}, [1, 2, 3], 1); }, { message: /pointsInRadius: index is not self-consistent/ });
});
