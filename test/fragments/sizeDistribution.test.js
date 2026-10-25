// test/fragments/sizeDistribution.test.js
//==========================================================
// sizeDistribution on fragment lists built by hand: the measured curve
// by volume, area and count (and with fines) against hand values;
// sizes at the quantiles of a known Swebrec and a known Rosin-Rammler
// come back through the fit; sizeAt / passingAt; P-values and their
// extrapolated flags; curves with too little in them; bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeDistribution } from "../../src/fragments/sizeDistribution.js";
import * as lib from "../../src/index.js";

function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || "") + " " + a + " vs " + b); }
function rel(a, b, share, msg) { assert.ok(Math.abs(a - b) <= share * Math.abs(b), (msg || "") + " " + a + " vs " + b); }

var HAND = [
	{ size: 1, axes: [2, 1, 1], area: 1 },
	{ size: 2, axes: [3, 2, 2], area: 1 },
	{ size: 3, axes: [4, 3, 3], area: 2 },
];

// sizes at the quantiles P = (i + 0.5) / N of a distribution, as fragments (count weighting)
function quantiles(N, inverse) {
	var out = [];
	for (var i = 0; i < N; i++) { var s = inverse((i + 0.5) / N); out.push({ size: s, axes: [s, s, s], area: s * s }); }
	return out;
}
function swebrecInverse(x50, xmax, b) { return function (P) { return xmax / Math.exp(Math.log(xmax / x50) * Math.pow(1 / P - 1, 1 / b)); }; }
function rosinInverse(x50, n) { return function (P) { return x50 * Math.pow(-Math.log(1 - P) / Math.LN2, 1 / n); }; }
var SWEBREC = quantiles(2000, swebrecInverse(0.4, 2.0, 2.2));

test("the measured curve by hand", function () {
	function curve(o) { return Array.from(sizeDistribution(HAND, o).passing); }
	var v = curve();
	[4, 28, 100].forEach(function (p, i) { near(v[i], p, 1e-9, "volume " + i); });
	var c = curve({ weight: "count" });
	[100 / 3, 200 / 3, 100].forEach(function (p, i) { near(c[i], p, 1e-9, "count " + i); });
	var a = curve({ weight: "area" });
	[25, 50, 100].forEach(function (p, i) { near(a[i], p, 1e-9, "area " + i); });
	var f = curve({ fines: 0.2 });
	[23.2, 42.4, 100].forEach(function (p, i) { near(f[i], p, 1e-9, "fines " + i); });
	assert.deepEqual(Array.from(sizeDistribution(HAND).size), [1, 2, 3]);
	var merged = sizeDistribution([HAND[0], HAND[0], HAND[1]], { weight: "count" });
	assert.deepEqual(Array.from(merged.size), [1, 2]);
	near(merged.passing[0], 200 / 3, 1e-9, "merged");
	assert.equal(merged.passing[1], 100);
});

test("Swebrec comes back", function () {
	var d = sizeDistribution(SWEBREC, { weight: "count" });
	assert.equal(d.fit.model, "swebrec");
	rel(d.fit.x50, 0.4, 0.03, "x50");
	rel(d.fit.b, 2.2, 0.1, "b");
	assert.ok(d.fit.xmax > d.size[d.size.length - 1], "xmax above the largest");
	assert.ok(d.fit.rmse < 1, "rmse " + d.fit.rmse);
	assert.equal(d.fit.from, 60);
	assert.ok(d.fit.range[0] > 0 && d.fit.range[0] < d.fit.range[1]);
	near(d.fit.passing(d.fit.sizeAt(30)), 30, 1e-9, "inverse");
});

test("Rosin-Rammler comes back", function () {
	var d = sizeDistribution(quantiles(2000, rosinInverse(0.4, 1.3)), { weight: "count", model: "rosin-rammler" });
	assert.equal(d.fit.model, "rosin-rammler");
	rel(d.fit.x50, 0.4, 0.03, "x50");
	rel(d.fit.n, 1.3, 0.1, "n");
	near(d.fit.passing(d.fit.sizeAt(30)), 30, 1e-9, "inverse");
});

test("sizeAt and passingAt", function () {
	var d = sizeDistribution(HAND, { weight: "count" });
	near(d.sizeAt(50), Math.exp((50 - 100 / 3) / (100 / 3) * Math.LN2), 1e-12, "log-linear");
	near(d.sizeAt(100 / 3), 1, 1e-12, "at a point");
	assert.equal(d.sizeAt(100), 3);
	near(d.passingAt(2), 200 / 3, 1e-9, "at a point");
	assert.equal(d.passingAt(10), 100);
	// three fragments leave one point in the fit range, so no fit and nothing below the curve
	assert.equal(d.fit, null);
	assert.ok(Number.isNaN(d.passingAt(0.5)));
	assert.ok(Number.isNaN(d.sizeAt(10)));
});

