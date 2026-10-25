// test/fragments/findFragments.test.js
//==========================================================
// findFragments on synthetic piles of known boxes on pebbly fines
// (test/helpers/rocks.js): the boxes come back box for box at scanner
// and SLAM-like noise, and their P50 / P80; touching boxes stay two (a step, a valley), a
// bevelled box is one, an edge-on face neither splits nor bridges, a
// flat floor is one fragment, pebbles do not chain into one; a pile
// turned 90 degrees with a viewpoint is the same, Float32 at a UTM
// origin equals Float64, dust stays out, runs repeat, the fill never
// spreads; hard inputs, progress, speed and bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFragments, convexVote } from "../../src/fragments/findFragments.js";
import * as lib from "../../src/index.js";
import { pointNormals } from "../../src/ops/normals.js";
import { rockPile } from "../helpers/rocks.js";
import { buildKdTree, kdNearest } from "../../src/index/kdtree.js";
import { sizeDistribution } from "../../src/fragments/sizeDistribution.js";
import { fragmentAxes } from "../../src/fragments/axes.js";

var COVERAGE = !!process.env.NODE_V8_COVERAGE;
var PILE = { count: 150, swebrec: { x50: 0.5, xmax: 2, b: 2 }, extent: 12, spacing: 0.02, noise: 0.005, seed: 1, fines: "pebbles" };
var MD = 0.06;
var cache = {};
function run(key, pileOpts, opts) {
	if (!cache[key]) { var p = rockPile(pileOpts); cache[key] = { pile: p, fr: findFragments(p.cols, Object.assign({ maxDistance: MD }, opts || {})) }; }
	return cache[key];
}
// for each box: the fragment holding most of its points, that share, and the fragment's purity
function matchBoxes(pile, fr) {
	var n = pile.truth.length, byBox = {}, byFrag = {};
	for (var i = 0; i < n; i++) {
		var t = pile.truth[i], f = fr.fragment[i];
		if (t) { byBox[t] = byBox[t] || {}; byBox[t][f] = (byBox[t][f] || 0) + 1; }
		if (f) byFrag[f] = (byFrag[f] || 0) + 1;
	}
	return pile.boxes.map(function (b) {
		var c = byBox[b.id] || {}, best = 0, bestN = 0;
		Object.keys(c).forEach(function (f) { if (f !== "0" && c[f] > bestN) { best = Number(f); bestN = c[f]; } });
		return { box: b, fragment: best, share: bestN / b.points, purity: best ? bestN / byFrag[best] : 0 };
	});
}
function cloudOf(pts) {
	var n = pts.length / 3, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = pts[3 * i]; c.y[i] = pts[3 * i + 1]; c.z[i] = pts[3 * i + 2]; }
	return c;
}
function noNaN(fr) {
	fr.fragments.forEach(function (f) {
		[].concat(f.axes, f.centroid, f.normal, [f.area, f.size]).forEach(function (v) { assert.ok(Number.isFinite(v), "fragment " + f.id + " has " + v); });
	});
}

test("convexVote by hand", function () {
	var cosFlat = Math.cos(10 * Math.PI / 180);
	assert.equal(convexVote([0, 0, 1], [1, 0, 0], [0.9, 0, 1], [1, 0, 0.9], cosFlat, 0.01), true);
	assert.equal(convexVote([1, 0, 0], [-1, 0, 0], [0, 0, 0], [0.1, 0, 0], cosFlat, 0.01), false);
	var a = [0, 0, 1], b = [Math.sin(5 * Math.PI / 180), 0, Math.cos(5 * Math.PI / 180)];
	assert.equal(convexVote(a, b, [0, 0, 0], [0.05, 0, 0], cosFlat, 0.01), true, "flat and on one plane");
	assert.equal(convexVote(a, a, [0, 0, 0.04], [0.05, 0, 0], cosFlat, 0.01), false, "flat but a step");
});

