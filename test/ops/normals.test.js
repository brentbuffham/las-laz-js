// test/ops/normals.test.js
//==========================================================
// The 3 × 3 eigen solver on matrices with known answers; pointNormals
// on noise-free planes at many tilts (exact normals, zero residual),
// on Gaussian noise of known sigma (residual ≈ sigma), at UTM
// magnitude, in both layouts, and with too few or coincident
// neighbours; estimateNoise as the median residual of a spread sample.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { smallestEigen, pointNormals, estimateNoise } from "../../src/ops/normals.js";
import { thinSelection } from "../../src/ops/select.js";
import * as lib from "../../src/index.js";
import { rng } from "../helpers/clouds.js";

function gauss(r) { var u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// side × side points `step` apart on the plane through `origin` spanned by e1, e2, offset along nrm by noise
function plane(side, step, e1, e2, nrm, opts) {
	opts = opts || {};
	var n = side * side, T = opts.float32 ? Float32Array : Float64Array, o = opts.origin || [0, 0, 0], r = rng(opts.seed || 1);
	var c = { count: n, x: new T(n), y: new T(n), z: new T(n) };
	for (var i = 0; i < n; i++) {
		var u = (i % side) * step, v = Math.floor(i / side) * step, h = opts.noise ? opts.noise * gauss(r) : 0;
		c.x[i] = o[0] + u * e1[0] + v * e2[0] + h * nrm[0];
		c.y[i] = o[1] + u * e1[1] + v * e2[1] + h * nrm[1];
		c.z[i] = o[2] + u * e1[2] + v * e2[2] + h * nrm[2];
	}
	return c;
}
function tilted(deg, opts) {
	var t = deg * Math.PI / 180;
	return plane(40, 0.05, [Math.cos(t), 0, -Math.sin(t)], [0, 1, 0], [Math.sin(t), 0, Math.cos(t)], opts);
}
function interior(i, side, margin) { var u = i % side, v = Math.floor(i / side); return u >= margin && v >= margin && u < side - margin && v < side - margin; }
function lowerMedian(a) { var s = Float64Array.from(a.filter(function (v) { return v === v; })).sort(); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; }

test("pointNormals and estimateNoise are exported from the package", function () {
	assert.equal(lib.pointNormals, pointNormals);
	assert.equal(lib.estimateNoise, estimateNoise);
});

test("smallestEigen matches known matrices", function () {
	var out = new Float64Array(4);
	assert.ok(smallestEigen(new Float64Array([3, 0, 0, 1, 0, 2]), out));
	assert.deepEqual(Array.from(out), [0, 1, 0, 1]);
	// R · diag(5, 4, 0.01) · Rᵀ, R a rotation by 30° about x then 40° about z
	var a = 30 * Math.PI / 180, b = 40 * Math.PI / 180;
	var Rx = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
	var Rz = [[Math.cos(b), -Math.sin(b), 0], [Math.sin(b), Math.cos(b), 0], [0, 0, 1]];
	var R = [0, 1, 2].map(function (i) { return [0, 1, 2].map(function (j) { return Rz[i][0] * Rx[0][j] + Rz[i][1] * Rx[1][j] + Rz[i][2] * Rx[2][j]; }); });
	var L = [5, 4, 0.01], M = [0, 1, 2].map(function (i) { return [0, 1, 2].map(function (j) { return R[i][0] * L[0] * R[j][0] + R[i][1] * L[1] * R[j][1] + R[i][2] * L[2] * R[j][2]; }); });
	assert.ok(smallestEigen(new Float64Array([M[0][0], M[0][1], M[0][2], M[1][1], M[1][2], M[2][2]]), out));
	var want = [R[0][2], R[1][2], R[2][2]];
	if (want[2] < 0) want = want.map(function (v) { return -v; });
	for (var i = 0; i < 3; i++) assert.ok(Math.abs(out[i] - want[i]) < 1e-12, "axis " + i + ": " + out[i] + " vs " + want[i]);
	assert.ok(Math.abs(out[3] - 0.01) < 1e-12);
	// a line along (1, 1, 0): a unit normal perpendicular to it, the same every call
	var line = new Float64Array([0.5, 0.5, 0, 0.5, 0, 0]);
	assert.ok(smallestEigen(line, out));
	var first = Array.from(out);
	assert.ok(Math.abs(out[0] + out[1]) < 1e-12 || Math.abs(out[0] * 1 + out[1] * 1) < 1e-12);
	assert.ok(Math.abs(Math.hypot(out[0], out[1], out[2]) - 1) < 1e-12);
	smallestEigen(line, out);
	assert.deepEqual(Array.from(out), first);
	assert.equal(smallestEigen(new Float64Array(6), out), false);
	assert.deepEqual(Array.from(out.subarray(0, 3)), [0, 0, 0]);
	assert.ok(Number.isNaN(out[3]));
});

test("noise-free planes give their exact normal and zero residual", function () {
	var cases = [0, 30, 45, 89, 90].map(function (d) {
		var t = d * Math.PI / 180, nrm = [Math.sin(t), 0, Math.cos(t)];
		return { label: d + "°", cols: tilted(d), want: nrm };
	});
	// vertical, facing -y: the sign rule gives +y
	cases.push({ label: "-y wall", cols: plane(40, 0.05, [1, 0, 0], [0, 0, 1], [0, -1, 0]), want: [0, 1, 0] });
	cases.forEach(function (cs) {
		var res = pointNormals(cs.cols, { maxDistance: 0.3 });
		assert.ok(res.normal instanceof Float32Array && res.residual instanceof Float32Array);
		for (var i = 0; i < cs.cols.count; i++) {
			if (!interior(i, 40, 3)) continue;
			for (var a = 0; a < 3; a++) assert.ok(Math.abs(res.normal[3 * i + a] - cs.want[a]) < 1e-7, cs.label + " point " + i + " axis " + a + ": " + res.normal[3 * i + a]);
			assert.ok(res.residual[i] < 1e-7, cs.label + " residual " + res.residual[i]);
		}
	});
});

test("residual measures Gaussian noise", function () {
	var c = plane(100, 0.05, [1, 0, 0], [0, 1, 0], [0, 0, 1], { noise: 0.02, seed: 3 });
	var res = pointNormals(c, { maxDistance: 0.3 });
	var med = lowerMedian(Array.from(res.residual));
	// The residual is the RMS about the fitted plane, which absorbs 3 of the 17 points'
	// degrees of freedom (median of sqrt(chi²₁₄ / 17) ≈ 0.89), and neighbours chosen by 3D
	// distance favour points at similar heights: measured 0.82 σ (2026-10-22)
	assert.ok(Math.abs(med / 0.02 - 0.82) < 0.05, "median residual " + med);
});

test("fewer than 3 neighbours, or only coincident ones: zero normal, NaN residual", function () {
	var c = { count: 3, x: new Float64Array([0, 1, 2]), y: new Float64Array(3), z: new Float64Array(3) };
	var res = pointNormals(c, { maxDistance: 0.5 });
	assert.deepEqual(Array.from(res.normal), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
	assert.ok(Array.from(res.residual).every(Number.isNaN));
	var same = { count: 20, x: new Float64Array(20).fill(1), y: new Float64Array(20).fill(2), z: new Float64Array(20).fill(3) };
	res = pointNormals(same, { maxDistance: 0.5 });
	assert.ok(Array.from(res.normal).every(function (v) { return v === 0; }));
	assert.ok(Array.from(res.residual).every(Number.isNaN));
});

test("a plane at UTM magnitude gives the origin plane's normals", function () {
	var a = pointNormals(tilted(45, { noise: 0.01, seed: 5 }), { maxDistance: 0.3 });
	var b = pointNormals(tilted(45, { noise: 0.01, seed: 5, origin: [478000, 6772000, 300] }), { maxDistance: 0.3 });
	for (var i = 0; i < a.normal.length; i++) assert.ok(Math.abs(a.normal[i] - b.normal[i]) < 1e-6, "normal " + i);
	for (i = 0; i < a.residual.length; i++) assert.ok(Math.abs(a.residual[i] - b.residual[i]) < 1e-6, "residual " + i);
});

test("positions and Float32 give the x / y / z answer", function () {
	var c = tilted(30, { noise: 0.01, seed: 6 }), f = tilted(30, { noise: 0.01, seed: 6, float32: true });
	var pos = new Float64Array(3 * c.count);
	for (var i = 0; i < c.count; i++) { pos[3 * i] = c.x[i]; pos[3 * i + 1] = c.y[i]; pos[3 * i + 2] = c.z[i]; }
	var a = pointNormals(c, { maxDistance: 0.3 }), p = pointNormals({ count: c.count, positions: pos }, { maxDistance: 0.3 }), g = pointNormals(f, { maxDistance: 0.3 });
	assert.deepEqual(Array.from(p.normal), Array.from(a.normal));
	// Float32 rounding can swap which point is the 16th nearest on a lattice, which changes
	// that point's fit: nearly every normal agrees closely, every one roughly
	var close = 0;
	for (i = 0; i < c.count; i++) {
		var e = Math.max(Math.abs(g.normal[3 * i] - a.normal[3 * i]), Math.abs(g.normal[3 * i + 1] - a.normal[3 * i + 1]), Math.abs(g.normal[3 * i + 2] - a.normal[3 * i + 2]));
		if (e < 1e-5) close++;
		assert.ok(e < 0.2, "f32 normal " + i + " differs by " + e);
	}
	assert.ok(close >= 0.97 * c.count, close + " of " + c.count + " within 1e-5");
});

test("estimateNoise is the median residual over a spread sample", function () {
	var c = plane(60, 0.05, [1, 0, 0], [0, 1, 0], [0, 0, 1], { noise: 0.02, seed: 7 });
	var res = pointNormals(c, { maxDistance: 0.3 }), sel = thinSelection(c.count, 100000);
	var want = lowerMedian(Array.from(sel, function (i) { return res.residual[i]; }));
	assert.equal(estimateNoise(c, { maxDistance: 0.3 }), want);
	var sparse = { count: 3, x: new Float64Array([0, 1, 2]), y: new Float64Array(3), z: new Float64Array(3) };
	assert.ok(Number.isNaN(estimateNoise(sparse, { maxDistance: 0.5 })));
	assert.ok(Number.isNaN(estimateNoise({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }, { maxDistance: 0.5 })));
});

test("onProgress ends at the point count", function () {
	var last = null;
	pointNormals(tilted(0), { maxDistance: 0.3, onProgress: function (d, t) { last = [d, t]; } });
	assert.deepEqual(last, [1600, 1600]);
});

test("bad arguments are refused, naming the argument", function () {
	var c = tilted(0);
	assert.throws(function () { pointNormals(c); }, { code: "INVALID_ARGUMENT", message: /maxDistance is required/ });
	assert.throws(function () { pointNormals(c, { maxDistance: 0.3, k: 0 }); }, { code: "INVALID_ARGUMENT", message: /k/ });
	assert.throws(function () { estimateNoise(c, {}); }, { code: "INVALID_ARGUMENT", message: /maxDistance is required/ });
	assert.throws(function () { estimateNoise(c, { maxDistance: 0.3, k: 2.5 }); }, { message: /k/ });
	assert.throws(function () { pointNormals(c, { maxDistance: 0.3, onProgress: 1 }); }, { message: /onProgress/ });
});
