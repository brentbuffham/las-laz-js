// test/register/fit.test.js
//==========================================================
// fitTransform against known transforms (exact pairs recover m and t),
// noise (RMS near sigma), optimality (no nearby transform of the model
// scores a lower weighted sum of squares), weights, residual parts,
// degenerate sets and bad input; largestEigen4 against N v = lambda v.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitTransform } from "../../src/register/fit.js";
import { largestEigen4 } from "../../src/register/eigen4.js";
import * as lib from "../../src/index.js";
import { rng } from "../helpers/clouds.js";

function gauss(r) { var u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// A rotation from a random unit quaternion (row-major 3 x 3)
function randomRotation(r) {
	var a = gauss(r), b = gauss(r), c = gauss(r), d = gauss(r), n = Math.hypot(a, b, c, d);
	return quatMatrix(a / n, b / n, c / n, d / n);
}
function quatMatrix(w, x, y, z) {
	return [
		1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
		2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
		2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
	];
}
function mul3(A, B) {
	var o = new Array(9);
	for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
	return o;
}
function applyT(T, xyz) {
	var m = T.m, t = T.t, out = new Float64Array(xyz.length);
	for (var i = 0; i < xyz.length; i += 3) {
		var x = xyz[i], y = xyz[i + 1], z = xyz[i + 2];
		out[i] = m[0] * x + m[1] * y + m[2] * z + t[0];
		out[i + 1] = m[3] * x + m[4] * y + m[5] * z + t[1];
		out[i + 2] = m[6] * x + m[7] * y + m[8] * z + t[2];
	}
	return out;
}
function points(r, n, size) { var a = new Float64Array(n * 3); for (var i = 0; i < a.length; i++) a[i] = (r() - 0.5) * size; return a; }
function ssq(T, from, to, w) {
	var p = applyT(T, from), s = 0;
	for (var i = 0; i < p.length / 3; i++) {
		var dx = p[i * 3] - to[i * 3], dy = p[i * 3 + 1] - to[i * 3 + 1], dz = p[i * 3 + 2] - to[i * 3 + 2];
		s += (w ? w[i] : 1) * (dx * dx + dy * dy + dz * dz);
	}
	return s;
}
function close(a, b, tol, what) {
	for (var i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, what + "[" + i + "]: " + a[i] + " vs " + b[i]);
}
function det(m) { return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]); }

test("rigid recovers a known transform", function () {
	var r = rng(1);
	for (var trial = 0; trial < 200; trial++) {
		var n = [3, 4, 10, 50][trial % 4], from = points(r, n, 100);
		var T = { m: randomRotation(r), t: [(r() - 0.5) * 200, (r() - 0.5) * 200, (r() - 0.5) * 200] };
		var f = fitTransform(from, applyT(T, from));
		close(f.transform.m, T.m, 1e-9, "m");
		close(f.transform.t, T.t, 1e-9, "t");
		assert.equal(f.scale, 1);
		assert.equal(f.model, "rigid");
		for (var i = 0; i < n; i++) assert.ok(f.residuals[i] < 1e-9);
	}
});

test("scale recovers rotation, shift and scale", function () {
	var r = rng(2);
	for (var trial = 0; trial < 100; trial++) {
		var n = 5 + (trial % 20), from = points(r, n, 100), s = 0.5 + 1.5 * r(), R = randomRotation(r);
		var T = { m: R.map(function (v) { return v * s; }), t: [r() * 50, r() * 50, r() * 50] };
		var f = fitTransform(from, applyT(T, from), { model: "scale" });
		close(f.transform.m, T.m, 1e-9, "m");
		close(f.transform.t, T.t, 1e-9, "t");
		assert.ok(Math.abs(f.scale - s) < 1e-12);
	}
});

test("UTM magnitude", function () {
	var r = rng(3);
	for (var trial = 0; trial < 50; trial++) {
		var from = points(r, 8, 50), R = randomRotation(r);
		var T = { m: R, t: [478000 + r() * 100, 6772000 + r() * 100, 300 + r() * 10] };
		var f = fitTransform(from, applyT(T, from));
		close(f.transform.t, T.t, 1e-6, "t");
		close(f.transform.m, T.m, 1e-9, "m");
		for (var i = 0; i < 8; i++) assert.ok(f.residuals[i] < 1e-6, "residual " + f.residuals[i]);
	}
});