function checkPile(r, label, spacing, share) {
	var m = matchBoxes(r.pile, r.fr), big = m.filter(function (x) { return x.box.visibleB >= 10 * spacing; }), good = 0;
	big.forEach(function (x) {
		var f = x.fragment && r.fr.fragments[x.fragment - 1];
		if (x.share >= 0.9 && x.purity >= 0.8 && f && Math.abs(f.size - x.box.visibleB) <= 0.1 * x.box.visibleB) good++;
	});
	assert.ok(good >= share * big.length, label + ": " + good + " of " + big.length + " boxes come back");
	// the area in no fragment is about the surface's share of points at 0 (the density is even)
	var zero = 0;
	for (var i = 0; i < r.fr.fragment.length; i++) if (!r.fr.fragment[i]) zero++;
	var want = r.fr.surfaceArea * zero / r.fr.fragment.length;
	assert.ok(Math.abs(r.fr.unassignedArea - want) <= 0.15 * want, label + ": unassigned " + r.fr.unassignedArea + " vs " + want);
	assert.ok(r.fr.surfaceArea > r.fr.unassignedArea);
	var all = r.pile.cols.count * spacing * spacing;
	assert.ok(r.fr.surfaceArea > 0.8 * all && r.fr.surfaceArea < 1.5 * all, label + ": surface " + r.fr.surfaceArea + " vs " + all);
	for (var k = 1; k < r.fr.fragments.length; k++) assert.ok(r.fr.fragments[k - 1].size >= r.fr.fragments[k].size, "ids by size");
	r.fr.fragments.forEach(function (f, j) { assert.equal(f.id, j + 1); assert.ok(f.facets.length >= 1 && f.outline instanceof Float64Array); });
	noNaN(r.fr);
}

test("a pile comes back box for box", function () {
	checkPile(run("pile", PILE), "noise 5 mm", 0.02, 0.9);
	assert.equal(lib.findFragments, findFragments);
});

test("P50 and P80 of the pile match its visible boxes", function () {
	// the pile below the surface is a bias of every scan, not the algorithm's: the truth is the boxes as seen
	var r = run("pile", PILE), lists = {};
	for (var i = 0; i < r.pile.truth.length; i++) if (r.pile.truth[i]) (lists[r.pile.truth[i]] = lists[r.pile.truth[i]] || []).push(i);
	var seen = r.pile.boxes.map(function (b) { var ax = fragmentAxes(r.pile.cols.x, r.pile.cols.y, r.pile.cols.z, 1, Uint32Array.from(lists[b.id])); return { size: ax.axes[1], axes: ax.axes, area: 1 }; });
	var truth = sizeDistribution(seen), measured = sizeDistribution(r.fr.fragments);
	[50, 80].forEach(function (P) {
		var t = truth.sizeAt(P), m = measured.sizeAt(P);
		assert.ok(Math.abs(m - t) <= 0.1 * t, "P" + P + ": " + m + " vs " + t);
	});
});

test("a pile comes back box for box at SLAM-like noise", function () {
	// noise half the point spacing: faces split more and the share drops (README)
	checkPile(run("slam", Object.assign({}, PILE, { noise: 0.02, spacing: 0.04 }), { maxDistance: 0.15 }), "noise 2 cm", 0.04, 0.65);
});

// each given box: its best fragment holds >= 90 % of it, and no two boxes share one
function apartAndWhole(pile, fr, label) {
	var m = matchBoxes(pile, fr), used = {};
	m.forEach(function (x) {
		assert.ok(x.share >= 0.9, label + ": box " + x.box.id + " share " + x.share);
		assert.ok(!used[x.fragment], label + ": boxes share fragment " + x.fragment);
		used[x.fragment] = 1;
	});
	return m;
}

