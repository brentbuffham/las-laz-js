// test/index/ray.test.js
//==========================================================
// pointsNearRay against a plain scan: for every point, t = (p - o)·û
// along the ray and d = |(p - o) × û| from its axis; a point is
// returned when t >= 0, t <= maxT and d <= radius + growth · t (a
// cylinder for growth 0, a cone for growth > 0). Rays start inside
// and far outside the cloud, in random and axis-aligned directions.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex } from "../../src/index/grid.js";
import { pointsNearRay } from "../../src/index/query.js";
import * as lib from "../../src/index.js";
import { randomCloud, pointReader, rng } from "../helpers/clouds.js";

function bruteRay(cols, o, dir, radius, growth, maxT) {
	var len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
	var ux = dir[0] / len, uy = dir[1] / len, uz = dir[2] / len;
	var at = pointReader(cols), points = [], ts = [], ds = [];
	for (var i = 0; i < cols.count; i++) {
		var p = at(i), vx = p[0] - o[0], vy = p[1] - o[1], vz = p[2] - o[2];
		var t = vx * ux + vy * uy + vz * uz;
		if (t < 0 || (maxT !== undefined && t > maxT)) continue;
		var cx = vy * uz - vz * uy, cy = vz * ux - vx * uz, cz = vx * uy - vy * ux;
		var d = Math.sqrt(cx * cx + cy * cy + cz * cz);
		if (d <= radius + growth * t) { points.push(i); ts.push(t); ds.push(d); }
	}
	return { points: points, t: ts, d: ds };
}
function same(got, want, label) {
	assert.deepEqual(Array.from(got.points), want.points, label);
	for (var i = 0; i < want.t.length; i++) {
		assert.ok(Math.abs(got.t[i] - want.t[i]) < 1e-9, label + " t");
		assert.ok(Math.abs(got.d[i] - want.d[i]) < 1e-9, label + " d");
	}
}
function rays(seed, n) {
	var r = rng(seed), out = [];
	var axes = [[1, 0, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1]];
	for (var i = 0; i < n; i++) {
		var o = i % 2 === 0 ? [r() * 100, r() * 100, r() * 100] : [-200 + r() * 500, -200 + r() * 500, -200 + r() * 500];
		var d;
		if (i < axes.length) d = axes[i];
		else if (i % 2 === 1) d = [50 - o[0] + (r() - 0.5) * 60, 50 - o[1] + (r() - 0.5) * 60, 50 - o[2] + (r() - 0.5) * 60];   // towards the cloud
		else d = [r() - 0.5, r() - 0.5, r() - 0.5];
		out.push([o, d]);
	}
	return out;
}

test("pointsNearRay is exported from the package", function () {
	assert.equal(lib.pointsNearRay, pointsNearRay);
});

test("pointsNearRay equals brute force: cylinder and cone, many cell sizes", function () {
	var seed = 1, hits = 0;
	["uniform", "clustered", "plane"].forEach(function (kind) {
		[false, true].forEach(function (positions) {
			var cols = randomCloud(1500, { seed: seed++, kind: kind, float32: positions, positions: positions });
			[0.05, 0.5, 2, 20, 200].forEach(function (cs) {
				var ix = buildIndex(cols, { cellSize: cs });
				rays(seed++, 40).forEach(function (ray) {
					[0.2, 2].forEach(function (radius) {
						[0, 0.01].forEach(function (growth) {
							[undefined, 60].forEach(function (maxT) {
								var want = bruteRay(cols, ray[0], ray[1], radius, growth, maxT);
								hits += want.points.length;
								same(pointsNearRay(ix, ray[0], ray[1], { radius: radius, growth: growth, maxT: maxT }), want, kind + " cs=" + cs + " ray=" + JSON.stringify(ray) + " r=" + radius + " g=" + growth + " maxT=" + maxT);
							});
						});
					});
				});
			});
		});
	});
	assert.ok(hits > 1000, "the rays hit points (" + hits + ")");
});

