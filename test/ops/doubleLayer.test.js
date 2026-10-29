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