test("two boxes touching are two", function () {
	// a step: tops 0.04 apart, parallel
	var step = rockPile({ boxes: [{ centre: [1.5, 2], size: [1, 1, 0.6], yaw: 0, tilt: 0 }, { centre: [2.5, 2], size: [1, 1, 0.56], yaw: 0, tilt: 0 }], extent: 4, spacing: 0.02, noise: 0.002, seed: 1, fines: "pebbles" });
	apartAndWhole(step, findFragments(step.cols, { maxDistance: MD }), "a step");
	// a valley: tops tilted 10 degrees toward each other
	var vee = rockPile({ boxes: [{ centre: [1.5, 2], size: [1, 1, 0.6], yaw: 90, tilt: 10 }, { centre: [2.5, 2], size: [1, 1, 0.6], yaw: 90, tilt: -10 }], extent: 4, spacing: 0.02, noise: 0.002, seed: 1, fines: "pebbles" });
	apartAndWhole(vee, findFragments(vee.cols, { maxDistance: MD }), "a valley");
});

test("a bevelled box is one", function () {
	var p = rockPile({ boxes: [{ centre: [2, 2], size: [1.5, 1, 0.8], yaw: 30, tilt: 0, bevel: 0.3 }], extent: 4, spacing: 0.02, noise: 0.002, seed: 1, fines: "pebbles" });
	var f = findFragments(p.cols, { maxDistance: MD }), m = apartAndWhole(p, f, "bevel");
	assert.ok(f.fragments[m[0].fragment - 1].facets.length >= 2, "top and bevel");
});

test("an edge-on face with no convex partner stays on its own", function () {
	// a free-standing near-vertical face (3 degrees off) whose foot meets box B's top: convex with B
	// for neither of its sides, so it is not given to B
	var pts = [], truth = [], s = 0.02, t3 = Math.tan(3 * Math.PI / 180), k = 2 * Math.PI / (4.5 * s);
	function add(x, y, z, id) { pts.push(x, y, z); truth.push(id); }
	for (var x = s / 2; x < 4; x += s) for (var y = s / 2; y < 3; y += s) {
		if (x >= 2 + t3 * 0.5 && x < 2.6 && y >= 1.2 && y < 1.8) add(x, y, 0.5, 2);
		else add(x, y, 0.75 * s * Math.sin(k * x) * Math.sin(0.87 * k * y), 0);
	}
	for (var z = 0.5 + s / 2; z < 1; z += s) for (y = 1 + s / 2; y < 2; y += s) add(2 + t3 * (1 - z), y, z, 1);
	// and a lone face standing clear of everything: no contacts, its own fragment
	for (z = 0.5 + s / 2; z < 1; z += s) for (y = 0.2 + s / 2; y < 0.8; y += s) add(3.5 + t3 * (1 - z), y, z, 3);
	var c = cloudOf(pts), f = findFragments(c, { maxDistance: MD, surfaceDistance: 3 }), face = {}, boxB = {}, lone = {};
	for (var i = 0; i < c.count; i++) { var t = truth[i] === 1 ? face : truth[i] === 2 ? boxB : truth[i] === 3 ? lone : null; if (t) t[f.fragment[i]] = (t[f.fragment[i]] || 0) + 1; }
	function top(t) { return Number(Object.keys(t).filter(function (id) { return id !== "0"; }).sort(function (p, q) { return t[q] - t[p]; })[0]); }
	assert.ok(top(face) > 0 && top(boxB) > 0);
	assert.notEqual(top(face), top(boxB), "the face is not given to B");
	assert.ok(top(lone) > 0 && top(lone) !== top(face) && top(lone) !== top(boxB), "the lone face is a fragment of its own");
});

test("a flat floor is one fragment, the largest", function () {
	// fines too fine to resolve make a noisy plane - a facet like any other (the demo warns of it)
	var p = rockPile({ boxes: [{ centre: [2, 2], size: [1, 1, 0.6], yaw: 20, tilt: 5 }], extent: 6, spacing: 0.02, noise: 0.002, seed: 1 });
	var f = findFragments(p.cols, { maxDistance: MD }), floor = {}, ground = 0;
	for (var i = 0; i < p.truth.length; i++) if (!p.truth[i]) { ground++; floor[f.fragment[i]] = (floor[f.fragment[i]] || 0) + 1; }
	var id = Number(Object.keys(floor).sort(function (a, b) { return floor[b] - floor[a]; })[0]);
	assert.ok(id > 0 && floor[id] >= 0.9 * ground, "the floor in one fragment");
	assert.ok(f.fragments.every(function (x) { return x.area <= f.fragments[id - 1].area; }), "the largest by area");
	assert.ok(f.fragments[id - 1].area > 0.5 * f.surfaceArea);
	apartAndWhole({ truth: p.truth, boxes: p.boxes }, f, "box on the floor");
});