test("points behind the origin are not returned; the cone widens with t", function () {
	var c = { count: 3, x: new Float64Array([-5, 5, 50]), y: new Float64Array([0.1, 0.1, 0.8]), z: new Float64Array(3) };
	var ix = buildIndex(c);
	var a = pointsNearRay(ix, [0, 0, 0], [1, 0, 0], { radius: 0.5 });
	assert.deepEqual(Array.from(a.points), [1]);
	var b = pointsNearRay(ix, [0, 0, 0], [1, 0, 0], { radius: 0.5, growth: 0.01 });
	assert.deepEqual(Array.from(b.points), [1, 2]);
	assert.ok(b.t instanceof Float64Array && b.d instanceof Float64Array);
	assert.deepEqual(Array.from(b.t), [5, 50]);
	assert.ok(Math.abs(b.d[0] - 0.1) < 1e-12 && Math.abs(b.d[1] - 0.8) < 1e-12);
	assert.deepEqual(Array.from(pointsNearRay(ix, [0, 0, 0], [1, 0, 0], { radius: 0.5, growth: 0.01, maxT: 49 }).points), [1]);
});

test("an unnormalised direction gives the same result as the unit one", function () {
	var cols = randomCloud(2000, { seed: 21 });
	var ix = buildIndex(cols);
	var a = pointsNearRay(ix, [50, 50, 200], [0, 0, -7], { radius: 3 });
	var b = pointsNearRay(ix, [50, 50, 200], [0, 0, -1], { radius: 3 });
	assert.ok(a.points.length > 0);
	assert.deepEqual(Array.from(a.points), Array.from(b.points));
	assert.deepEqual(Array.from(a.t), Array.from(b.t));
});

test("a ray that misses the grid returns empty arrays", function () {
	var ix = buildIndex(randomCloud(500, { seed: 4 }));
	var r = pointsNearRay(ix, [500, 500, 500], [1, 0, 0], { radius: 1 });
	assert.ok(r.points instanceof Uint32Array);
	assert.equal(r.points.length + r.t.length + r.d.length, 0);
	assert.equal(pointsNearRay(ix, [50, 50, 500], [0, 0, 1], { radius: 1 }).points.length, 0);
	var empty = buildIndex({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) });
	assert.equal(pointsNearRay(empty, [0, 0, 0], [1, 0, 0], { radius: 1 }).points.length, 0);
});

test("bad arguments are refused, naming the argument", function () {
	var ix = buildIndex(randomCloud(10, { seed: 5 }));
	assert.throws(function () { pointsNearRay(ix, [0, 0, 0], [0, 0, 0], { radius: 1 }); }, { code: "INVALID_ARGUMENT", message: /direction/ });
	assert.throws(function () { pointsNearRay(ix, [0, 0, 0], [0, NaN, 1], { radius: 1 }); }, { message: /direction/ });
	assert.throws(function () { pointsNearRay(ix, [0, 0], [0, 0, 1], { radius: 1 }); }, { message: /origin/ });
	assert.throws(function () { pointsNearRay(ix, [0, 0, 0], [0, 0, 1]); }, { message: /radius/ });
	assert.throws(function () { pointsNearRay(ix, [0, 0, 0], [0, 0, 1], { radius: 0 }); }, { message: /radius/ });
	assert.throws(function () { pointsNearRay(ix, [0, 0, 0], [0, 0, 1], { radius: 1, growth: -1 }); }, { message: /growth/ });
	assert.throws(function () { pointsNearRay(ix, [0, 0, 0], [0, 0, 1], { radius: 1, growth: Infinity }); }, { message: /growth/ });
	assert.throws(function () { pointsNearRay(ix, [0, 0, 0], [0, 0, 1], { radius: 1, maxT: 0 }); }, { message: /maxT/ });
	assert.throws(function () { pointsNearRay({}, [0, 0, 0], [0, 0, 1], { radius: 1 }); }, { message: /pointsNearRay: index is not self-consistent/ });
});
