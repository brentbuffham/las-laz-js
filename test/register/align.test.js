// test/register/align.test.js
//==========================================================
// alignCloud on a synthetic bench (a floor, a 70 degree face rising
// 15 m to a crest, an upper floor; the face waves along strike so every
// shift is pinned), sampled twice with different seeds and noise, the
// moving copy moved by a known transform: picks only equals
// fitTransform; ICP from three sloppy picks reaches the noise level;
// partial overlap; level and scale keep their constraints; local Float32
// columns about UTM origins; clouds that do not overlap; progress; bad
// options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alignCloud } from "../../src/register/align.js";
import { fitTransform } from "../../src/register/fit.js";
import * as lib from "../../src/index.js";
import { rng } from "../helpers/clouds.js";

var SIGMA = 0.005, TAN70 = Math.tan(70 * Math.PI / 180);
function gauss(r) { var u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function crestX(y) { return 25 + 3 * Math.sin(y / 8); }
function benchZ(x, y) { var x0 = crestX(y), dx = x - x0; return dx <= 0 ? 0 : Math.min(15, dx * TAN70); }

// About n points on the bench, x 0-60, y 0-40: uniform in plan plus extra on the steep face so
// the face is as dense as the floors, isotropic noise
function bench(seed, n) {
	var r = rng(seed), x = [], y = [], z = [];
	for (var i = 0; i < n; i++) {
		var px, py, pz;
		if (i % 4 === 0) {   // a quarter on the face, spread over its height
			py = r() * 40; pz = r() * 15; px = crestX(py) + pz / TAN70;
		} else { px = r() * 60; py = r() * 40; pz = benchZ(px, py); }
		x.push(px + SIGMA * gauss(r)); y.push(py + SIGMA * gauss(r)); z.push(pz + SIGMA * gauss(r));
	}
	return { count: n, x: Float64Array.from(x), y: Float64Array.from(y), z: Float64Array.from(z) };
}

function rotation(axis, deg) {
	var n = Math.hypot(axis[0], axis[1], axis[2]), kx = axis[0] / n, ky = axis[1] / n, kz = axis[2] / n;
	var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), v = 1 - c;
	return [c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
		ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
		kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v];
}
function apply(T, x, y, z) {
	var m = T.m, t = T.t;
	return [m[0] * x + m[1] * y + m[2] * z + t[0], m[3] * x + m[4] * y + m[5] * z + t[1], m[6] * x + m[7] * y + m[8] * z + t[2]];
}
function inverse(T) {   // of a rigid (or scaled rigid) transform: m^-1 = m^T / s^2
	var m = T.m, s2 = m[0] * m[0] + m[3] * m[3] + m[6] * m[6];
	var mi = [m[0] / s2, m[3] / s2, m[6] / s2, m[1] / s2, m[4] / s2, m[7] / s2, m[2] / s2, m[5] / s2, m[8] / s2];
	var t = T.t;
	return { m: mi, t: [-(mi[0] * t[0] + mi[1] * t[1] + mi[2] * t[2]), -(mi[3] * t[0] + mi[4] * t[1] + mi[5] * t[2]), -(mi[6] * t[0] + mi[7] * t[1] + mi[8] * t[2])] };
}
function moveCloud(c, T) {
	var out = { count: c.count, x: new Float64Array(c.count), y: new Float64Array(c.count), z: new Float64Array(c.count) };
	for (var i = 0; i < c.count; i++) { var p = apply(T, c.x[i], c.y[i], c.z[i]); out.x[i] = p[0]; out.y[i] = p[1]; out.z[i] = p[2]; }
	return out;
}
// Angle (degrees) between two rotations, and the distance between where they put a point
function angleBetween(a, b) {
	var tr = 0;
	for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) tr += a.m[i * 3 + j] * b.m[i * 3 + j];
	var s = Math.cbrt(Math.abs(det(a.m))) * Math.cbrt(Math.abs(det(b.m)));
	return Math.acos(Math.max(-1, Math.min(1, (tr / s - 1) / 2))) * 180 / Math.PI;
}
function det(m) { return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]); }
function gap(a, b, p) { var u = apply(a, p[0], p[1], p[2]), v = apply(b, p[0], p[1], p[2]); return Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]); }

