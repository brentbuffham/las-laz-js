// test/fragments/watershed.test.js
//==========================================================
// findFragments' watershed: boxes of a synthetic pile come back as one
// fragment each (IoU >= 0.5, the rule the drawn rocks were scored by:
// the clip leaves a box's lower edges out by design), sized to their
// visible b; a valley keeps two boxes apart; a slab larger than the
// relief radius splits, and stays whole when reliefRadius is its size; a flat plane finds no
// rock; areas count only the cloud (an L-shaped one); the grid is
// bounded; a cloud seen side-on is warned of; facet-only options are
// named; UTM magnitude, re-runs, hard inputs and bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFragments } from "../../src/fragments/findFragments.js";
import { rockPile } from "../helpers/rocks.js";

var cache = {};
function pile() {
	if (!cache.pile) cache.pile = rockPile({ count: 60, swebrec: { x50: 0.5, xmax: 1, b: 2 }, extent: 6, spacing: 0.02, noise: 0.002, seed: 1, fines: "pebbles" });
	return cache.pile;
}
function ws(cols, extra) { return findFragments(cols, Object.assign({ method: "watershed" }, extra || {})); }
function codes(fr) { return fr.warnings.map(function (w) { return w.code; }); }
// boxes of visible b >= 10 spacings that are one fragment: the box and its fragment overlap with IoU >= 0.5
function whole(p, fr) {
	var n = p.truth.length, byBox = {}, byFrag = {};
	for (var i = 0; i < n; i++) {
		var t = p.truth[i], f = fr.fragment[i];
		if (t) { byBox[t] = byBox[t] || {}; byBox[t][f] = (byBox[t][f] || 0) + 1; }
		if (f) byFrag[f] = (byFrag[f] || 0) + 1;
	}
	var big = p.boxes.filter(function (b) { return b.visibleB >= 10 * 0.02; }), good = [];
	big.forEach(function (b) {
		var c = byBox[b.id] || {}, best = 0, bestN = 0;
		Object.keys(c).forEach(function (f) { if (Number(f) && c[f] > bestN) { bestN = c[f]; best = Number(f); } });
		if (best && bestN / (b.points + byFrag[best] - bestN) >= 0.5) good.push({ box: b, frag: fr.fragments[best - 1] });
	});
	return { share: good.length / big.length, good: good };
}
function cloud(pts) {
	var n = pts.length, x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
	pts.forEach(function (p, i) { x[i] = p[0]; y[i] = p[1]; z[i] = p[2]; });
	return { count: n, x: x, y: y, z: z };
}
function shift(cols, o) {
	var n = cols.count, x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
	for (var i = 0; i < n; i++) { x[i] = cols.x[i] + o[0]; y[i] = cols.y[i] + o[1]; z[i] = cols.z[i] + o[2]; }
	return { count: n, x: x, y: y, z: z };
}

test("boxes come back whole", function () {
	// flat-faced boxes are facet merging's best case (it finds all of them); the watershed, built for
	// rocks seen from above, finds 77 % at the defaults (measured), and leads on real rocks (README)
	var p = pile(), w = whole(p, ws(p.cols));
	assert.ok(w.share >= 0.7, "watershed " + w.share.toFixed(2));
	var ratio = w.good.map(function (g) { return g.frag.size / g.box.visibleB; }).sort(function (a, b) { return a - b; });
	var mid = ratio[Math.floor((ratio.length - 1) / 2)];
	assert.ok(mid >= 0.9 && mid <= 1.1, "median b / visible b " + mid);
});

test("two boxes with a valley are two; one box is one", function () {
	var vee = rockPile({ boxes: [{ centre: [1.5, 2], size: [1, 1, 0.6], yaw: 90, tilt: 10 }, { centre: [2.5, 2], size: [1, 1, 0.6], yaw: 90, tilt: -10 }], extent: 4, spacing: 0.02, noise: 0.002, seed: 1, fines: "pebbles" });
	var two = whole(vee, ws(vee.cols));
	assert.equal(two.good.length, 2);
	assert.notEqual(two.good[0].frag.id, two.good[1].frag.id);
	// a 1.5 x 1 m slab: wider than the default relief radius, its corners stand proud of the box mean and
	// seed apart; a relief radius of its size keeps it whole
	var slab = rockPile({ boxes: [{ centre: [2, 2], size: [1.5, 1, 0.8], yaw: 30, tilt: 0 }], extent: 4, spacing: 0.02, noise: 0.002, seed: 1, fines: "pebbles" });
	assert.equal(whole(slab, ws(slab.cols, { reliefRadius: 2 })).good.length, 1);
});

