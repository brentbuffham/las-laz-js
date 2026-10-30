// test/ops/doubleLayer.test.js
//==========================================================
// selectDoubleLayer and snapToLayer on a made-up doubled slope: a dense
// surface and a sparser copy a drifting distance below it.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDoubleLayer, snapToLayer } from "../../src/ops/doubleLayer.js";
import * as lib from "../../src/index.js";
import { rng } from "../helpers/clouds.js";

var surface = function (x, y) { return 0.2 * x + 0.5 * Math.sin(y / 5); };
var drop = function (x) { return 1 + 0.02 * x; };   // the ghost lies this far below, more as x grows

// n x n metres at 0.25 m: the real surface everywhere, the ghost on every other point
function doubled(n, ghostEvery) {
	var r = rng(7), xs = [], ys = [], zs = [], layer = [];
	for (var x = 0; x < n; x += 0.25) for (var y = 0; y < n; y += 0.25) {
		var z = surface(x, y) + (r() - 0.5) * 0.02;
		xs.push(x); ys.push(y); zs.push(z); layer.push(0);
		if (((xs.length) % ghostEvery) === 0) { xs.push(x + 0.01); ys.push(y); zs.push(z - drop(x) + (r() - 0.5) * 0.02); layer.push(1); }
	}
	return { cols: { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) }, layer: layer };
}

test("selectDoubleLayer and snapToLayer are exported from the package", function () {
	assert.equal(lib.selectDoubleLayer, selectDoubleLayer);
	assert.equal(lib.snapToLayer, snapToLayer);
});

test("the ghost sheet is selected and the real one is not", function () {
	var d = doubled(30, 3), f = selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4 });
	var chosen = new Set(f.selection), wrong = 0;
	for (var i = 0; i < d.cols.count; i++) if (chosen.has(i) !== (d.layer[i] === 1)) wrong++;
	assert.ok(wrong < d.cols.count * 0.01, wrong + " of " + d.cols.count + " wrong");
	assert.equal(f.stats.selected, f.selection.length);
	assert.ok(f.dz.length === f.selection.length && f.dominantZ.length === f.selection.length);
	assert.ok(f.stats.min > 0.9 && f.stats.max < 1.7, "dz " + f.stats.min + " to " + f.stats.max);
});

test("offset mode puts the ghost on the real surface, following the drift", function () {
	var d = doubled(30, 3), f = selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4 });
	var s = snapToLayer(d.cols, f), worst = 0;
	for (var k = 0; k < f.selection.length; k++) { var i = f.selection[k]; worst = Math.max(worst, Math.abs(s.z[i] - surface(d.cols.x[i], d.cols.y[i]))); }
	assert.ok(worst < 0.15, "worst " + worst);
	assert.equal(s.x, d.cols.x);                          // the other columns are shared
	assert.notEqual(s.z, d.cols.z);                       // the input is left alone
});

test("surface mode and average mode", function () {
	var d = doubled(30, 3), f = selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4 });
	var flat = snapToLayer(d.cols, f, { mode: "surface" });
	for (var k = 0; k < f.selection.length; k++) assert.equal(flat.z[f.selection[k]], f.dominantZ[k]);
	var avg = snapToLayer(d.cols, f, { mode: "average", blend: 0.5 }), gap = 0;
	for (k = 0; k < f.selection.length; k += 7) {
		var g = f.selection[k], near = f.partner.selection.findIndex(function (p) { return Math.abs(d.cols.x[p] - d.cols.x[g]) < 0.5 && Math.abs(d.cols.y[p] - d.cols.y[g]) < 0.5; });
		if (near >= 0) gap = Math.max(gap, Math.abs(avg.z[g] - avg.z[f.partner.selection[near]]));
	}
	assert.ok(gap < 0.2, "layers still " + gap + " apart");
	var none = snapToLayer(d.cols, f, { mode: "average", blend: 0 });
	assert.deepEqual(none.z, snapToLayer(d.cols, f).z);
});