test("noise gives an RMS near sigma", function () {
	var r = rng(4), n = 500, sigma = 0.01, from = points(r, n, 100);
	var T = { m: randomRotation(r), t: [10, 20, 30] }, to = applyT(T, from);
	for (var i = 0; i < to.length; i++) to[i] += sigma * gauss(r);
	// each residual is 3D (three noise components); the fit takes 6 of the 3n degrees of freedom
	var f = fitTransform(from, to), expect = sigma * Math.sqrt((3 * n - 6) / n);
	assert.ok(f.rms > 0.8 * expect && f.rms < 1.2 * expect, "rms " + f.rms);
});

test("no other rigid transform scores lower", function () {
	var r = rng(5);
	for (var c = 0; c < 20; c++) {
		var n = 12, from = points(r, n, 80), T = { m: randomRotation(r), t: [r() * 9, r() * 9, r() * 9] }, to = applyT(T, from);
		for (var i = 0; i < to.length; i++) to[i] += 0.05 * gauss(r);
		var w = Float64Array.from({ length: n }, function () { return 0.5 + r(); });
		var f = fitTransform(from, to, { weights: w }), best = ssq(f.transform, from, to, w);
		for (var d = 0; d < 50; d++) {
			var e = 1e-4, a = (r() - 0.5) * e, b = (r() - 0.5) * e, g = (r() - 0.5) * e, q = Math.hypot(1, a, b, g);
			var Rd = quatMatrix(1 / q, a / q, b / q, g / q), m2 = mul3(Rd, f.transform.m);
			var t2 = applyT({ m: Rd, t: [(r() - 0.5) * e, (r() - 0.5) * e, (r() - 0.5) * e] }, Float64Array.from(f.transform.t));
			assert.ok(ssq({ m: m2, t: Array.from(t2) }, from, to, w) >= best - 1e-12, "a nearby transform scores lower");
		}
	}
});

test("weights", function () {
	var r = rng(6), from = points(r, 10, 50), T = { m: randomRotation(r), t: [1, 2, 3] }, to = applyT(T, from);
	var moved = Float64Array.from(to); moved[3 * 4] += 5;
	var w = new Float64Array(10).fill(1); w[4] = 0;
	var f = fitTransform(from, moved, { weights: w });
	close(f.transform.m, T.m, 1e-12, "m");
	close(f.transform.t, T.t, 1e-12, "t");
	assert.ok(Math.abs(f.residuals[4] - 5) < 1e-9, "the weight-0 pair's residual is still reported");
	var noisy = Float64Array.from(to); for (var i = 0; i < noisy.length; i++) noisy[i] += 0.01 * gauss(r);
	var w1 = Float64Array.from({ length: 10 }, function () { return r() + 0.1; }), w2 = w1.map(function (v) { return v * 2; });
	var a = fitTransform(from, noisy, { weights: w1 }), b = fitTransform(from, noisy, { weights: w2 });
	close(a.transform.m, b.transform.m, 1e-12, "m");
	close(a.transform.t, b.transform.t, 1e-12, "t");
});

test("dH and dZ", function () {
	var r = rng(7), from = points(r, 9, 40), to = applyT({ m: randomRotation(r), t: [0, 0, 0] }, from);
	for (var i = 0; i < to.length; i++) to[i] += 0.1 * gauss(r);
	var f = fitTransform(from, to), p = applyT(f.transform, from);
	for (var k = 0; k < 9; k++) {
		var rx = p[k * 3] - to[k * 3], ry = p[k * 3 + 1] - to[k * 3 + 1], rz = p[k * 3 + 2] - to[k * 3 + 2];
		assert.ok(Math.abs(f.dH[k] - Math.hypot(rx, ry)) < 1e-12);
		assert.ok(Math.abs(f.dZ[k] - rz) < 1e-12);
		assert.ok(Math.abs(f.residuals[k] - Math.hypot(f.dH[k], f.dZ[k])) < 1e-12);
	}
	assert.ok(Math.abs(f.rms - Math.sqrt(f.residuals.reduce(function (s, v) { return s + v * v; }, 0) / 9)) < 1e-12);
});

