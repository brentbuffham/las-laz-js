// test/index/knn.test.js
//==========================================================
// nearestPoints and knnSearch against a plain scan sorted by
// (distance², point number), over the 0.6.0 sweep of clouds, layouts
// and cell sizes, with queries inside and outside the grid; the
// shared argument checks and the progress ticker.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex } from "../../src/index/grid.js";
import { nearestPoints, knnSearch, checkK, checkMaxDistance, progress } from "../../src/index/knn.js";
import * as lib from "../../src/index.js";
import { randomCloud, pointReader, rng } from "../helpers/clouds.js";

function d2(p, q, xy) {
	var dx = p[0] - q[0], dy = p[1] - q[1], dz = xy ? 0 : p[2] - q[2];
	return dx * dx + dy * dy + dz * dz;
}
function brute(cols, q, k, maxD, xy, skip) {
	var at = pointReader(cols), all = [];
	for (var i = 0; i < cols.count; i++) {
		if (i === skip) continue;
		var d = d2(at(i), q, xy);
		if (maxD === undefined || d <= maxD * maxD) all.push([d, i]);
	}
	all.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
	return all.slice(0, k);
}
function queries(seed, n) {
	var r = rng(seed), out = [];
	for (var i = 0; i < n; i++) {
		if (i % 2 === 0) out.push([r() * 100, r() * 100, r() * 100]);
		else out.push([-50 + r() * 200, -50 + r() * 200, -50 + r() * 200]);
	}
	return out;
}

test("nearestPoints is exported from the package", function () {
	assert.equal(lib.nearestPoints, nearestPoints);
});

test("nearestPoints equals brute force", function () {
	var seed = 1;
	["uniform", "clustered", "plane"].forEach(function (kind) {
		[false, true].forEach(function (float32) {
			[false, true].forEach(function (positions) {
				var cols = randomCloud(600, { seed: seed++, kind: kind, float32: float32, positions: positions });
				[0.05, 0.5, 2, 20, 200].forEach(function (cs) {
					var ix = buildIndex(cols, { cellSize: cs });
					queries(seed++, 12).forEach(function (q) {
						[1, 5, 50, cols.count + 3].forEach(function (k) {
							[undefined, 0.5, 5].forEach(function (maxD) {
								[false, true].forEach(function (xy) {
									var label = kind + " f32=" + float32 + " pos=" + positions + " cs=" + cs + " q=" + q + " k=" + k + " maxD=" + maxD + " xy=" + xy;
									var got = nearestPoints(ix, q, k, { maxDistance: maxD, xy: xy }), want = brute(cols, q, k, maxD, xy, -1);
									assert.deepEqual(Array.from(got.points), want.map(function (w) { return w[1]; }), label);
									assert.deepEqual(Array.from(got.d), want.map(function (w) { return Math.sqrt(w[0]); }), label);
								});
							});
						});
					});
				});
			});
		});
	});
});

test("ties go to the lowest number", function () {
	// 0..3 at distance 1 from the origin, 4 at 0.5
	var c = { count: 5, x: new Float64Array([1, 0, -1, 0, 0.5]), y: new Float64Array([0, 1, 0, -1, 0]), z: new Float64Array(5) };
	var got = nearestPoints(buildIndex(c), [0, 0, 0], 3);
	assert.deepEqual(Array.from(got.points), [4, 0, 1]);
	assert.deepEqual(Array.from(got.d), [0.5, 1, 1]);
});

test("an empty index gives empty arrays; k above the count returns every point", function () {
	var e = nearestPoints(buildIndex({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }), [0, 0, 0], 4);
	assert.equal(e.points.length, 0);
	assert.ok(e.d instanceof Float64Array);
	var c = randomCloud(7, { seed: 4 });
	assert.equal(nearestPoints(buildIndex(c), [50, 50, 50], 100).points.length, 7);
});

test("knnSearch skips the point itself", function () {
	var cols = randomCloud(1200, { seed: 8, kind: "clustered" }), ix = buildIndex(cols), at = pointReader(cols);
	var outP = new Uint32Array(8), outD = new Float64Array(8);
	for (var i = 0; i < 200; i++) {
		var p = at(i), m = knnSearch(ix, p[0], p[1], p[2], 8, Infinity, i, outP, outD);
		var want = brute(cols, p, 8, undefined, false, i);
		assert.equal(m, 8);
		assert.deepEqual(Array.from(outP), want.map(function (w) { return w[1]; }));
		assert.deepEqual(Array.from(outD), want.map(function (w) { return w[0]; }));
	}
});

test("nearestPoints from far off the cloud's edge stops after a few rings", function () {
	var r = rng(91), n = 1000000, c = { count: n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = r() * 1000; c.y[i] = r() * 1000; c.z[i] = r() * 3; }
	var ix = buildIndex(c, { cellSize: 2 });
	[[1500, 500, 1], [-3000, 200, 1], [500, 500, 600], [4000, 4000, -50]].forEach(function (q) {
		nearestPoints(ix, q, 16);
		var t = performance.now(), got = nearestPoints(ix, q, 16), ms = performance.now() - t;
		assert.deepEqual(Array.from(got.points), brute(c, q, 16, undefined, false, -1).map(function (w) { return w[1]; }), "q=" + q);
		if (!(process.env.NODE_V8_COVERAGE || process.env.CI)) assert.ok(ms < 30, "q=" + q + " took " + ms.toFixed(1) + " ms");
	});
});

test("bad arguments are refused, naming the argument", function () {
	var ix = buildIndex(randomCloud(10, { seed: 3 }));
	[0, 1.5, "3", undefined, -2, Infinity].forEach(function (k) {
		assert.throws(function () { nearestPoints(ix, [1, 2, 3], k); }, { code: "INVALID_ARGUMENT", message: /k/ });
	});
	assert.throws(function () { nearestPoints(ix, [1, 2, 3], 2, { maxDistance: -1 }); }, { message: /maxDistance/ });
	assert.throws(function () { nearestPoints(ix, [1, 2], 2); }, { message: /point/ });
	assert.throws(function () { nearestPoints(Object.assign({}, ix, { count: 99 }), [1, 2, 3], 2); }, { message: /nearestPoints: index is not self-consistent/ });
	assert.throws(function () { checkK(0, "k"); }, { code: "INVALID_ARGUMENT", message: /k/ });
	checkK(3, "k");
	assert.throws(function () { checkMaxDistance(undefined); }, { code: "INVALID_ARGUMENT", message: /maxDistance is required.*0\.3 m for a handheld scan/ });
	assert.throws(function () { checkMaxDistance(0); }, { message: /maxDistance/ });
	checkMaxDistance(0.3);
	assert.throws(function () { progress("x", 10); }, { code: "INVALID_ARGUMENT", message: /onProgress must be a function/ });
});

test("progress ticks about every 1 % and ends at the total", function () {
	var calls = [], tick = progress(function (done, total) { calls.push([done, total]); }, 1000);
	for (var i = 1; i <= 1000; i++) tick(i);
	assert.ok(calls.length >= 95 && calls.length <= 105, calls.length + " calls");
	for (var j = 1; j < calls.length; j++) assert.ok(calls[j][0] > calls[j - 1][0]);
	assert.deepEqual(calls[calls.length - 1], [1000, 1000]);
	var none = progress(undefined, 10);
	none(5); none(10);
	var small = [], t2 = progress(function (d, t) { small.push([d, t]); }, 3);
	t2(1); t2(2); t2(3);
	assert.deepEqual(small[small.length - 1], [3, 3]);
});