test("keep: upper, lower and auto", function () {
	var d = doubled(30, 4);
	var up = selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4, keep: "upper" }), lo = selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4, keep: "lower" });
	assert.ok(up.stats.median > 0 && lo.stats.median < 0);
	// the ghost sheet is the smaller: auto keeps the real one, as upper does
	var au = selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4 });
	assert.deepEqual(au.selection, up.selection);
});

test("a single surface, a small gap and a far layer give nothing", function () {
	var d = doubled(20, 1e9);
	assert.equal(selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4 }).selection.length, 0);
	var e = doubled(20, 3);
	assert.equal(selectDoubleLayer(e.cols, { cell: 1, minGap: 5 }).selection.length, 0);
	assert.equal(selectDoubleLayer(e.cols, { cell: 1, minGap: 0.4, maxGap: 0.5 }).selection.length, 0);
	assert.equal(selectDoubleLayer({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }, { cell: 1, minGap: 1 }).selection.length, 0);
});

test("a positions column works, and bad arguments are refused", function () {
	var d = doubled(15, 3), pos = new Float64Array(d.cols.count * 3);
	for (var i = 0; i < d.cols.count; i++) { pos[3 * i] = d.cols.x[i]; pos[3 * i + 1] = d.cols.y[i]; pos[3 * i + 2] = d.cols.z[i]; }
	assert.deepEqual(selectDoubleLayer({ count: d.cols.count, positions: pos }, { cell: 1, minGap: 0.4 }).selection, selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4 }).selection);
	[{ minGap: 1 }, { cell: 1 }, { cell: -1, minGap: 1 }, { cell: 1, minGap: 1, keep: "x" }, { cell: 1, minGap: 1, minPoints: 0 }, { cell: 1, minGap: 1, smooth: -1 }, { cell: 1, minGap: 1, maxGap: 0.5 }]
		.forEach(function (o) { assert.throws(function () { selectDoubleLayer(d.cols, o); }, { code: "INVALID_ARGUMENT" }); });
	var f = selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4 });
	assert.throws(function () { snapToLayer(d.cols, f, { mode: "x" }); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { snapToLayer(d.cols, f, { blend: 2 }); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { snapToLayer(d.cols, {}); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { snapToLayer({ count: 3, x: new Float64Array(3), y: new Float64Array(3), z: new Float64Array(3) }, f); }, { code: "INVALID_ARGUMENT" });
});

test("inPlace writes into the input's z", function () {
	var d = doubled(15, 3), f = selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4 }), z = d.cols.z;
	var s = snapToLayer(d.cols, f, { inPlace: true });
	assert.equal(s.z, z);
});

// --- a ghost is a sheet over an area, not a rock ----------------------------------------------------------------
// flat ground at 0.1 m; a ghost sheet 1 m below it over 15 x 15 m (every other point); 30 boulders, each a 0.3 m
// square of 9 points 0.6 m above the ground, away from the sheet
function withRocks(rockHeight) {
	var r = rng(11), xs = [], ys = [], zs = [], sheet = [];
	for (var x = 0; x < 40; x += 0.1) for (var y = 0; y < 40; y += 0.1) {
		xs.push(x); ys.push(y); zs.push((r() - 0.5) * 0.02); sheet.push(0);
		if (x >= 5 && x < 20 && y >= 5 && y < 20 && (Math.round(x * 10) + Math.round(y * 10)) % 2 === 0) { xs.push(x); ys.push(y); zs.push(-1 + (r() - 0.5) * 0.02); sheet.push(1); }
	}
	var rocks = 0;
	while (rocks < 30) {
		var rx = 1 + r() * 38, ry = 1 + r() * 38;
		if (rx > 3 && rx < 22 && ry > 3 && ry < 22) continue;     // not on the sheet
		for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) { xs.push(rx + i * 0.1); ys.push(ry + j * 0.1); zs.push(rockHeight(rocks)); sheet.push(2); }
		rocks++;
	}
	return { cols: { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) }, kind: sheet };
}