test("p values and extrapolated flags", function () {
	var d = sizeDistribution(SWEBREC, { weight: "count" });
	assert.deepEqual(Object.keys(d.p).map(Number).sort(function (a, b) { return a - b; }), [10, 20, 50, 80, 90]);
	assert.equal(d.p[80].extrapolated, false);
	assert.equal(d.p[80].size, d.sizeAt(80));
	var f = sizeDistribution(SWEBREC, { weight: "count", fines: 0.4 });
	assert.ok(f.passing[0] > 40, "the curve's foot at 40");
	assert.equal(f.p[10].extrapolated, true);
	assert.equal(f.p[10].size, f.fit.sizeAt(10));
	assert.ok(f.p[10].size > 0 && f.p[10].size < f.p[20].size);
	assert.equal(f.p[50].extrapolated, false);
	var own = sizeDistribution(SWEBREC, { weight: "count", percents: [25, 75] });
	assert.deepEqual(Object.keys(own.p).sort(), ["25", "75"]);
});

test("too little to fit", function () {
	var one = sizeDistribution([HAND[0]]);
	assert.deepEqual(Array.from(one.passing), [100]);
	assert.equal(one.fit, null);
	assert.ok(Number.isNaN(one.sizeAt(50)));
	assert.equal(one.sizeAt(100), 1);
	var same = sizeDistribution([HAND[0], HAND[0], HAND[0], HAND[0], HAND[0]]);
	assert.equal(same.size.length, 1);
	assert.equal(same.fit, null);
	var few = sizeDistribution(SWEBREC.slice(0, 4), { weight: "count" });
	assert.equal(few.fit, null);
	var none = sizeDistribution([]);
	assert.equal(none.size.length, 0);
	assert.equal(none.passing.length, 0);
	assert.equal(none.fit, null);
	[10, 20, 50, 80, 90].forEach(function (P) { assert.ok(Number.isNaN(none.p[P].size)); });
	assert.ok(Number.isNaN(none.sizeAt(50)) && Number.isNaN(none.passingAt(1)));
	// a fragment with no measurable size (a line of points) is left out, not an error
	var flat = sizeDistribution([{ size: 0, axes: [1, 0, 0], area: 0 }, HAND[1]]);
	assert.deepEqual(Array.from(flat.size), [2]);
});

test("bad options are refused, naming them", function () {
	assert.throws(function () { sizeDistribution("x"); }, /fragments/);
	assert.throws(function () { sizeDistribution([{ size: NaN, axes: [1, 1, 1], area: 1 }]); }, /fragments/);
	assert.throws(function () { sizeDistribution([{ size: 1 }]); }, /fragments/);   // volume needs axes
	assert.throws(function () { sizeDistribution([{ size: 1, axes: [1, 1, 1] }], { weight: "area" }); }, /fragments/);
	assert.throws(function () { sizeDistribution(HAND, { model: "kuz-ram" }); }, /model/);
	assert.throws(function () { sizeDistribution(HAND, { weight: "mass" }); }, /weight/);
	assert.throws(function () { sizeDistribution(HAND, { fitFrom: 100 }); }, /fitFrom/);
	assert.throws(function () { sizeDistribution(HAND, { fines: 1 }); }, /fines/);
	assert.throws(function () { sizeDistribution(HAND, { percents: [0] }); }, /percents/);
	assert.throws(function () { sizeDistribution(HAND, "x"); }, /options/);
	try { sizeDistribution(HAND, { model: "x" }); } catch (e) { assert.equal(e.code, lib.ERROR_CODES.INVALID_ARGUMENT); }
});

test("exports", function () {
	assert.equal(lib.sizeDistribution, sizeDistribution);
});

test("edge paths", function () {
	assert.throws(function () { sizeDistribution(HAND, null); }, /options/);
	assert.throws(function () { sizeDistribution([null]); }, /fragments\[0\]/);
	assert.throws(function () { sizeDistribution([{ size: 1, axes: [1, 1] }]); }, /axes/);
	var d = sizeDistribution(SWEBREC, { weight: "count" }), r = sizeDistribution(quantiles(500, rosinInverse(0.4, 1.3)), { weight: "count", model: "rosin-rammler" });
	assert.ok(Number.isNaN(d.sizeAt(NaN)) && Number.isNaN(d.passingAt(NaN)));
	// below the measured curve, the fit
	var f40 = sizeDistribution(SWEBREC, { weight: "count", fines: 0.4 }), below = f40.size[0] / 2;
	assert.equal(f40.passingAt(below), f40.fit.passing(below));
	// the fitted curves at and beyond their ends
	assert.equal(d.fit.passing(0), 0);
	assert.equal(d.fit.passing(d.fit.xmax * 2), 100);
	assert.equal(d.fit.sizeAt(0), 0);
	assert.equal(d.fit.sizeAt(100), d.fit.xmax);
	assert.equal(r.fit.passing(-1), 0);
	assert.equal(r.fit.sizeAt(0), 0);
	assert.equal(r.fit.sizeAt(100), Infinity);
	// weight none at all: every size passes everything
	var zero = sizeDistribution([{ size: 1, area: 0 }, { size: 2, area: 0 }], { weight: "area" });
	assert.deepEqual(Array.from(zero.passing), [100, 100]);
	// a fragment of no weight between two: a flat step, read as its lower size
	var flat = sizeDistribution([{ size: 1, area: 1 }, { size: 2, area: 0 }, { size: 3, area: 1 }], { weight: "area" });
	assert.deepEqual(Array.from(flat.passing), [50, 50, 100]);
	assert.equal(flat.sizeAt(50), 1);
	assert.ok(Math.abs(flat.passingAt(1.5) - 50) < 1e-12);
});
