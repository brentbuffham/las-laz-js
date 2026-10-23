// test/facets/outline.test.js
//==========================================================
// facetOutline on shapes of known area, laid on a tilted plane at a UTM
// centre: a square, an L (concave), two patches (the larger traced, both
// counted), a hole (counted out, not traced); the outline closed, on the
// plane and anticlockwise seen from the normal.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { facetOutline } from "../../src/facets/outline.js";
import { poleFromOrientation } from "../../src/facets/orientation.js";

var C = [478000.25, 6772000.75, 300.5], N = poleFromOrientation(37, 123);
// an in-plane basis with U x V = N
var U = (function () { var a = [N[1], -N[0], 0], l = Math.hypot(a[0], a[1]); return [a[0] / l, a[1] / l, 0]; })();
var V = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];

// grid points (spacing s) over [x0, x1) x [y0, y1) in-plane, kept where keep(a, b)
function shape(s, x0, x1, y0, y1, keep) {
	var X = [], Y = [], Z = [];
	for (var a = x0 + s / 2; a < x1; a += s) for (var b = y0 + s / 2; b < y1; b += s) {
		if (keep && !keep(a, b)) continue;
		X.push(C[0] + a * U[0] + b * V[0]); Y.push(C[1] + a * U[1] + b * V[1]); Z.push(C[2] + a * U[2] + b * V[2]);
	}
	return { X: Float64Array.from(X), Y: Float64Array.from(Y), Z: Float64Array.from(Z), n: X.length };
}
function run(sh, cell) {
	var pts = new Uint32Array(sh.n); for (var i = 0; i < sh.n; i++) pts[i] = i;
	return facetOutline(sh.X, sh.Y, sh.Z, 1, pts, C, N, cell);
}
// signed in-plane area (U, V) of the outline; > 0 anticlockwise seen from N
function shoelace(o) {
	var s = 0, k = o.length / 3;
	for (var i = 0; i < k; i++) {
		var j = (i + 1) % k;
		var ai = (o[3 * i] - C[0]) * U[0] + (o[3 * i + 1] - C[1]) * U[1] + (o[3 * i + 2] - C[2]) * U[2];
		var bi = (o[3 * i] - C[0]) * V[0] + (o[3 * i + 1] - C[1]) * V[1] + (o[3 * i + 2] - C[2]) * V[2];
		var aj = (o[3 * j] - C[0]) * U[0] + (o[3 * j + 1] - C[1]) * U[1] + (o[3 * j + 2] - C[2]) * U[2];
		var bj = (o[3 * j] - C[0]) * V[0] + (o[3 * j + 1] - C[1]) * V[1] + (o[3 * j + 2] - C[2]) * V[2];
		s += ai * bj - aj * bi;
	}
	return s / 2;
}
function within(v, want, share, what) { assert.ok(Math.abs(v - want) <= share * want, what + ": " + v + " vs " + want); }

test("a 10 x 10 m plane", function () {
	var r = run(shape(0.05, -5, 5, -5, 5), 0.1);
	within(r.area, 100, 0.03, "area");
	assert.ok(r.outline instanceof Float64Array && r.outline.length >= 12);
	for (var i = 0; i < r.outline.length; i += 3) {
		var d = (r.outline[i] - C[0]) * N[0] + (r.outline[i + 1] - C[1]) * N[1] + (r.outline[i + 2] - C[2]) * N[2];
		assert.ok(Math.abs(d) < 1e-9, "vertex on the plane: " + d);
	}
	var a = shoelace(r.outline);
	assert.ok(a > 0, "anticlockwise seen from the normal");
	within(a, 100, 0.03, "outline area");
	assert.equal(r.outline.length / 3, 4, "a square has 4 corners once collinear vertices go");
});

test("an L shape keeps its notch", function () {
	var r = run(shape(0.05, -5, 5, -5, 5, function (a, b) { return !(a > 0 && b > 0); }), 0.1);
	within(r.area, 75, 0.03, "area");
	assert.equal(r.outline.length / 3, 6, "six corners");
	within(shoelace(r.outline), 75, 0.03, "outline area");
});

test("two separate patches: the larger is traced, both counted", function () {
	var r = run(shape(0.05, -5, 5, -3, 3, function (a, b) { return (a < 1) || (a > 5 - 3 && b < 0); }), 0.1);
	// left patch 6 x 6 (a -5..1), right patch 3 x 3 (a 2..5, b -3..0)
	within(r.area, 45, 0.03, "area");
	within(shoelace(r.outline), 36, 0.03, "outline area (the larger patch)");
});

test("a hole is not traced", function () {
	var r = run(shape(0.05, -5, 5, -5, 5, function (a, b) { return !(Math.abs(a) < 1 && Math.abs(b) < 1); }), 0.1);
	within(r.area, 96, 0.03, "area");
	within(shoelace(r.outline), 100, 0.03, "outline area (outer ring only)");
});

test("degenerate inputs", function () {
	var one = { X: Float64Array.of(C[0]), Y: Float64Array.of(C[1]), Z: Float64Array.of(C[2]), n: 1 };
	var r = run(one, 0.5);
	assert.ok(Math.abs(r.area - 0.25) < 1e-12);
	assert.equal(r.outline.length, 12);
	within(shoelace(r.outline), 0.25, 1e-6, "one cell (a shoelace of UTM-sized vertices)");
	var few = shape(0.01, -0.02, 0.02, -0.02, 0.02);
	var f = run(few, 1);
	assert.ok(Math.abs(f.area - 1) < 1e-12, "points in one cell: one cell");
	assert.equal(f.outline.length, 12);
});

// A facet spread over a huge extent (a stray far point, or a tiny cell): the grid falls back to a
// set of filled cells, so memory follows the points, not the extent
test("a huge extent uses a set of cells, not a dense grid", function () {
	// 3 km apart along both in-plane axes: 3e5 x 3e5 cells, far past the dense grid's limit
	var sh = { X: Float64Array.of(C[0], C[0] + 3000 * (U[0] + V[0])), Y: Float64Array.of(C[1], C[1] + 3000 * (U[1] + V[1])), Z: Float64Array.of(C[2], C[2] + 3000 * (U[2] + V[2])), n: 2 };
	var r = run(sh, 0.01);
	assert.ok(Math.abs(r.area - 2 * 0.0001) < 1e-12, "two cells");
	assert.equal(r.outline.length, 12, "one cell traced");
});

// A patch touching itself at a corner (a pinch): the walk turns right there and the ring stays whole
test("a patch that touches itself at a corner", function () {
	// one point at each cell's centre (points on cell edges would drift between cells)
	var cells = [[0, 0], [0, -1], [1, -1], [2, -1], [2, 0], [2, 1], [1, 1]];
	var X = [], Y = [], Z = [];
	cells.forEach(function (c) { var a = c[0] + 0.5, b = c[1] + 0.5; X.push(C[0] + a * U[0] + b * V[0]); Y.push(C[1] + a * U[1] + b * V[1]); Z.push(C[2] + a * U[2] + b * V[2]); });
	var sh = { X: Float64Array.from(X), Y: Float64Array.from(Y), Z: Float64Array.from(Z), n: X.length };
	var r = run(sh, 1);
	within(r.area, 7, 1e-9, "seven cells");
	assert.ok(r.outline.length >= 12);
	var a = shoelace(r.outline);
	assert.ok(a > 0 && a <= 8 + 1e-9, "outer ring, anticlockwise: " + a);
});
