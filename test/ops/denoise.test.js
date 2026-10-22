// test/ops/denoise.test.js
//==========================================================
// denoisePoints on synthetic surfaces with a known truth (noise σ 2 cm,
// maxDistance 0.3): how much the error drops on a plane, how sharp a
// bench crest stays (bilateral against mls), a cone's shape; and the
// rules — points move along their normals, points with too few
// neighbours keep their coordinates, coincident points stay finite,
// zero noise moves nothing, the result does not depend on point order,
// UTM magnitude, layouts and types, inPlace, normals, progress, errors.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { denoisePoints } from "../../src/ops/denoise.js";
import * as lib from "../../src/index.js";
import { rng } from "../helpers/clouds.js";
import { surface } from "../helpers/surfaces.js";

var OPT = { maxDistance: 0.3 };
function rms(s, cols, sel) {
	var t = 0, m = 0;
	for (var i = 0; i < cols.count; i++) { if (sel && !sel(i)) continue; var e = s.error(i, cols); t += e * e; m++; }
	return Math.sqrt(t / m);
}
function meanErr(s, cols, sel) {
	var t = 0, m = 0;
	for (var i = 0; i < cols.count; i++) { if (sel && !sel(i)) continue; t += s.error(i, cols); m++; }
	return t / m;
}
function opts(extra) { return Object.assign({}, OPT, extra); }

var plane = surface("plane", { seed: 11 });
var smoothB = denoisePoints(plane.cols, OPT), smoothM = denoisePoints(plane.cols, opts({ method: "mls" }));

test("denoisePoints is exported from the package", function () {
	assert.equal(lib.denoisePoints, denoisePoints);
});

test("both methods cut a plane's 2 cm scatter to under 1 cm", function () {
	// measured 2026-10-22 at k 16: bilateral 2.45 times (0.0199 → 0.0081), mls 2.76 times;
	// k 32 gives 3.1 and 4.2 times
	var before = rms(plane, plane.cols), b = rms(plane, smoothB), m = rms(plane, smoothM);
	assert.ok(before / b >= 2 && b < 0.01, "bilateral: " + before.toFixed(4) + " → " + b.toFixed(4));
	assert.ok(before / m >= 2.2 && m < 0.01, "mls: " + before.toFixed(4) + " → " + m.toFixed(4));
});

test("bilateral keeps a crest sharper than mls", function () {
	// Within a few cm of an edge neither method can tell the edge from 2 cm noise, so both
	// round it a little; measured 2026-10-22 near the edge: noisy, bilateral 0.0103 and mls
	// 0.0119 (0.0160 before); noise-free with sigma 0.02 (rounding alone), 0.0085 and 0.0101
	[{ noise: 0.02, seed: 12, ratio: 1 }, { noise: 0, ratio: 0.9 }].forEach(function (cs) {
		var s = surface("crest", cs), o = opts({ sigma: cs.noise ? undefined : 0.02 });
		var b = denoisePoints(s.cols, o), m = denoisePoints(s.cols, Object.assign({}, o, { method: "mls" }));
		// points that started within 0.1 of the edge line (x = 0, z = 0)
		function nearEdge(i) { return Math.hypot(s.cols.x[i], s.cols.z[i]) < 0.1; }
		var eb = meanErr(s, b, nearEdge), em = meanErr(s, m, nearEdge);
		assert.ok(eb < cs.ratio * em, "noise " + cs.noise + ", near the edge: bilateral " + eb.toFixed(4) + ", mls " + em.toFixed(4));
		if (cs.noise) assert.ok(eb < meanErr(s, s.cols, nearEdge), "the edge is cleaner than before");
	});
});

test("a cone keeps its shape", function () {
	// the apex: bilateral keeps it (measured 3.007), mls's plane fit rounds it (2.941)
	var s = surface("cone", { seed: 13 }), before = meanErr(s, s.cols), apex = { bilateral: 0.02, mls: 0.08 };
	["bilateral", "mls"].forEach(function (method) {
		var out = denoisePoints(s.cols, opts({ method: method }));
		assert.ok(meanErr(s, out) < before, method + ": " + before.toFixed(4) + " → " + meanErr(s, out).toFixed(4));
		var top = -Infinity;
		for (var i = 0; i < out.count; i++) if (out.z[i] > top) top = out.z[i];
		assert.ok(Math.abs(top - 3) < apex[method], method + ": apex at " + top.toFixed(4));
	});
});

test("a straight line of points is unchanged", function () {
	var n = 100, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = i * 0.05; c.y[i] = i * 0.03; c.z[i] = 1; }
	["bilateral", "mls"].forEach(function (method) {
		var out = denoisePoints(c, { maxDistance: 0.3, sigma: 0.02, method: method });
		assert.deepEqual(Array.from(out.x), Array.from(c.x), method);
		assert.deepEqual(Array.from(out.y), Array.from(c.y), method);
		assert.deepEqual(Array.from(out.z), Array.from(c.z), method);
	});
});