// The truth (moving -> fixed), the moving cloud, and three picks with 5 cm errors on the moving side
var FIXED = bench(1, 120000), SURFACE2 = bench(2, 120000);
function setup(truth, seed, crop) {
	var src = crop ? keep(SURFACE2, crop) : SURFACE2;
	var moving = moveCloud(src, inverse(truth)), r = rng(seed);
	var targets = [[10, 10, 0], [crestX(20) + 7.5 / TAN70, 20, 7.5], [crestX(30) + 15 / TAN70 + 1, 30, 15]];
	var from = [], to = [];
	targets.forEach(function (p) {
		var q = apply(inverse(truth), p[0], p[1], p[2]);
		from.push(q[0] + 0.05 * gauss(r), q[1] + 0.05 * gauss(r), q[2] + 0.05 * gauss(r));
		to.push(p[0], p[1], p[2]);
	});
	return { moving: moving, pairs: { from: from, to: to }, centre: apply(inverse(truth), 30, 20, 7.5) };
}
function keep(c, f) {
	var x = [], y = [], z = [];
	for (var i = 0; i < c.count; i++) if (f(c.x[i], c.y[i])) { x.push(c.x[i]); y.push(c.y[i]); z.push(c.z[i]); }
	return { count: x.length, x: Float64Array.from(x), y: Float64Array.from(y), z: Float64Array.from(z) };
}
var TRUTH = { m: rotation([0.3, -0.5, 0.8], 1.7), t: [0.31, -0.22, 0.12] };

test("picks only equals fitTransform", function () {
	var s = setup(TRUTH, 3);
	var a = alignCloud(s.moving, FIXED, { pairs: s.pairs });
	assert.deepEqual(a.transform, fitTransform(s.pairs.from, s.pairs.to).transform);
	assert.equal(a.icp, undefined);
	assert.equal(lib.alignCloud, alignCloud);
});

test("ICP from three sloppy picks reaches the noise", function () {
	var s = setup(TRUTH, 4);
	var a = alignCloud(s.moving, FIXED, { pairs: s.pairs, icp: { maxDistance: 0.5 } });
	assert.ok(angleBetween(a.fit.transform, TRUTH) > 0.02, "the picks alone are off (precondition)");
	assert.ok(angleBetween(a.transform, TRUTH) < 0.02, "rotation within 0.02 degrees: " + angleBetween(a.transform, TRUTH));
	assert.ok(gap(a.transform, TRUTH, s.centre) < 0.005, "within 5 mm at the centre: " + gap(a.transform, TRUTH, s.centre));
	assert.equal(a.icp.converged, true);
	assert.ok(a.icp.rmsAfter < 2 * SIGMA, "rmsAfter " + a.icp.rmsAfter);
	assert.ok(a.icp.rmsAfter < a.icp.rmsBefore);
	assert.ok(a.icp.used > 0.9 * a.icp.sampled && a.icp.sampled === 50000);
});

test("60 % overlap still converges", function () {
	var s = setup(TRUTH, 5, function (x) { return x < 36; });
	var a = alignCloud(s.moving, FIXED, { pairs: s.pairs, icp: { maxDistance: 0.5 } });
	assert.equal(a.icp.converged, true);
	assert.ok(angleBetween(a.transform, TRUTH) < 0.02);
	assert.ok(gap(a.transform, TRUTH, s.centre) < 0.005);
});

test("level ICP stays level", function () {
	var truth = { m: rotation([0, 0, 1], 2.5), t: [0.4, -0.3, 0.1] };
	var s = setup(truth, 6);
	var a = alignCloud(s.moving, FIXED, { pairs: s.pairs, model: "level", icp: { maxDistance: 0.5 } });
	var m = a.transform.m;
	assert.ok(m[2] === 0 && m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1, "no tilt terms");
	assert.ok(angleBetween(a.transform, truth) < 0.02);
	assert.ok(gap(a.transform, truth, s.centre) < 0.005);
});

test("scale keeps the picks' scale", function () {
	var s = setup(TRUTH, 7);
	var a = alignCloud(s.moving, FIXED, { pairs: s.pairs, model: "scale", icp: { maxDistance: 0.5 } });
	assert.ok(Math.abs(Math.cbrt(det(a.transform.m)) - a.fit.scale) < 1e-12);
});

