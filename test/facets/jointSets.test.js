// test/facets/jointSets.test.js
//==========================================================
// jointSets on poles drawn from Fisher distributions of known mean and
// concentration: automatic finds the sets (means, K), sub-vertical
// joints straddling the horizon stay one set, count and windows do what
// they say, area weighting, per-point sets, the statistics equal
// fisherStats of each set's members, bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { jointSets } from "../../src/facets/jointSets.js";
import { poleFromOrientation, angleBetweenAxes, fisherStats } from "../../src/facets/orientation.js";
import * as lib from "../../src/index.js";
import { rng } from "../helpers/clouds.js";

// n poles about mean (dip / dip direction) with concentration kappa; every other one negated
function fisherPoles(r, dip, dd, kappa, n) {
	var m = poleFromOrientation(dip, dd), e = Math.abs(m[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
	var u = [m[1] * e[2] - m[2] * e[1], m[2] * e[0] - m[0] * e[2], m[0] * e[1] - m[1] * e[0]], ul = Math.hypot(u[0], u[1], u[2]);
	u = [u[0] / ul, u[1] / ul, u[2] / ul];
	var v = [m[1] * u[2] - m[2] * u[1], m[2] * u[0] - m[0] * u[2], m[0] * u[1] - m[1] * u[0]], out = [];
	for (var i = 0; i < n; i++) {
		var w = r(), c = 1 + Math.log(w + (1 - w) * Math.exp(-2 * kappa)) / kappa, s = Math.sqrt(Math.max(0, 1 - c * c)), phi = 2 * Math.PI * r();
		var p = [0, 1, 2].map(function (k) { return c * m[k] + s * (Math.cos(phi) * u[k] + Math.sin(phi) * v[k]); });
		if (i % 2) p = p.map(function (x) { return -x; });
		out.push(p);
	}
	return out;
}
function facetsOf(poles, areas) { return poles.map(function (p, i) { return { normal: p, area: areas ? areas[i] : 1 }; }); }
// K 100-200 suits the default 15 degree window (about 2.5 x a set's spread, 1/sqrt(K)); 80 poles a
// set keep the K estimate's sampling spread near 11 %
var TRUTH = [[70, 135, 100], [40, 300, 150], [85, 30, 200]];
function threeSets(seed, truth, n) {
	var r = rng(seed), poles = [], which = [];
	(truth || TRUTH).forEach(function (t, s) { fisherPoles(r, t[0], t[1], t[2], n || 80).forEach(function (p) { poles.push(p); which.push(s); }); });
	return { facets: facetsOf(poles), which: which };
}

test("automatic finds three sets", function () {
	var d = threeSets(1), j = jointSets(d.facets);
	assert.equal(j.families.length, 3);
	TRUTH.forEach(function (t, s) {
		var m = poleFromOrientation(t[0], t[1]);
		var fam = j.families.filter(function (f) { return angleBetweenAxes(f.normal, m) < 2; });
		assert.equal(fam.length, 1, "set " + s + " found once, within 2 degrees");
		var K = fam[0].fisherK;
		assert.ok(Math.abs(K - t[2]) <= 0.25 * t[2], "K " + K + " vs " + t[2]);
		var mine = 0, total = 0;
		d.which.forEach(function (w, i) { if (w === s) { total++; if (j.family[i] === fam[0].id) mine++; } });
		assert.ok(mine >= 0.9 * total, "set " + s + ": " + mine + " of " + total);
	});
	for (var i = 1; i < j.families.length; i++) assert.ok(j.families[i - 1].area >= j.families[i].area);
	assert.equal(lib.jointSets, jointSets);
});

// a broad set (K 50, spread about 8 degrees) needs a wider window: maxAngle 25
test("a broad set with a wider window", function () {
	var d = threeSets(7, [[70, 135, 50]]), j = jointSets(d.facets, { maxAngle: 25 });
	assert.equal(j.families.length, 1);
	assert.ok(angleBetweenAxes(j.families[0].normal, poleFromOrientation(70, 135)) < 2.5, "mean");
	assert.ok(Math.abs(j.families[0].fisherK - 50) <= 0.3 * 50, "K " + j.families[0].fisherK);
	assert.ok(j.families[0].facets >= 76);
});

test("sub-vertical joints straddling the horizon are one set", function () {
	var r = rng(2), f = facetsOf(fisherPoles(r, 89, 45, 100, 60)), j = jointSets(f);
	assert.equal(j.families.length, 1);
	assert.ok(Math.abs(j.families[0].dip - 89) < 1, "dip " + j.families[0].dip);
	assert.ok(j.families[0].facets >= 54);
});

test("count", function () {
	var d = threeSets(3), two = jointSets(d.facets, { count: 2 });
	assert.equal(two.families.length, 2);
	assert.ok(Array.from(two.family).every(function (v) { return v > 0; }), "every facet in a set");
	assert.ok(jointSets(d.facets, { count: 5 }).families.length <= 3);
});

test("windows", function () {
	var d = threeSets(4), j = jointSets(d.facets, { windows: [{ dip: 70, dipDirection: 135, angle: 12 }, { dip: 40, dipDirection: 300, angle: 12 }] });
	assert.equal(j.families.length, 2);
	assert.ok(angleBetweenAxes(j.families[0].normal, poleFromOrientation(70, 135)) < 2);
	assert.ok(angleBetweenAxes(j.families[1].normal, poleFromOrientation(40, 300)) < 2);
	d.which.forEach(function (w, i) { if (w === 2) assert.equal(j.family[i], 0, "the 85/030 set is outside both windows"); });
});

test("area weighting", function () {
	var a = poleFromOrientation(30, 100), b = poleFromOrientation(40, 100);
	var j = jointSets([{ normal: a, area: 9 }, { normal: b, area: 1 }, { normal: a, area: 9 }], { minFacets: 2 });
	assert.equal(j.families.length, 1);
	assert.ok(angleBetweenAxes(j.families[0].normal, a) < 1.5, "the heavier pole pulls the mean");
});

test("pointFamily", function () {
	var j = jointSets([{ normal: [0, 0, 1], area: 1 }, { normal: [1, 0, 0], area: 1 }], { windows: [{ dip: 0, dipDirection: 0, angle: 5 }] });
	assert.deepEqual(Array.from(j.family), [1, 0]);
	assert.deepEqual(Array.from(j.pointFamily(Uint32Array.from([0, 1, 2, 1]))), [0, 1, 0, 1]);
});

test("Fisher statistics per set equal fisherStats of its members", function () {
	var d = threeSets(5), j = jointSets(d.facets);
	j.families.forEach(function (fam) {
		var poles = [], w = [];
		d.facets.forEach(function (f, i) { if (j.family[i] === fam.id) { poles.push(f.normal[0], f.normal[1], f.normal[2]); w.push(f.area); } });
		var s = fisherStats(Float64Array.from(poles), Float64Array.from(w));
		assert.ok(Math.abs(s.fisherK - fam.fisherK) <= 1e-12 * s.fisherK);
		assert.ok(Math.abs(s.cone95 - fam.cone95) <= 1e-12);
		assert.equal(fam.facets, s.N);
		var c = Math.abs(s.normal[0] * fam.normal[0] + s.normal[1] * fam.normal[1] + s.normal[2] * fam.normal[2]);
		assert.ok(c >= 1 - 1e-12, "same mean pole");
	});
});

test("no facets, no sets", function () {
	var j = jointSets([]);
	assert.equal(j.families.length, 0);
	assert.equal(j.family.length, 0);
});

test("bad options are refused", function () {
	var f = threeSets(6).facets;
	assert.throws(function () { jointSets(f, { count: 2, windows: [] }); }, /count.*windows|windows.*count/);
	assert.throws(function () { jointSets(f, { count: 0 }); }, /count/);
	assert.throws(function () { jointSets(f, { windows: [{ dip: 95, dipDirection: 0, angle: 10 }] }); }, /dip/);
	assert.throws(function () { jointSets(f, { windows: [{ dip: 45, dipDirection: 400, angle: 10 }] }); }, /dipDirection/);
	assert.throws(function () { jointSets(f, { windows: [{ dip: 45, dipDirection: 0, angle: 0 }] }); }, /angle/);
	assert.throws(function () { jointSets(f, { maxAngle: 0 }); }, /maxAngle/);
	assert.throws(function () { jointSets("x"); }, /facets/);
	assert.throws(function () { jointSets(f, null); }, /options/);
});

test("more than 2,000 facets: seeds are thinned, the sets still found", function () {
	var d = threeSets(8, [[70, 135, 150], [40, 300, 150]], 1300), j = jointSets(d.facets);
	assert.equal(j.families.length, 2);
	assert.ok(angleBetweenAxes(j.families[0].normal, poleFromOrientation(70, 135)) < 2 || angleBetweenAxes(j.families[0].normal, poleFromOrientation(40, 300)) < 2);
});

test("facets without an area weigh 1", function () {
	var j = jointSets([{ normal: [0, 0, 1] }, { normal: [0.01, 0, 1] }, { normal: [0, 0.01, 1] }]);
	assert.equal(j.families.length, 1);
	assert.equal(j.families[0].area, 3);
});

test("more bad input is refused", function () {
	assert.throws(function () { jointSets([{ normal: [0, 0] }]); }, /facets\[0\]/);
	assert.throws(function () { jointSets([{ normal: [0, 0, 0] }]); }, /facets\[0\]/);
	assert.throws(function () { jointSets([], { minFacets: 0 }); }, /minFacets/);
	assert.throws(function () { jointSets([], { windows: "70/135/12" }); }, /windows/);
});