test("points move along their normals: an edge does not shrink", function () {
	var dxy = 0, dz = 0;
	for (var i = 0; i < plane.cols.count; i++) {
		dxy += Math.hypot(smoothB.x[i] - plane.cols.x[i], smoothB.y[i] - plane.cols.y[i]);
		dz += Math.abs(smoothB.z[i] - plane.cols.z[i]);
	}
	assert.ok(dxy < 0.2 * dz, "mean |Δxy| " + (dxy / plane.cols.count) + ", mean |Δz| " + (dz / plane.cols.count));
});

test("too few neighbours: the point keeps its coordinates exactly", function () {
	var p = surface("plane", { seed: 14, side: 2 }).cols, n = p.count + 3;
	var c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	c.x.set(p.x); c.y.set(p.y); c.z.set(p.z);
	[[0.3, 0.3, 2], [1, 1, 2.5], [1.7, 0.2, 3]].forEach(function (q, j) { c.x[p.count + j] = q[0]; c.y[p.count + j] = q[1]; c.z[p.count + j] = q[2]; });
	var out = denoisePoints(c, OPT);
	for (var i = p.count; i < n; i++) assert.deepEqual([out.x[i], out.y[i], out.z[i]], [c.x[i], c.y[i], c.z[i]]);
	var four = { count: 4, x: new Float64Array([0, 1, 0, 1]), y: new Float64Array([0, 0, 1, 1]), z: new Float64Array(4) };
	var o4 = denoisePoints(four, { maxDistance: 2, sigma: 0.1 });
	assert.deepEqual(Array.from(o4.z), [0, 0, 0, 0]);
});

test("coincident points stay finite", function () {
	var p = surface("plane", { seed: 15, side: 2 }).cols, n = p.count + 30;
	var c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	c.x.set(p.x); c.y.set(p.y); c.z.set(p.z);
	for (var j = p.count; j < n; j++) { c.x[j] = 1; c.y[j] = 1; c.z[j] = 0.01; }
	["bilateral", "mls"].forEach(function (method) {
		var out = denoisePoints(c, opts({ method: method }));
		for (var i = 0; i < n; i++) assert.ok(isFinite(out.x[i]) && isFinite(out.y[i]) && isFinite(out.z[i]), method + " point " + i);
	});
});

test("measured noise 0 or NaN moves nothing", function () {
	var flat = surface("plane", { noise: 0, side: 2 }).cols;
	var out = denoisePoints(flat, OPT);
	assert.deepEqual(Array.from(out.z), Array.from(flat.z));
	var sparse = { count: 5, x: new Float64Array([0, 1, 2, 3, 4]), y: new Float64Array(5), z: new Float64Array([0, 0.1, 0, 0.1, 0]) };
	assert.deepEqual(Array.from(denoisePoints(sparse, OPT).z), Array.from(sparse.z));
});