test("origins: local Float32 columns give the same world transform", function () {
	var s = setup(TRUTH, 8), U = [478000, 6772000, 300], M = [12, -7, 3];
	var world = function (c, o) { var out = { count: c.count, x: new Float64Array(c.count), y: new Float64Array(c.count), z: new Float64Array(c.count) }; for (var i = 0; i < c.count; i++) { out.x[i] = c.x[i] + o[0]; out.y[i] = c.y[i] + o[1]; out.z[i] = c.z[i] + o[2]; } return out; };
	var f32 = function (c) { return { count: c.count, x: Float32Array.from(c.x), y: Float32Array.from(c.y), z: Float32Array.from(c.z) }; };
	var shiftPairs = function (p) { var to = p.to.map(function (v, i) { return v + U[i % 3]; }), from = p.from.map(function (v, i) { return v + M[i % 3]; }); return { from: from, to: to }; };
	var pairs = shiftPairs(s.pairs);
	// Float64 world columns (moving about M, fixed about U), origins 0
	var a = alignCloud(world(s.moving, M), world(FIXED, U), { pairs: pairs, icp: { maxDistance: 0.5 } });
	// Float32 local columns with their origins
	var b = alignCloud(f32(s.moving), f32(FIXED), { pairs: pairs, movingOrigin: M, fixedOrigin: U, icp: { maxDistance: 0.5 } });
	var corners = [[0, 0, 0], [60, 0, 0], [0, 40, 15], [60, 40, 15]].map(function (p) { return [p[0] + M[0], p[1] + M[1], p[2] + M[2]]; });
	corners.forEach(function (p) { assert.ok(gap(a.transform, b.transform, p) < 1e-4, "Float32 local vs Float64 world: " + gap(a.transform, b.transform, p)); });
	var truthW = { m: TRUTH.m, t: [0, 1, 2].map(function (k) { return TRUTH.t[k] + U[k] - (TRUTH.m[k * 3] * M[0] + TRUTH.m[k * 3 + 1] * M[1] + TRUTH.m[k * 3 + 2] * M[2]); }) };
	assert.ok(gap(b.transform, truthW, [s.centre[0] + M[0], s.centre[1] + M[1], s.centre[2] + M[2]]) < 0.005);
});

// The pairing distance is not the normal's neighbourhood: on a cloud sparser than maxDistance
// (a drone survey, points metres apart) every fixed point still gets a plane from its k nearest
test("a sparse cloud: normals from the k nearest, whatever maxDistance is", function () {
	var sparse = keep(FIXED, function (x, y) { return true; });
	var thin = { count: 0, x: [], y: [], z: [] };
	for (var i = 0; i < sparse.count; i += 60) { thin.x.push(sparse.x[i]); thin.y.push(sparse.y[i]); thin.z.push(sparse.z[i]); }
	thin = { count: thin.x.length, x: Float64Array.from(thin.x), y: Float64Array.from(thin.y), z: Float64Array.from(thin.z) };   // ~2,000 points, ~1 m apart
	var a = alignCloud(thin, thin, { pairs: { from: [10, 10, 0, 40, 10, 15, 30, 35, 15], to: [10, 10, 0, 40, 10, 15, 30, 35, 15] }, icp: { maxDistance: 0.2 } });
	assert.ok(a.icp.used > 0.95 * a.icp.sampled, "used " + a.icp.used + " of " + a.icp.sampled);
});

test("clouds that do not overlap", function () {
	var s = setup(TRUTH, 9), far = { from: s.pairs.from, to: s.pairs.to.map(function (v, i) { return i % 3 === 0 ? v + 50 : v; }) };
	var a = alignCloud(s.moving, FIXED, { pairs: far, icp: { maxDistance: 0.5 } });
	assert.equal(a.icp.used, 0);
	assert.equal(a.icp.converged, false);
	assert.deepEqual(a.transform, a.fit.transform);
	assert.ok(a.icp.rmsBefore !== a.icp.rmsBefore && a.icp.rmsAfter !== a.icp.rmsAfter);
	a.transform.m.concat(a.transform.t).forEach(function (v) { assert.ok(isFinite(v)); });
});