test("pebbles do not chain into one fragment", function () {
	var p = rockPile({ boxes: [], extent: 6, spacing: 0.02, noise: 0.002, seed: 3, fines: "pebbles" });
	// each merge must keep the fragment convex; without that check one fragment takes ~80 % of the field
	var f = findFragments(p.cols, { maxDistance: MD });
	assert.ok(f.fragments.length > 10);
	f.fragments.forEach(function (x) { assert.ok(x.count <= 0.3 * p.cols.count, "fragment " + x.id + ": " + x.count + " of " + p.cols.count); });
});

test("an edge-on face neither splits nor bridges", function () {
	// box A (1 x 1, 1 high) with its +x side seen, 3 degrees off vertical; box B (0.6 wide, 0.5 high)
	// against that side; fines around; one coarse cell, so the pile faces up and the side is edge-on
	var pts = [], truth = [], s = 0.02, t3 = Math.tan(3 * Math.PI / 180);
	function add(x, y, z, id) { pts.push(x, y, z); truth.push(id); }
	var k = 2 * Math.PI / (4.5 * s);
	for (var x = s / 2; x < 4; x += s) for (var y = s / 2; y < 3; y += s) {
		var inA = x >= 1 && x < 2 && y >= 1 && y < 2, inB = x >= 2 + t3 * 0.5 && x < 2.6 && y >= 1.2 && y < 1.8;
		if (inA) add(x, y, 1, 1);
		else if (inB) add(x, y, 0.5, 2);
		else add(x, y, 0.75 * s * Math.sin(k * x) * Math.sin(0.87 * k * y), 0);
	}
	for (var z = 0.5 + s / 2; z < 1; z += s) for (y = 1 + s / 2; y < 2; y += s) add(2 + t3 * (1 - z), y, z, 1);
	var c = cloudOf(pts), f = findFragments(c, { maxDistance: MD, surfaceDistance: 3 });
	var share = { 1: {}, 2: {} }, tot = { 1: 0, 2: 0 };
	for (var i = 0; i < c.count; i++) if (truth[i]) { tot[truth[i]]++; share[truth[i]][f.fragment[i]] = (share[truth[i]][f.fragment[i]] || 0) + 1; }
	var best = {};
	[1, 2].forEach(function (b) {
		var top = Object.keys(share[b]).filter(function (id) { return id !== "0"; }).sort(function (p, q) { return share[b][q] - share[b][p]; })[0];
		best[b] = top;
		assert.ok(share[b][top] >= 0.9 * tot[b], "box " + b + ": " + share[b][top] + " of " + tot[b]);
	});
	assert.notEqual(best[1], best[2], "two fragments");
});

