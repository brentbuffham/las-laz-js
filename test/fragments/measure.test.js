// test/fragments/measure.test.js
//==========================================================
// measureFragments: a run's own labelling measured with its measure
// field gives back the run's fragments and areas exactly (facets,
// watershed, hybrid; Float32 at a UTM origin); hand edits (a rock split,
// two merged, points sent to fines or removed, a rock under minPoints,
// ids kept as given and asked in any order); a parallel run's areas and
// watershed rocks; progress, abort and bad inputs. Synthetic piles.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFragments } from "../../src/fragments/findFragments.js";
import { findFragmentsParallel } from "../../src/fragments/parallel.js";
import { measureFragments, FRAGMENT_REMOVED } from "../../src/fragments/measure.js";
import * as lib from "../../src/index.js";
import { rockPile } from "../helpers/rocks.js";

var PILE = rockPile({ count: 40, swebrec: { x50: 0.5, xmax: 1, b: 2 }, extent: 5, spacing: 0.02, noise: 0.002, seed: 3, fines: "pebbles" });
var cache = {};
function run(method) {
	if (!cache[method]) cache[method] = findFragments(PILE.cols, method === "facets" ? { maxDistance: 0.06 } : { method: method });
	return cache[method];
}
function fromOf(fr) { var m = new Map(); fr.fragments.forEach(function (f) { if (f.from) m.set(f.id, f.from); }); return m; }
function same(got, want, label) {
	assert.equal(got.id, want.id, label);
	["count", "size", "area", "sheet"].forEach(function (key) { assert.equal(got[key], want[key], label + " " + key); });
	["centroid", "normal", "axes"].forEach(function (key) { assert.deepEqual(got[key], want[key], label + " " + key); });
	assert.deepEqual(Array.from(got.outline), Array.from(want.outline), label + " outline");
	if (want.from) assert.equal(got.from, want.from, label + " from");
	assert.equal(got.small, false, label + " small");
}
function oracle(cols, fr, label) {
	assert.ok(fr.fragments.length >= 5, label + ": " + fr.fragments.length + " fragments");
	var m = measureFragments(cols, fr.fragment, { measure: fr.measure, from: fromOf(fr) });
	assert.equal(m.fragments.length, fr.fragments.length, label);
	m.fragments.forEach(function (f, q) { same(f, fr.fragments[q], label + " rock " + f.id); });
	assert.deepEqual(m.gone, []);
	assert.deepEqual(m.tooSmall, []);
	assert.equal(m.surfaceArea, fr.surfaceArea, label + " surfaceArea");
	assert.equal(m.unassignedArea, fr.unassignedArea, label + " unassignedArea");
}

test("a run's own labelling gives back its fragments and areas exactly", function () {
	["facets", "watershed", "hybrid"].forEach(function (method) {
		var fr = run(method);
		assert.equal(fr.measure.method, method);
		oracle(PILE.cols, fr, method);
	});
	var h = run("hybrid");
	assert.ok(h.fromWatershed > 0 && h.fromFacets > 0, "hybrid kinds " + h.fromWatershed + " / " + h.fromFacets);
	// the measure field is plain data: it survives JSON (Kirra posts it from its job worker)
	var back = JSON.parse(JSON.stringify(h.measure));
	assert.equal(measureFragments(PILE.cols, h.fragment, { measure: back, from: fromOf(h) }).unassignedArea, h.unassignedArea);
});

test("Float32 at a UTM origin is exact too", function () {
	var n = PILE.cols.count, c = { count: n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = PILE.cols.x[i] + 312000; c.y[i] = PILE.cols.y[i] + 6609000; c.z[i] = PILE.cols.z[i] + 400; }
	oracle(c, findFragments(c, { method: "hybrid" }), "hybrid f32");
	oracle(c, findFragments(c, { maxDistance: 0.06 }), "facets f32");
});