function count(d, f, kind) { var n = 0; f.selection.forEach(function (i) { if (d.kind[i] === kind) n++; }); return n; }

test("minArea drops isolated rocks and keeps the sheet", function () {
	var d = withRocks(function () { return 0.6; }), base = { cell: 0.5, minGap: 0.3, minPoints: 5 };
	var all = selectDoubleLayer(d.cols, base), clean = selectDoubleLayer(d.cols, Object.assign({}, base, { minArea: 4 }));
	assert.ok(count(d, all, 2) >= 100, "rocks selected without minArea: " + count(d, all, 2));
	assert.equal(count(d, clean, 2), 0, "rock points still selected");
	assert.equal(count(d, clean, 1), count(d, all, 1), "the sheet changed");
	assert.ok(count(d, clean, 1) > 0.9 * 15 * 15 * 100 / 2);
	assert.ok(clean.stats.cellsDropped > 0);
	assert.equal(all.stats.cellsDropped, 0);
	assert.equal(clean.stats.selected, clean.selection.length);
	assert.equal(clean.stats.cellsDouble, all.stats.cellsDouble - clean.stats.cellsDropped);
});

test("minArea is in square metres: a patch just under it goes, just over it stays", function () {
	var d = withRocks(function () { return 0.6; }), base = { cell: 0.5, minGap: 0.3, minPoints: 5 };
	var sheet = 15 * 15;   // the sheet's patch is 225 m2
	assert.ok(count(d, selectDoubleLayer(d.cols, Object.assign({}, base, { minArea: sheet - 20 })), 1) > 0);
	assert.equal(count(d, selectDoubleLayer(d.cols, Object.assign({}, base, { minArea: sheet + 40 })), 1), 0);
});

test("rubble: touching rocks at different heights are not a patch, a steady offset is", function () {
	// a 6 x 6 m field of rocks, one per 0.5 m cell, heights anywhere from 0.4 to 1.2 m
	var r = rng(5), xs = [], ys = [], zs = [];
	for (var x = 0; x < 20; x += 0.1) for (var y = 0; y < 20; y += 0.1) { xs.push(x); ys.push(y); zs.push(0); }
	for (var cx = 0; cx < 12; cx++) for (var cy = 0; cy < 12; cy++) {
		var h = 0.4 + 0.8 * r();
		for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) { xs.push(5 + cx * 0.5 + i * 0.1 + 0.05); ys.push(5 + cy * 0.5 + j * 0.1 + 0.05); zs.push(h); }
	}
	var cols = { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) };
	var base = { cell: 0.5, minGap: 0.3, minPoints: 5, minArea: 4 };
	assert.equal(selectDoubleLayer(cols, Object.assign({}, base, { coherence: 0.03 })).selection.length, 0, "rubble taken for a sheet");
	// the same field at one height is a steady offset: that is a patch
	var flat = { count: cols.count, x: cols.x, y: cols.y, z: cols.z.map(function (z) { return z > 0 ? 0.8 : 0; }) };
	assert.ok(selectDoubleLayer(flat, base).selection.length >= 12 * 12 * 9 * 0.9);
});

test("a drifting sheet stays one patch at the default coherence", function () {
	var d = doubled(30, 3);   // the ghost drops 1 + 0.02 x metres: about 0.01 m between neighbouring cells
	var f = selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4, minArea: 100 });
	assert.ok(f.stats.selected > 0 && f.stats.cellsDropped === 0, "dropped " + f.stats.cellsDropped);
});

test("minArea and coherence are checked", function () {
	var d = doubled(10, 3);
	[{ minArea: -1 }, { minArea: NaN }, { minArea: "4" }, { coherence: 0 }, { coherence: -1 }, { coherence: Infinity }]
		.forEach(function (o) { assert.throws(function () { selectDoubleLayer(d.cols, Object.assign({ cell: 1, minGap: 0.4 }, o)); }, { code: "INVALID_ARGUMENT" }); });
	assert.doesNotThrow(function () { selectDoubleLayer(d.cols, { cell: 1, minGap: 0.4, minArea: 0 }); });
});