test("never a reflection", function () {
	var r = rng(8), from = points(r, 10, 30), to = Float64Array.from(from);
	for (var i = 0; i < to.length; i += 3) to[i] = -to[i];
	assert.ok(det(fitTransform(from, to).transform.m) > 0);
	assert.ok(det(fitTransform(from, to, { model: "scale" }).transform.m) > 0);
});

test("degenerate sets are refused", function () {
	assert.throws(function () { fitTransform([0, 0, 0, 1, 0, 0], [0, 0, 0, 1, 0, 0]); }, /at least 3/);
	assert.throws(function () { fitTransform([0, 0, 0, 1, 1, 1, 2, 2, 2], [0, 0, 0, 1, 1, 1, 2, 2, 2]); }, /line/);
	assert.throws(function () { fitTransform([0, 0, 0, 5, 1, 0, 5, 1, 0], [0, 0, 0, 5, 1, 0, 5, 1, 0]); }, /line/);
	assert.throws(function () { fitTransform([3, 3, 3, 3, 3, 3, 3, 3, 3], [0, 0, 0, 1, 0, 0, 0, 1, 0]); }, /line/);
	assert.throws(function () { fitTransform([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], { model: "scale" }); }, /line/);
});

test("bad input is refused, naming it", function () {
	var a = [0, 0, 0, 1, 0, 0, 0, 1, 0];
	assert.throws(function () { fitTransform(a, a.concat([0, 0, 1])); }, /from.*to|to.*from/);
	assert.throws(function () { fitTransform([0, 0, 0, 1, 0, 0, 0], [0, 0, 0, 1, 0, 0, 0]); }, /multiple of 3/);
	var bad = a.slice(); bad[7] = NaN;
	assert.throws(function () { fitTransform(bad, a); }, /pair 2/);
	assert.throws(function () { fitTransform(a, a, { model: "affine" }); }, /model/);
	assert.throws(function () { fitTransform(a, a, { weights: [1, 1] }); }, /weights/);
	assert.throws(function () { fitTransform(a, a, { weights: [1, -1, 1] }); }, /weights/);
	assert.throws(function () { fitTransform(a, a, { weights: [0, 0, 0] }); }, /weights/);
	assert.throws(function () { fitTransform("x", a); }, /from/);
	assert.throws(function () { fitTransform(a, a, null); }, /options/);
	assert.equal(lib.fitTransform, fitTransform);
});

test("largestEigen4", function () {
	var r = rng(9), v = new Float64Array(4);
	for (var t = 0; t < 200; t++) {
		var N = new Float64Array(16);
		for (var i = 0; i < 4; i++) for (var j = i; j < 4; j++) { var x = (r() - 0.5) * 10; N[i * 4 + j] = x; N[j * 4 + i] = x; }
		var lambda = largestEigen4(N, v);
		assert.ok(Math.abs(Math.hypot(v[0], v[1], v[2], v[3]) - 1) < 1e-12);
		for (i = 0; i < 4; i++) {
			var nv = 0;
			for (j = 0; j < 4; j++) nv += N[i * 4 + j] * v[j];
			assert.ok(Math.abs(nv - lambda * v[i]) < 1e-10, "N v = lambda v");
		}
		// Rayleigh quotient of random unit vectors never exceeds the largest eigenvalue
		for (var k = 0; k < 20; k++) {
			var u = [gauss(r), gauss(r), gauss(r), gauss(r)], un = Math.hypot(u[0], u[1], u[2], u[3]), q = 0;
			for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) q += u[i] * N[i * 4 + j] * u[j];
			assert.ok(q / (un * un) <= lambda + 1e-10);
		}
		var first = v[0] !== 0 ? v[0] : v[1] !== 0 ? v[1] : v[2] !== 0 ? v[2] : v[3];
		assert.ok(first > 0, "sign fixed");
	}
});

import { makeTransform } from "../../src/ops/transform.js";

function normDeg(d) { var a = ((d % 360) + 360) % 360; return a > 180 ? a - 360 : a; }