test("ids are kept as given, asked in any order; asked ids with no points are gone", function () {
	var fr = run("watershed"), label = Uint32Array.from(fr.fragment, function (v) { return v ? v + 1000 : 0; });
	var m = measureFragments(PILE.cols, label, { measure: fr.measure, ids: [1003, 1001, 77, 1003] });
	assert.deepEqual(m.fragments.map(function (f) { return f.id; }), [1003, 1001]);
	assert.deepEqual(m.gone, [77]);
	assert.equal(m.fragments[0].count, fr.fragments[2].count);
	assert.deepEqual(m.fragments[0].axes, fr.fragments[2].axes);
	// areas are the whole labelling's, whatever is asked
	assert.equal(m.surfaceArea, fr.surfaceArea);
	assert.equal(m.unassignedArea, fr.unassignedArea);
	assert.equal(measureFragments(PILE.cols, label, { measure: fr.measure, ids: [] }).fragments.length, 0);
});

test("a rock split in two, two merged, sent to fines: measured as the run would", function () {
	var fr = run("watershed"), n = PILE.cols.count, X = PILE.cols.x, i;
	var A = fr.fragments[0], B = fr.fragments[1], label = Uint32Array.from(fr.fragment);
	// split rock 1 across its centroid in x: 1 keeps one side, 500 takes the other
	for (i = 0; i < n; i++) if (label[i] === A.id && X[i] > A.centroid[0]) label[i] = 500;
	var m = measureFragments(PILE.cols, label, { measure: fr.measure, ids: [A.id, 500] });
	assert.equal(m.fragments[0].count + m.fragments[1].count, A.count);
	m.fragments.forEach(function (f) { assert.ok(f.size < A.size && f.normal[2] > 0 && f.area > 0 && f.outline.length >= 9); });
	// merged back, it is rock 1 again, to the digit
	for (i = 0; i < n; i++) if (label[i] === 500) label[i] = A.id;
	same(measureFragments(PILE.cols, label, { measure: fr.measure, ids: [A.id] }).fragments[0], A, "merged back");
	// rocks 1 and 2 as one: every point of both
	for (i = 0; i < n; i++) if (label[i] === B.id) label[i] = A.id;
	assert.equal(measureFragments(PILE.cols, label, { measure: fr.measure, ids: [A.id] }).fragments[0].count, A.count + B.count);
	// rock 1 to fines: the fines area grows, the surface does not change
	label = Uint32Array.from(fr.fragment);
	for (i = 0; i < n; i++) if (label[i] === A.id) label[i] = 0;
	var f0 = measureFragments(PILE.cols, label, { measure: fr.measure, ids: [A.id] });
	assert.deepEqual(f0.gone, [A.id]);
	assert.equal(f0.surfaceArea, fr.surfaceArea);
	assert.ok(f0.unassignedArea > fr.unassignedArea);
});

test("a rock under minPoints comes back flagged small and counts as fines", function () {
	var fr = run("watershed"), n = PILE.cols.count, label = Uint32Array.from(fr.fragment), A = fr.fragments[0], kept = 0, i;
	for (i = 0; i < n; i++) if (label[i] === A.id) { if (kept < 20) kept++; else label[i] = 0; }
	var m = measureFragments(PILE.cols, label, { measure: fr.measure, ids: [A.id] });
	assert.equal(m.fragments[0].count, 20);
	assert.equal(m.fragments[0].small, true);
	assert.deepEqual(m.tooSmall, [A.id]);
	assert.ok(Number.isFinite(m.fragments[0].size));
	// the areas as if it were fines
	for (i = 0; i < n; i++) if (label[i] === A.id) label[i] = 0;
	assert.equal(measureFragments(PILE.cols, label, { measure: fr.measure }).unassignedArea, m.unassignedArea);
});

