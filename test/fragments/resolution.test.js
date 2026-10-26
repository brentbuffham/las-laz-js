// test/fragments/resolution.test.js
//==========================================================
// What a cloud can resolve: resolution tiers by spacing; findFragments'
// spacing, floor (30 spacings), resolution and warnings on synthetic
// piles at 0.012 / 0.02 / 0.04 / 0.06; maxDistance from the spacing and
// the warning when it is far off; sheets flagged and warned of; the
// floor named; the method option.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFragments } from "../../src/fragments/findFragments.js";
import { resolutionOf, resultFields } from "../../src/fragments/resolution.js";
import { rockPile } from "../helpers/rocks.js";

var cache = {};
function pile(spacing, extent) {
	var key = spacing + "/" + extent;
	if (!cache[key]) cache[key] = rockPile({ count: 20, swebrec: { x50: 0.5, xmax: 1.5, b: 2 }, extent: extent || 4, spacing: spacing, noise: 0.002, seed: 1, fines: "pebbles" });
	return cache[key];
}
function codes(fr) { return fr.warnings.map(function (w) { return w.code; }); }
function flatFloor() { return rockPile({ boxes: [{ centre: [2, 2], size: [1, 1, 0.6], yaw: 20, tilt: 5 }], extent: 6, spacing: 0.02, noise: 0.002, seed: 1 }); }

test("resolution tiers", function () {
	assert.deepEqual([0.01, 0.017, 0.018, 0.035, 0.036, 0.05, 0.051].map(resolutionOf), ["fine", "fine", "coarse", "coarse", "oversize", "oversize", "unresolved"]);
});

test("warnings by spacing", function () {
	var c = findFragments(pile(0.02).cols, { maxDistance: 0.08 });
	assert.equal(c.resolution, "coarse");
	var w = c.warnings.filter(function (x) { return x.code === "COARSE"; });
	assert.equal(w.length, 1);
	assert.ok(w[0].message.indexOf(String(Number(c.spacing.toPrecision(3)))) >= 0 && w[0].message.indexOf((30 * c.spacing).toFixed(2)) >= 0, w[0].message);
	assert.ok(Math.abs(c.floor - 30 * c.spacing) <= 1e-12);
	var o = findFragments(pile(0.04).cols, { maxDistance: 0.16 });
	assert.equal(o.resolution, "oversize"); assert.ok(codes(o).indexOf("OVERSIZE_ONLY") >= 0);
	var u = findFragments(pile(0.06).cols, { maxDistance: 0.24 });
	assert.equal(u.resolution, "unresolved"); assert.ok(codes(u).indexOf("UNRESOLVED") >= 0);
	var f = findFragments(pile(0.012, 3).cols, { maxDistance: 0.05 });
	assert.equal(f.resolution, "fine");
	assert.ok(codes(f).every(function (x) { return ["COARSE", "OVERSIZE_ONLY", "UNRESOLVED"].indexOf(x) < 0; }), codes(f).join());
	[o, u, f].forEach(function (r) { assert.ok(Math.abs(r.floor - 30 * r.spacing) <= 1e-12); });
});

test("maxDistance from the spacing", function () {
	var cols = pile(0.02).cols, auto = findFragments(cols, {});
	assert.ok(auto.spacing > 0.015 && auto.spacing < 0.025, "spacing " + auto.spacing);
	var given = findFragments(cols, { maxDistance: 4 * auto.spacing });
	assert.deepEqual(auto.fragment, given.fragment);
	var far = findFragments(cols, { maxDistance: 0.8 }), m = far.warnings.filter(function (x) { return x.code === "MAX_DISTANCE"; });
	assert.equal(m.length, 1);
	assert.ok(m[0].message.indexOf("0.8") >= 0 && m[0].message.indexOf(String(Number(far.spacing.toPrecision(3)))) >= 0, m[0].message);
	assert.ok(codes(findFragments(cols, { maxDistance: 4 * auto.spacing })).indexOf("MAX_DISTANCE") < 0);
	assert.ok(codes(auto).indexOf("MAX_DISTANCE") < 0);
});