test("level recovers rotation about Z and a shift", function () {
	var r = rng(10);
	for (var trial = 0; trial < 100; trial++) {
		var n = [2, 5, 20][trial % 3], from = points(r, n, 100), theta = (r() - 0.5) * 720;
		var T = makeTransform({ rotateZ: theta, shift: [(r() - 0.5) * 1e4, (r() - 0.5) * 1e4, (r() - 0.5) * 100] });
		var f = fitTransform(from, applyT(T, from), { model: "level" });
		close(f.transform.m, T.m, 1e-9, "m");
		close(f.transform.t, T.t, 1e-8, "t");
		assert.ok(Math.abs(normDeg(f.rotateZ - normDeg(theta))) < 1e-9, "rotateZ " + f.rotateZ + " vs " + normDeg(theta));
		assert.ok(f.rotateZ > -180 && f.rotateZ <= 180);
		var m = f.transform.m;
		assert.ok(m[2] === 0 && m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1, "no tilt terms");
		assert.equal(f.scale, 1);
	}
});

test("level on tilted data stays level", function () {
	var r = rng(11), from = points(r, 10, 50);
	var tilt = quatMatrix(Math.cos(Math.PI / 72), Math.sin(Math.PI / 72), 0, 0);   // 5 degrees about x
	var f = fitTransform(from, applyT({ m: tilt, t: [0, 0, 0] }, from), { model: "level" });
	var m = f.transform.m;
	assert.ok(m[2] === 0 && m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1);
	assert.ok(f.dZ.some(function (v) { return Math.abs(v) > 0.1; }), "the misfit shows in dZ");
});

test("level degenerate", function () {
	assert.throws(function () { fitTransform([0, 0, 0], [0, 0, 0], { model: "level" }); }, /at least 2/);
	assert.throws(function () { fitTransform([5, 5, 0, 5, 5, 1, 5, 5, 2], [0, 0, 0, 0, 0, 1, 0, 0, 2], { model: "level" }); }, /XY/);
});

test("leave-one-out finds the bad pair", function () {
	var r = rng(12), from = points(r, 6, 50), T = { m: randomRotation(r), t: [3, 4, 5] }, to = applyT(T, from);
	to[3 * 3] += 0.5;
	var f = fitTransform(from, to);
	assert.equal(f.worst, 3);
	assert.ok(f.looResiduals.every(function (v) { return isFinite(v); }));
	// pair 3 far from a tight cluster and heavily weighted (a point the surveyor trusts): it drags
	// the fit onto itself, so its own residual is not the largest
	var lever = new Float64Array(18);
	for (var i = 0; i < 6; i++) for (var k = 0; k < 3; k++) lever[i * 3 + k] = (r() - 0.5) * 2;
	lever[9] = 100; lever[10] = 0; lever[11] = 0;
	var lt = applyT(T, lever); lt[10] += 0.5;
	var g = fitTransform(lever, lt, { weights: [1, 1, 1, 20, 1, 1] }), plainWorst = 0;
	for (i = 1; i < 6; i++) if (g.residuals[i] > g.residuals[plainWorst]) plainWorst = i;
	assert.notEqual(plainWorst, 3, "the case drags the fit (precondition)");
	assert.equal(g.worst, 3);
	assert.ok(Math.abs(g.looResiduals[3] - 0.5) < 1e-6);
});

test("leave-one-out at the minimum is NaN", function () {
	var r = rng(13), from = points(r, 3, 20), to = applyT({ m: randomRotation(r), t: [0, 0, 0] }, from);
	to[0] += 0.2;
	var f = fitTransform(from, to);
	assert.ok(f.looResiduals.every(function (v) { return v !== v; }));
	var plainWorst = 0;
	for (var i = 1; i < 3; i++) if (f.residuals[i] > f.residuals[plainWorst]) plainWorst = i;
	assert.equal(f.worst, plainWorst);
	var lv = fitTransform([0, 0, 0, 10, 0, 0], [0, 0, 0, 0, 10, 0], { model: "level" });
	assert.ok(lv.looResiduals.every(function (v) { return v !== v; }));
});

test("a refit that turns degenerate gives NaN for that pair", function () {
	var from = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 5, 0];   // three on the x axis, one off it
	var f = fitTransform(from, from.slice());
	assert.ok(f.looResiduals[3] !== f.looResiduals[3], "without pair 3 the rest are one line");
	for (var i = 0; i < 3; i++) assert.ok(isFinite(f.looResiduals[i]));
});