test("onProgress", function () {
	var s = setup(TRUTH, 10), calls = [];
	var a = alignCloud(s.moving, FIXED, { pairs: s.pairs, icp: { maxDistance: 0.5, iterations: 5 }, onProgress: function (d, t) { calls.push([d, t]); } });
	assert.ok(calls.length >= 1);
	assert.deepEqual(calls[calls.length - 1], [a.icp.iterations, a.icp.iterations]);
	assert.ok(a.icp.iterations <= 5);
});

test("bad options are refused", function () {
	var s = setup(TRUTH, 11);
	assert.throws(function () { alignCloud(s.moving, FIXED, {}); }, /pairs/);
	assert.throws(function () { alignCloud(s.moving, FIXED); }, /pairs/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, icp: {} }); }, /maxDistance is required/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, movingOrigin: [1, 2] }); }, /movingOrigin/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, fixedOrigin: [1, 2, NaN] }); }, /fixedOrigin/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, icp: { maxDistance: 0.5, iterations: 0 } }); }, /iterations/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, icp: { maxDistance: 0.5, sample: 1.5 } }); }, /sample/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, icp: { maxDistance: 0.5, k: 2 } }); }, /k/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, icp: { maxDistance: 0.5 }, onProgress: 3 }); }, /onProgress/);
});

// A plain floor cannot pin the in-plane shift or the rotation about its normal: ICP must still
// return a finite transform (the ridge keeps the system solvable), and keep the floor in place
test("a flat floor: ICP stays finite and keeps the floor", function () {
	var floor = keep(FIXED, function (x, y) { return benchZ(x, y) === 0; });
	var a = alignCloud(floor, floor, { pairs: { from: [5, 5, 0, 20, 5, 0, 10, 30, 0], to: [5, 5, 0.01, 20, 5, 0.01, 10, 30, 0.01] }, icp: { maxDistance: 0.5 } });
	a.transform.m.concat(a.transform.t).forEach(function (v) { assert.ok(isFinite(v)); });
	assert.ok(Math.abs(apply(a.transform, 10, 10, 0)[2]) < 0.002, "the floor stays at z 0 (the picks said 1 cm up)");
});

// A scanned blasthole: a line of points has no plane, so those reference points give no normal and
// are skipped; the rest still align
test("reference points on a line give no normal and are skipped", function () {
	var s = setup(TRUTH, 12), line = { count: FIXED.count + 400, x: new Float64Array(FIXED.count + 400), y: new Float64Array(FIXED.count + 400), z: new Float64Array(FIXED.count + 400) };
	line.x.set(FIXED.x); line.y.set(FIXED.y); line.z.set(FIXED.z);
	for (var i = 0; i < 400; i++) { line.x[FIXED.count + i] = 70; line.y[FIXED.count + i] = 20; line.z[FIXED.count + i] = i * 0.01; }
	var mv = { count: s.moving.count + 50, x: new Float64Array(s.moving.count + 50), y: new Float64Array(s.moving.count + 50), z: new Float64Array(s.moving.count + 50) };
	mv.x.set(s.moving.x); mv.y.set(s.moving.y); mv.z.set(s.moving.z);
	for (i = 0; i < 50; i++) { var q = apply(inverse(TRUTH), 70, 20, i * 0.08); mv.x[s.moving.count + i] = q[0]; mv.y[s.moving.count + i] = q[1]; mv.z[s.moving.count + i] = q[2]; }
	var a = alignCloud(mv, line, { pairs: s.pairs, icp: { maxDistance: 0.5, sample: mv.count } });
	assert.ok(a.icp.used < a.icp.sampled, "the line's points were skipped");
	assert.ok(gap(a.transform, TRUTH, s.centre) < 0.005);
});

test("more bad options", function () {
	var s = setup(TRUTH, 13);
	assert.throws(function () { alignCloud(s.moving, FIXED, null); }, /options/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, movingOrigin: "0,0,0" }); }, /movingOrigin/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, icp: "yes" }); }, /icp must be/);
	assert.throws(function () { alignCloud(s.moving, FIXED, { pairs: s.pairs, model: "affine" }); }, /model/);
});