test("too few points and no maxDistance", function () {
	var five = { count: 5, x: new Float64Array([0, 1, 2, 3, 4]), y: new Float64Array(5), z: new Float64Array(5) };
	assert.throws(function () { findFragments(five, {}); }, /maxDistance is needed/);
	var r = findFragments(five, { maxDistance: 0.1 });
	assert.equal(r.fragments.length, 0);
	assert.ok(Number.isNaN(r.spacing));
});

test("sheets", function () {
	var field = rockPile({ boxes: [], extent: 5, spacing: 0.02, noise: 0.002, seed: 3, fines: "pebbles" });
	var fr = findFragments(field.cols, { maxDistance: 0.08 });
	assert.ok(fr.fragments.length > 0);
	fr.fragments.forEach(function (f) { assert.equal(f.sheet, f.axes[2] / f.axes[1] < 0.15, "fragment " + f.id); });
	// the boxes of the pile are not sheets
	var p = pile(0.02), pr = findFragments(p.cols, { maxDistance: 0.08 }), byBox = {};
	for (var i = 0; i < p.truth.length; i++) if (p.truth[i] && pr.fragment[i]) { var key = p.truth[i] + ":" + pr.fragment[i]; byBox[key] = (byBox[key] || 0) + 1; }
	p.boxes.forEach(function (b) {
		Object.keys(byBox).forEach(function (key) {
			var parts = key.split(":");
			if (Number(parts[0]) === b.id && byBox[key] >= 0.9 * b.points) assert.equal(pr.fragments[Number(parts[1]) - 1].sheet, false, "box " + b.id);
		});
	});
	// a flat floor is a sheet over most of the surface
	var floor = findFragments(flatFloor().cols, { maxDistance: 0.08 }), s = floor.warnings.filter(function (x) { return x.code === "SHEETS"; });
	assert.equal(s.length, 1);
	assert.ok(/\d+% of the surface is flat patches/.test(s[0].message), s[0].message);
});

test("the floor is named", function () {
	var fr = findFragments(flatFloor().cols, { maxDistance: 0.08 }), big = fr.fragments.reduce(function (a, f) { return f.area > a.area ? f : a; });
	var w = fr.warnings.filter(function (x) { return x.code === "FLOOR"; });
	assert.equal(w.length, 1);
	assert.ok(w[0].message.indexOf("Fragment " + big.id + " ") >= 0, w[0].message);
});

test("method", function () {
	var cols = pile(0.02).cols;
	assert.throws(function () { findFragments(cols, { maxDistance: 0.08, method: "kuz-ram" }); }, /method/);
	var a = findFragments(cols, { maxDistance: 0.08, method: "facets" }), b = findFragments(cols, { maxDistance: 0.08 });
	assert.deepEqual(a.fragment, b.fragment);
	assert.equal(a.method, "facets"); assert.equal(b.method, "facets");
});

test("resultFields edges", function () {
	// a fragment with no measurable b is a sheet; no spacing, no resolution and no resolution warning
	var fr = resultFields({ fragments: [{ id: 1, axes: [1, 0, 0], area: 1 }, { id: 2, axes: [1, 0.8, 0.5], area: 1 }], surfaceArea: 0, unassignedArea: 0 }, NaN, {});
	assert.equal(fr.fragments[0].sheet, true); assert.equal(fr.fragments[1].sheet, false);
	assert.equal(fr.resolution, null); assert.equal(resolutionOf(NaN), null);
	assert.deepEqual(fr.warnings.map(function (w) { return w.code; }), ["SHEETS"]);
	// maxDistance given with no spacing to judge it by: no warning
	assert.equal(resultFields({ fragments: [], surfaceArea: 0, unassignedArea: 0 }, NaN, { maxDistance: 9 }).warnings.length, 0);
});