test("removed points count in neither area and in no rock", function () {
	["facets", "watershed", "hybrid"].forEach(function (method) {
		var fr = run(method), n = PILE.cols.count, label = Uint32Array.from(fr.fragment), X = PILE.cols.x, A = fr.fragments[0], i;
		// a strip of the cloud taken out of the analysis, and all of rock 1
		for (i = 0; i < n; i++) if (X[i] < 1 || label[i] === A.id) label[i] = FRAGMENT_REMOVED;
		var m = measureFragments(PILE.cols, label, { measure: fr.measure, from: fromOf(fr) });
		assert.ok(m.surfaceArea < fr.surfaceArea, method + " surface " + m.surfaceArea + " vs " + fr.surfaceArea);
		assert.ok(m.unassignedArea < fr.unassignedArea && m.unassignedArea > 0, method + " fines " + m.unassignedArea);
		assert.ok(m.fragments.every(function (f) { return f.id !== A.id; }));
		// -1 in an Int32Array is removed too
		var l2 = Int32Array.from(label, function (v) { return v === FRAGMENT_REMOVED ? -1 : v; });
		assert.equal(measureFragments(PILE.cols, l2, { measure: fr.measure, from: fromOf(fr) }).surfaceArea, m.surfaceArea);
		// everything removed: nothing
		var all = measureFragments(PILE.cols, new Uint32Array(n).fill(FRAGMENT_REMOVED), { measure: fr.measure });
		assert.deepEqual([all.fragments.length, all.surfaceArea, all.unassignedArea], [0, 0, 0]);
	});
});

test("a parallel run: its areas and its watershed rocks exactly", async function () {
	var par = await findFragmentsParallel(PILE.cols, { method: "watershed", threads: 1, tile: 2, overlap: 1 });
	assert.ok(par.tiles >= 4, "tiles " + par.tiles);
	var m = measureFragments(PILE.cols, par.fragment, { measure: par.measure });
	assert.equal(m.surfaceArea, par.surfaceArea);
	assert.equal(m.unassignedArea, par.unassignedArea);
	// a rock no seam trimmed (every point of its tile's record still labelled) is its record to the digit
	var exact = 0;
	m.fragments.forEach(function (f, q) {
		var r = par.fragments[q];
		assert.equal(f.id, r.id);
		if (f.count === r.count) { same(f, Object.assign({}, r, { sheet: f.sheet }), "parallel rock " + f.id); exact++; }
	});
	assert.ok(exact >= 0.8 * m.fragments.length, exact + " of " + m.fragments.length);
	// a hybrid's facet rocks: close (each tile had its own pile and outline cell)
	var ph = await findFragmentsParallel(PILE.cols, { method: "hybrid", threads: 1, tile: 2, overlap: 1 });
	var mh = measureFragments(PILE.cols, ph.fragment, { measure: ph.measure, from: fromOf(ph) });
	assert.equal(mh.surfaceArea, ph.surfaceArea);
	assert.equal(mh.unassignedArea, ph.unassignedArea);
	mh.fragments.forEach(function (f, q) {
		var r = ph.fragments[q];
		if (f.count === r.count) assert.ok(Math.abs(f.size - r.size) <= 1e-9 * r.size && Math.abs(f.area - r.area) <= 0.5 * r.area + 1e-9, "rock " + f.id);
	});
});

test("a cloud shifted to another frame and back in Float32 (a reload) is measured in the run's frame", function () {
	// Kirra: positions Float32 local to a session origin; a reload rebases them 1.4 km away, and they are shifted back
	// for the run's frame: the pile's edge lands a hair outside the run's grid
	var n = PILE.cols.count, c = { count: n, x: new Float32Array(n), y: new Float32Array(n), z: Float32Array.from(PILE.cols.z) }, i;
	for (i = 0; i < n; i++) { c.x[i] = PILE.cols.x[i]; c.y[i] = PILE.cols.y[i]; }
	var fr = findFragments(c, { method: "watershed" }), g = fr.measure.areas;
	var back = { count: n, x: new Float32Array(n), y: new Float32Array(n), z: c.z }, outside = 0;
	for (i = 0; i < n; i++) {
		back.x[i] = Math.fround(Math.fround(c.x[i] - 1404.34) + 1404.34); back.y[i] = Math.fround(Math.fround(c.y[i] - 1120.4) + 1120.4);
		if (back.x[i] < g.u0 || back.y[i] < g.v0) outside++;
	}
	assert.ok(outside > 0, "the round trip puts edge points outside the grid");
	var m = measureFragments(back, fr.fragment, { measure: fr.measure });
	assert.equal(m.fragments.length, fr.fragments.length);
	m.fragments.forEach(function (f, q) { assert.equal(f.count, fr.fragments[q].count); assert.ok(Math.abs(f.size - fr.fragments[q].size) < 1e-3, "rock " + f.id); });
	assert.ok(Math.abs(m.surfaceArea - fr.surfaceArea) <= 0.01 * fr.surfaceArea, m.surfaceArea + " vs " + fr.surfaceArea);
	assert.ok(Math.abs(m.unassignedArea - fr.unassignedArea) <= 0.02 * fr.unassignedArea, m.unassignedArea + " vs " + fr.unassignedArea);
});