test("a pile turned 90 degrees with a viewpoint is the same", function () {
	var r = run("pile", PILE), c = r.pile.cols, n = c.count;
	var t = { count: n, x: Float64Array.from(c.x), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { t.y[i] = -c.z[i]; t.z[i] = c.y[i]; }
	var f = findFragments(t, { maxDistance: MD, viewpoint: [6, -20, 6] });
	var pairs = {};
	for (i = 0; i < n; i++) { var key = f.fragment[i] + ":" + r.fr.fragment[i]; pairs[key] = (pairs[key] || 0) + 1; }
	var best = {};
	Object.keys(pairs).forEach(function (key) { var a = key.split(":")[0]; if (!best[a] || pairs[key] > best[a]) best[a] = pairs[key]; });
	var agree = Object.keys(best).reduce(function (s, a) { return s + best[a]; }, 0);
	assert.ok(agree >= 0.98 * n, "agree " + agree / n);
	assert.ok(Math.abs(f.fragments.length - r.fr.fragments.length) <= 0.05 * r.fr.fragments.length);
});

test("a long narrow strip of the pile gives its boxes back", function () {
	// the middle 3 m of the 12 m pile: the default pile scale (a quarter of 12 m) makes one row of cells,
	// whose centroids lie on a line (without the fallback, 5 of the 9 whole boxes came back)
	var r = run("pile", PILE), c = r.pile.cols, keep = [], inside = {}, total = {};
	for (var i = 0; i < c.count; i++) {
		var t = r.pile.truth[i], on = c.y[i] >= 4.5 && c.y[i] < 7.5;
		if (on) keep.push(i);
		if (t) { total[t] = (total[t] || 0) + 1; if (on) inside[t] = (inside[t] || 0) + 1; }
	}
	var strip = { count: keep.length, x: Float64Array.from(keep, function (q) { return c.x[q]; }), y: Float64Array.from(keep, function (q) { return c.y[q]; }), z: Float64Array.from(keep, function (q) { return c.z[q]; }) };
	var f = findFragments(strip, { maxDistance: MD }), whole = r.pile.boxes.filter(function (b) { return inside[b.id] === total[b.id] && b.visibleB >= 10 * PILE.spacing; }), good = 0;
	assert.ok(whole.length >= 8);
	whole.forEach(function (b) {
		var cnt = {}, best = 0, bn = 0, n = 0;
		for (var k = 0; k < keep.length; k++) if (r.pile.truth[keep[k]] === b.id) { n++; cnt[f.fragment[k]] = (cnt[f.fragment[k]] || 0) + 1; }
		Object.keys(cnt).forEach(function (g) { if (g !== "0" && cnt[g] > bn) { bn = cnt[g]; best = Number(g); } });
		var fr = f.fragments[best - 1];
		if (bn >= 0.9 * n && fr && Math.abs(fr.size - b.visibleB) <= 0.1 * b.visibleB) good++;
	});
	assert.ok(good >= 0.85 * whole.length, good + " of " + whole.length + " whole boxes");
});

test("Float32 local at a UTM origin equals Float64 at the origin", function () {
	var r = run("pile", PILE), f32 = rockPile(Object.assign({}, PILE, { float32: true, origin: [478000, 6772000, 300] }));
	// Float32 rounding may flip a few pebble-sized fragments; the boxes' fragments are the same
	var f = findFragments(f32.cols, { maxDistance: MD });
	assert.ok(Math.abs(f.fragments.length - r.fr.fragments.length) <= 0.02 * r.fr.fragments.length, f.fragments.length + " vs " + r.fr.fragments.length);
	var a64 = matchBoxes(r.pile, r.fr), a32 = matchBoxes(f32, f);
	a64.forEach(function (x, k) {
		if (x.box.visibleB < 10 * PILE.spacing || x.share < 0.9) return;
		var s64 = r.fr.fragments[x.fragment - 1].size, s32 = f.fragments[a32[k].fragment - 1].size;
		assert.ok(Math.abs(s32 - s64) <= 0.001 * s64, "box " + x.box.id + ": " + s32 + " vs " + s64);
	});
});

test("dust stays out", function () {
	var p = rockPile(Object.assign({}, PILE, { stray: 0.01 })), f = findFragments(p.cols, { maxDistance: MD }), base = run("pile", PILE).pile.cols.count;
	// a stray point joins a fragment only within fillDistance of a facet point (stray points fill the pile's volume,
	// so some lie that near a rock)
	var zero = 0, fp = [];
	for (var i = 0; i < base; i++) if (f.facets.facet[i]) fp.push(i);
	var fc = { count: fp.length, x: Float64Array.from(fp, function (q) { return p.cols.x[q]; }), y: Float64Array.from(fp, function (q) { return p.cols.y[q]; }), z: Float64Array.from(fp, function (q) { return p.cols.z[q]; }) };
	var tree = buildKdTree(fc, "test"), P = new Uint32Array(1), D2 = new Float64Array(1);
	for (i = base; i < p.cols.count; i++) {
		if (!f.fragment[i]) { zero++; continue; }
		assert.equal(kdNearest(tree, p.cols.x[i], p.cols.y[i], p.cols.z[i], 1, MD * MD * (1 + 1e-9), -1, P, D2), 1, "stray point " + i + " joined from afar");
	}
	assert.ok(zero >= 0.85 * (p.cols.count - base), "stray at 0: " + zero + " of " + (p.cols.count - base));
	noNaN(f);
});

test("the same run twice is the same", function () {
	var r = run("pile", PILE), again = findFragments(r.pile.cols, { maxDistance: MD });
	assert.deepEqual(again.fragment, r.fr.fragment);
	assert.deepEqual(again.fragments, r.fr.fragments);
});

test("fill off leaves more at 0; the fill never spreads", function () {
	var r = run("pile", PILE), off = findFragments(r.pile.cols, { maxDistance: MD, fill: false });
	function zeros(col) { var z = 0; for (var i = 0; i < col.length; i++) if (!col[i]) z++; return z; }
	assert.ok(zeros(off.fragment) >= zeros(r.fr.fragment));
	// a tail of points leading off a plane, each 0.05 from the last: only those within fillDistance of the plane join
	var pts = [];
	for (var x = 0.01; x < 2; x += 0.02) for (var y = 0.01; y < 2; y += 0.02) pts.push(x, y, 0);
	for (var k = 1; k <= 10; k++) pts.push(2 + 0.05 * k, 1, 0.3 * k * 0.05);
	var c = cloudOf(pts), f = findFragments(c, { maxDistance: MD });
	assert.equal(f.fragments.length, 1);
	for (k = 2; k <= 10; k++) assert.equal(f.fragment[c.count - 11 + k], 0, "tail point " + k);
});

test("reused normals and a given outline cell", function () {
	var p = rockPile({ boxes: [{ centre: [2, 2], size: [1.5, 1, 0.8], yaw: 30, tilt: 8 }], extent: 4, spacing: 0.02, noise: 0.002, seed: 2, fines: "pebbles" });
	var a = findFragments(p.cols, { maxDistance: MD });
	var nm = pointNormals(p.cols, { k: 16, maxDistance: MD }), calls = [];
	var b = findFragments(p.cols, { maxDistance: MD, normals: nm, onProgress: function (d, t) { calls.push([d, t]); } });
	assert.deepEqual(b.fragment, a.fragment);
	assert.equal(calls[calls.length - 1][1], 2 * p.cols.count, "no normals in the total");
	var c = findFragments(p.cols, { maxDistance: MD, facetOptions: { outlineCell: 0.1 } });
	var box = matchBoxes(p, c)[0];
	var ar = c.fragments[box.fragment - 1].area, a0 = a.fragments[matchBoxes(p, a)[0].fragment - 1].area;
	assert.ok(ar > a0, "a coarser outline grid covers more: " + ar + " vs " + a0);
	var none = [];
	findFragments({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }, { maxDistance: MD, onProgress: function (d, t) { none.push([d, t]); } });
	assert.deepEqual(none, [[0, 0]]);
});

test("hard inputs do not crash", function () {
	var empty = findFragments({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }, { maxDistance: MD });
	assert.equal(empty.fragments.length, 0);
	assert.equal(empty.fragment.length, 0);
	var pts = [];
	for (var x = 0.025; x < 10; x += 0.05) for (var y = 0.025; y < 10; y += 0.05) pts.push(x, y, 0.1 * x);
	var plane = findFragments(cloudOf(pts), { maxDistance: 0.15 });
	assert.equal(plane.fragments.length, 1);
	noNaN(plane);
	pts = [];
	for (var i = 0; i < 400; i++) pts.push(i * 0.01, 0, 0);
	var line = findFragments(cloudOf(pts), { maxDistance: MD });
	pts = [];
	for (i = 0; i < 1000; i++) pts.push(1, 2, 3);
	var dup = findFragments(cloudOf(pts), { maxDistance: MD });
	pts = [];
	for (i = 0; i < 500; i++) pts.push(i % 25, Math.floor(i / 25), 0);   // 1 m apart: no neighbours at all
	var sparse = findFragments(cloudOf(pts), { maxDistance: MD });
	assert.equal(sparse.fragments.length, 0);
	[line, dup, sparse].forEach(function (f) {
		for (var j = 0; j < f.fragment.length; j++) assert.ok(f.fragment[j] <= f.fragments.length);
		noNaN(f);
		assert.ok(Number.isFinite(f.surfaceArea) && Number.isFinite(f.unassignedArea));
	});
});

test("onProgress", function () {
	var p = rockPile({ boxes: [{ centre: [2, 2], size: [1, 1, 0.6], yaw: 0, tilt: 0 }], extent: 4, spacing: 0.02, noise: 0.002, seed: 1 });
	var calls = [];
	findFragments(p.cols, { maxDistance: MD, onProgress: function (d, t) { calls.push([d, t]); } });
	assert.ok(calls.length > 2);
	for (var i = 1; i < calls.length; i++) assert.ok(calls[i][0] >= calls[i - 1][0], "never decreases");
	var last = calls[calls.length - 1];
	assert.equal(last[0], last[1]);
	assert.equal(last[1], 3 * p.cols.count);
});

test("speed", { skip: COVERAGE }, function () {
	var p = rockPile({ count: 110, swebrec: PILE.swebrec, extent: 20, spacing: 0.02, noise: 0.005, seed: 4 });
	var t0 = performance.now(), f = findFragments(p.cols, { maxDistance: MD }), s = (performance.now() - t0) / 1000;
	console.log("findFragments: " + p.cols.count + " points, " + f.fragments.length + " fragments, " + s.toFixed(1) + " s");
	assert.ok(s < 40, s + " s");
});

test("bad options are refused, naming them", function () {
	var p = rockPile({ boxes: [{ centre: [1, 1], size: [1, 1, 0.6], yaw: 0, tilt: 0 }], extent: 2, spacing: 0.05, noise: 0, seed: 1 }), c = p.cols;
	assert.throws(function () { findFragments(c); }, /options/);
	assert.throws(function () { findFragments(c, {}); }, /maxDistance is required/);
	var called = false;
	assert.throws(function () { findFragments(c, { maxDistance: MD, facetOptions: { maxAngle: 0 }, onProgress: function () { called = true; } }); }, /maxAngle/);
	assert.equal(called, false, "refused before any work");
	assert.throws(function () { findFragments(c, { maxDistance: MD, facetOptions: "x" }); }, /facetOptions/);
	assert.throws(function () { findFragments(c, { maxDistance: MD, concaveAngle: 0 }); }, /concaveAngle/);
	assert.throws(function () { findFragments(c, { maxDistance: MD, concaveAngle: 90 }); }, /concaveAngle/);
	assert.throws(function () { findFragments(c, { maxDistance: MD, surfaceDistance: MD }); }, /surfaceDistance/);
	assert.throws(function () { findFragments(c, { maxDistance: MD, fillDistance: 0 }); }, /fillDistance/);
	assert.throws(function () { findFragments(c, { maxDistance: MD, fill: "yes" }); }, /fill/);
	assert.throws(function () { findFragments(c, { maxDistance: MD, minPoints: 2 }); }, /minPoints/);
	assert.throws(function () { findFragments(c, { maxDistance: MD, viewpoint: [0, 0] }); }, /viewpoint/);
	assert.throws(function () { findFragments(c, { maxDistance: MD, k: 2 }); }, /k/);
	try { findFragments(c, { maxDistance: MD, fill: 1 }); } catch (e) { assert.equal(e.code, lib.ERROR_CODES.INVALID_ARGUMENT); }
});