test("a flat plane finds no rock; a floor is named", function () {
	var pts = [], r = 0;
	for (var i = 0; i < 200; i++) for (var j = 0; j < 200; j++) { r = (r * 1103515245 + 12345) % 2147483648; pts.push([i * 0.02, j * 0.02, (r / 2147483648 - 0.5) * 0.004]); }
	var fr = ws(cloud(pts));
	assert.ok(fr.fragments.every(function (f) { return f.sheet; }), "every fragment of a plane is a sheet");
	var floor = rockPile({ boxes: [{ centre: [2, 2], size: [1, 1, 0.6], yaw: 20, tilt: 5 }], extent: 6, spacing: 0.02, noise: 0.002, seed: 1 });
	assert.ok(codes(ws(floor.cols)).indexOf("FLOOR") >= 0);
});

test("areas count only the cloud", function () {
	// an L: a 4 x 2 arm and a 2 x 4 arm sharing a 2 x 2 corner, 12 square metres
	var pts = [];
	for (var i = 0; i < 200; i++) for (var j = 0; j < 200; j++) { var x = i * 0.02, y = j * 0.02; if (x < 2 || y < 2) pts.push([x, y, 0.001 * ((i * 7 + j * 3) % 5)]); }
	var fr = ws(cloud(pts));
	assert.ok(Math.abs(fr.surfaceArea - 12) <= 0.05 * 12, "surfaceArea " + fr.surfaceArea);
});

test("the grid is bounded", function () {
	var pts = [];
	[[0, 0], [3000, 0], [0, 3000]].forEach(function (c) { for (var k = 0; k < 4; k++) pts.push([c[0] + 0.01 * k, c[1], 0]); });
	var t0 = Date.now();
	assert.throws(function () { ws(cloud(pts), { cell: 0.01 }); }, function (e) { return /cell/.test(e.message) && /crop/.test(e.message); });
	assert.ok(Date.now() - t0 < 1000);
});

test("side-on", function () {
	var p = pile(), n = p.cols.count, wall = { count: n, x: p.cols.x, y: p.cols.z, z: p.cols.y };
	assert.ok(codes(ws(wall)).indexOf("SIDE_ON") >= 0);
	assert.ok(codes(ws(p.cols)).indexOf("SIDE_ON") < 0);
});

test("facet options are named, not used", function () {
	var p = pile(), plain = ws(p.cols), more = ws(p.cols, { concaveAngle: 5, viewpoint: [0, 0, 9] });
	var w = more.warnings.filter(function (x) { return x.code === "IGNORED_OPTIONS"; });
	assert.equal(w.length, 1);
	assert.ok(/concaveAngle/.test(w[0].message) && /viewpoint/.test(w[0].message), w[0].message);
	assert.deepEqual(more.fragment, plain.fragment);
	assert.equal(plain.method, "watershed");
	assert.equal(plain.facets, null);
	assert.ok(Number.isNaN(plain.planeDistance));
	assert.ok(plain.cell > 0);
});

test("UTM magnitude", function () {
	var p = pile(), here = ws(p.cols, { cell: 0.03 }), utm = ws(shift(p.cols, [478000, 6771000, 240]), { cell: 0.03 });
	assert.deepEqual(utm.fragment, here.fragment);
});

test("the same run twice", function () {
	var p = pile(), a = ws(p.cols), b = ws(p.cols);
	assert.deepEqual(a.fragment, b.fragment);
	assert.deepEqual(a.fragments.map(function (f) { return [f.id, f.count, f.size]; }), b.fragments.map(function (f) { return [f.id, f.count, f.size]; }));
});