test("progress runs to its total; a signal stops it", function () {
	var fr = run("hybrid"), seen = [];
	measureFragments(PILE.cols, fr.fragment, { measure: fr.measure, from: fromOf(fr), onProgress: function (d, t) { seen.push([d, t]); } });
	assert.ok(seen.length >= 3);
	for (var i = 1; i < seen.length; i++) assert.ok(seen[i][0] >= seen[i - 1][0]);
	assert.equal(seen[seen.length - 1][0], seen[seen.length - 1][1]);
	var ac = new AbortController();
	ac.abort();
	assert.throws(function () { measureFragments(PILE.cols, fr.fragment, { measure: fr.measure, signal: ac.signal }); }, function (e) { return e.code === "ABORTED"; });
	var ac2 = new AbortController(), calls = 0;
	assert.throws(function () {
		measureFragments(PILE.cols, fr.fragment, { measure: fr.measure, from: fromOf(fr), signal: ac2.signal, onProgress: function () { if (++calls === 2) ac2.abort(); } });
	}, function (e) { return e.code === "ABORTED"; });
});

test("bad inputs are named", function () {
	var fr = run("watershed"), n = PILE.cols.count, L = fr.fragment;
	assert.throws(function () { measureFragments(PILE.cols, L); }, /needs options/);
	assert.throws(function () { measureFragments(PILE.cols, L, { measure: {} }); }, /measure must be the run result's measure/);
	assert.throws(function () { measureFragments(PILE.cols, L.subarray(1), { measure: fr.measure }); }, /one value a point/);
	assert.throws(function () { measureFragments(PILE.cols, Float64Array.from(L, function (v, i) { return i === 5 ? 1.5 : v; }), { measure: fr.measure }); }, /label 1.5 at point 5/);
	assert.throws(function () { measureFragments(PILE.cols, L, { measure: fr.measure, ids: [0] }); }, /ids must be rock ids/);
	assert.throws(function () { measureFragments(PILE.cols, L, { measure: fr.measure, onProgress: 3 }); }, /onProgress must be a function/);
	assert.throws(function () { measureFragments(PILE.cols, L, { measure: Object.assign({}, run("hybrid").measure), from: function () { return "rock"; } }); }, /from must say/);
	// a facet rock in a watershed run's measure: no outline cell
	assert.throws(function () { measureFragments(PILE.cols, L, { measure: Object.assign({}, fr.measure, { method: "hybrid" }), from: function () { return "facets"; } }); }, /outlineCell is missing/);
	// another cloud's measure: points off the grid
	var far = { count: n, x: Float64Array.from(PILE.cols.x, function (v) { return v + 100; }), y: PILE.cols.y, z: PILE.cols.z };
	assert.throws(function () { measureFragments(far, L, { measure: fr.measure }); }, /outside the run's grid/);
	// over half a cell outside is not the run's either
	var g = fr.measure.areas, past = { count: n, x: Float64Array.from(PILE.cols.x, function (v, i) { return i === 7 ? g.u0 - 0.6 * g.px : v; }), y: PILE.cols.y, z: PILE.cols.z };
	assert.throws(function () { measureFragments(past, L, { measure: fr.measure, ids: [] }); }, /point 7 is outside the run's grid/);
	// an empty cloud
	var e = measureFragments({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }, [], { measure: fr.measure });
	assert.deepEqual([e.fragments.length, e.surfaceArea, e.unassignedArea], [0, 0, 0]);
});

test("the package exports measureFragments and FRAGMENT_REMOVED", function () {
	assert.equal(lib.measureFragments, measureFragments);
	assert.equal(lib.FRAGMENT_REMOVED, 4294967295);
});