test("the result does not depend on point order", function () {
	var c = surface("plane", { seed: 16, side: 3 }).cols, n = c.count, r = rng(5), perm = new Uint32Array(n);
	for (var i = 0; i < n; i++) perm[i] = i;
	for (i = n - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
	var s = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (i = 0; i < n; i++) { s.x[i] = c.x[perm[i]]; s.y[i] = c.y[perm[i]]; s.z[i] = c.z[perm[i]]; }
	// an explicit sigma: the measured one samples points by number
	["bilateral", "mls"].forEach(function (method) {
		var a = denoisePoints(c, opts({ sigma: 0.02, method: method })), b = denoisePoints(s, opts({ sigma: 0.02, method: method }));
		for (var i = 0; i < n; i++) assert.deepEqual([b.x[i], b.y[i], b.z[i]], [a.x[perm[i]], a.y[perm[i]], a.z[perm[i]]], method + " point " + i);
	});
});

test("UTM offset gives the origin's moves", function () {
	var a = surface("plane", { seed: 17, side: 3 }), b = surface("plane", { seed: 17, side: 3, offset: [478000, 6772000, 300] });
	var oa = denoisePoints(a.cols, OPT), ob = denoisePoints(b.cols, OPT);
	for (var i = 0; i < oa.count; i++) {
		assert.ok(Math.abs((ob.x[i] - b.cols.x[i]) - (oa.x[i] - a.cols.x[i])) < 1e-6, "x " + i);
		assert.ok(Math.abs((ob.z[i] - b.cols.z[i]) - (oa.z[i] - a.cols.z[i])) < 1e-6, "z " + i);
	}
});

test("layouts and types", function () {
	var c = surface("plane", { seed: 18, side: 2 }).cols, n = c.count;
	c.intensity = new Uint16Array(n).fill(7);
	var x0 = Float64Array.from(c.x), z0 = Float64Array.from(c.z);
	var out = denoisePoints(c, opts({ sigma: 0.02 }));
	assert.equal(out.count, n);
	assert.equal(out.intensity, c.intensity);
	assert.ok(out.x instanceof Float64Array && out.x !== c.x);
	assert.deepEqual(Array.from(c.x), Array.from(x0));
	assert.deepEqual(Array.from(c.z), Array.from(z0));
	// positions, Float64 and Float32
	var pos = new Float64Array(3 * n), pos32 = new Float32Array(3 * n);
	for (var i = 0; i < n; i++) { pos[3 * i] = c.x[i]; pos[3 * i + 1] = c.y[i]; pos[3 * i + 2] = c.z[i]; pos32[3 * i] = c.x[i]; pos32[3 * i + 1] = c.y[i]; pos32[3 * i + 2] = c.z[i]; }
	var op = denoisePoints({ count: n, positions: pos, rgb: new Uint8Array(3 * n) }, opts({ sigma: 0.02 }));
	assert.ok(op.positions instanceof Float64Array && op.positions !== pos);
	assert.equal(op.rgb.length, 3 * n);
	for (i = 0; i < n; i++) assert.deepEqual([op.positions[3 * i], op.positions[3 * i + 1], op.positions[3 * i + 2]], [out.x[i], out.y[i], out.z[i]]);
	var o32 = denoisePoints({ count: n, positions: pos32 }, opts({ sigma: 0.02 }));
	assert.ok(o32.positions instanceof Float32Array);
	var f = { count: n, x: Float32Array.from(c.x), y: Float32Array.from(c.y), z: Float32Array.from(c.z) };
	assert.ok(denoisePoints(f, opts({ sigma: 0.02 })).z instanceof Float32Array);
	// inPlace: the input's arrays, holding the copy's values
	var ip = denoisePoints(c, opts({ sigma: 0.02, inPlace: true }));
	assert.equal(ip.x, c.x);
	assert.equal(ip.z, c.z);
	assert.deepEqual(Array.from(c.z), Array.from(out.z));
});

test("normals: true adds a normal column", function () {
	var out = denoisePoints(plane.cols, opts({ normals: true }));
	assert.ok(out.normal instanceof Float32Array);
	assert.equal(out.normal.length, 3 * plane.cols.count);
	for (var i = 0; i < plane.cols.count; i++) {
		var len = Math.hypot(out.normal[3 * i], out.normal[3 * i + 1], out.normal[3 * i + 2]);
		assert.ok(Math.abs(len - 1) < 1e-6 || len === 0, "normal " + i + " length " + len);
	}
	assert.equal(smoothB.normal, undefined);
});

test("sigma given overrides the measurement; iterations 2 smooth more than 1", function () {
	var tiny = denoisePoints(plane.cols, opts({ sigma: 1e-6 }));
	assert.ok(rms(plane, tiny) > rms(plane, smoothB), "a tiny sigma barely smooths");
	var two = denoisePoints(plane.cols, opts({ iterations: 2 }));
	assert.ok(rms(plane, two) < rms(plane, smoothB), "2 passes: " + rms(plane, two) + " vs 1: " + rms(plane, smoothB));
});

test("onProgress totals points × iterations", function () {
	var c = surface("plane", { seed: 19, side: 1 }).cols, last = null;
	denoisePoints(c, opts({ iterations: 2, onProgress: function (d, t) { last = [d, t]; } }));
	assert.deepEqual(last, [2 * c.count, 2 * c.count]);
});

test("bad arguments are refused, naming the argument", function () {
	var c = surface("plane", { seed: 20, side: 1 }).cols;
	assert.throws(function () { denoisePoints(c, opts({ method: "fft" })); }, { code: "INVALID_ARGUMENT", message: /method/ });
	[0, 1.5, "2"].forEach(function (v) { assert.throws(function () { denoisePoints(c, opts({ iterations: v })); }, { code: "INVALID_ARGUMENT", message: /iterations/ }); });
	[0, -1, NaN, "0.02"].forEach(function (v) { assert.throws(function () { denoisePoints(c, opts({ sigma: v })); }, { code: "INVALID_ARGUMENT", message: /sigma/ }); });
	assert.throws(function () { denoisePoints(c, {}); }, { code: "INVALID_ARGUMENT", message: /maxDistance is required/ });
	assert.throws(function () { denoisePoints(c, opts({ k: 0 })); }, { message: /k/ });
	assert.throws(function () { denoisePoints(c, opts({ onProgress: "x" })); }, { message: /onProgress/ });
});