test("hard inputs", function () {
	var line = [];
	for (var i = 0; i < 50; i++) line.push([i * 0.02, 0, 0]);
	[cloud([]), cloud([[1, 2, 3]]), cloud(line)].forEach(function (c) {
		var fr = ws(c);
		assert.equal(fr.fragments.length, 0);
		assert.ok(!Number.isNaN(fr.surfaceArea) && !Number.isNaN(fr.unassignedArea));
	});
});

test("bad options", function () {
	var c = pile().cols;
	[0, -1].forEach(function (v) { assert.throws(function () { ws(c, { cell: v }); }, /cell/); });
	assert.throws(function () { ws(c, { cell: 0.03, reliefRadius: 0.05 }); }, /reliefRadius/);
	assert.throws(function () { ws(c, { seedHeight: 0 }); }, /seedHeight/);
	assert.throws(function () { ws(c, { clipBelow: 0.01 }); }, /clipBelow/);
	assert.throws(function () { ws(c, { minPoints: 2 }); }, /minPoints/);
});

// --- method "hybrid": the watershed, then facets on what it left ---------------------------------
function hy(cols, extra) { return findFragments(cols, Object.assign({ method: "hybrid" }, extra || {})); }

test("hybrid: the rest finds rocks the watershed left", function () {
	// a high seed height leaves some boxes unseeded, in the rest
	var p = pile(), alone = whole(p, ws(p.cols, { seedHeight: 0.05 })), both = whole(p, hy(p.cols, { seedHeight: 0.05 }));
	assert.ok(both.good.length > alone.good.length, "hybrid " + both.good.length + " against the watershed's " + alone.good.length);
});

test("hybrid: only rock-shaped pieces of the rest count", function () {
	var fr = hy(pile().cols, { seedHeight: 0.05 }), fromFacets = fr.fragments.filter(function (f) { return f.from === "facets"; });
	assert.ok(fromFacets.length > 0);
	fromFacets.forEach(function (f) { assert.ok(f.axes[2] / f.axes[1] >= 0.15, "fragment " + f.id + " c/b " + (f.axes[2] / f.axes[1])); });
});

test("hybrid: the bookkeeping adds up", function () {
	var p = pile(), fr = hy(p.cols), alone = ws(p.cols), n = p.cols.count;
	assert.equal(fr.method, "hybrid");
	assert.equal(fr.fromWatershed + fr.fromFacets, fr.fragments.length);
	assert.equal(fr.fromWatershed, alone.fragments.length);
	fr.fragments.forEach(function (f, i) { assert.equal(f.id, i + 1); if (i) assert.ok(fr.fragments[i - 1].size >= f.size); assert.ok(f.from === "watershed" || f.from === "facets"); });
	var count = new Map();
	for (var i = 0; i < n; i++) if (fr.fragment[i]) count.set(fr.fragment[i], (count.get(fr.fragment[i]) || 0) + 1);
	fr.fragments.forEach(function (f) { assert.equal(count.get(f.id), f.count, "fragment " + f.id + " count"); });
	// a watershed fragment of the hybrid is the same points as in the watershed alone
	var pair = new Map();
	for (i = 0; i < n; i++) {
		var h = fr.fragment[i], a = alone.fragment[i];
		if (h && fr.fragments[h - 1].from === "watershed") { if (!pair.has(h)) pair.set(h, a); assert.equal(pair.get(h), a, "point " + i); }
		if (a) assert.ok(h && fr.fragments[h - 1].from === "watershed", "point " + i + " of the watershed's fragment " + a);
	}
});

test("hybrid: areas count only the cloud", function () {
	var pts = [];
	for (var i = 0; i < 200; i++) for (var j = 0; j < 200; j++) { var x = i * 0.02, y = j * 0.02; if (x < 2 || y < 2) pts.push([x, y, 0.001 * ((i * 7 + j * 3) % 5)]); }
	var fr = hy(cloud(pts));
	assert.ok(Math.abs(fr.surfaceArea - 12) <= 0.05 * 12, "surfaceArea " + fr.surfaceArea);
});

test("hybrid: the same run twice", function () {
	var p = pile(), a = hy(p.cols), b = hy(p.cols);
	assert.deepEqual(a.fragment, b.fragment);
	assert.deepEqual(a.fragments.map(function (f) { return [f.id, f.count, f.from]; }), b.fragments.map(function (f) { return [f.id, f.count, f.from]; }));
});
