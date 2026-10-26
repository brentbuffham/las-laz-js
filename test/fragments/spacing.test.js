// test/fragments/spacing.test.js
//==========================================================
// pointSpacing: a square grid, a jittered grid and a Poisson sample of
// known density come back at their spacing (1 / sqrt(density)); a wall
// and a UTM-sized origin give the same; under 9 points is NaN.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pointSpacing } from "../../src/fragments/spacing.js";
import * as lib from "../../src/index.js";

function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6d2b79f5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// n x n points at spacing s: axes picks which two coordinates carry the grid (the third is 0); o the origin
function grid(n, s, opts) {
	var o = opts || {}, r = o.jitter ? rng(7) : null, m = n * n, x = new Float64Array(m), y = new Float64Array(m), z = new Float64Array(m), O = o.origin || [0, 0, 0];
	for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
		var k = i * n + j, u = i * s + (r ? (r() * 2 - 1) * o.jitter * s : 0), v = j * s + (r ? (r() * 2 - 1) * o.jitter * s : 0);
		if (o.wall) { x[k] = O[0] + u; y[k] = O[1]; z[k] = O[2] + v; } else { x[k] = O[0] + u; y[k] = O[1] + v; z[k] = O[2]; }
	}
	return { count: m, x: x, y: y, z: z };
}
function near(got, want, tol, what) { assert.ok(Math.abs(got - want) <= tol * want, what + ": " + got + " not within " + (tol * 100) + " % of " + want); }

test("a square grid", function () {
	near(pointSpacing(grid(200, 0.02)), 0.02, 0.05, "grid");
});

test("a jittered grid and a Poisson sample", function () {
	near(pointSpacing(grid(200, 0.02, { jitter: 0.4 })), 0.02, 0.1, "jittered");
	// 40,000 uniform points on 4 x 4 m: density 2,500 a square metre, spacing 1 / sqrt(2500) = 0.02
	var r = rng(3), n = 40000, x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
	for (var i = 0; i < n; i++) { x[i] = 4 * r(); y[i] = 4 * r(); }
	near(pointSpacing({ count: n, x: x, y: y, z: z }), 0.02, 0.1, "Poisson");
});

test("a wall is the same", function () {
	var flat = pointSpacing(grid(120, 0.02)), wall = pointSpacing(grid(120, 0.02, { wall: true }));
	assert.ok(Math.abs(flat - wall) <= 1e-9, flat + " vs " + wall);
});

test("UTM magnitude is the same", function () {
	var here = pointSpacing(grid(120, 0.02)), utm = pointSpacing(grid(120, 0.02, { origin: [478000, 6771000, 240] }));
	assert.ok(Math.abs(here - utm) <= 1e-6, here + " vs " + utm);
});

test("too few points", function () {
	var eight = { count: 8, x: new Float64Array(8).map(function (_, i) { return i; }), y: new Float64Array(8), z: new Float64Array(8) };
	assert.ok(Number.isNaN(pointSpacing(eight)));
	assert.ok(Number.isNaN(pointSpacing({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) })));
});

test("sample", function () {
	near(pointSpacing(grid(200, 0.02), { sample: 100 }), 0.02, 0.1, "100 sampled");
	[8, 2.5, "x"].forEach(function (s) { assert.throws(function () { pointSpacing(grid(10, 0.02), { sample: s }); }, /sample/); });
});

test("exports", function () {
	assert.equal(lib.pointSpacing, pointSpacing);
});

test("small clouds", function () {
	// under the sample size every point is measured; under 32 points the farthest found is scaled to 32
	near(pointSpacing(grid(50, 0.02)), 0.02, 0.05, "2,500 points");
	var s = pointSpacing(grid(5, 0.02));   // 25 points
	assert.ok(s > 0 && Number.isFinite(s), "25 points: " + s);
});
