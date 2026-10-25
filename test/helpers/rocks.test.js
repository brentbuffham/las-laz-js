// test/helpers/rocks.test.js
//==========================================================
// rockPile, the synthetic muckpile the fragment tests measure against:
// truth for every point, every box seen, visibleB the axes measure of
// its own points, the ground area, the same cloud for the same seed,
// given boxes placed as given.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rockPile } from "./rocks.js";
import { fragmentAxes } from "../../src/fragments/axes.js";

var PILE = { count: 40, swebrec: { x50: 0.5, xmax: 2, b: 2 }, extent: 12, spacing: 0.02, noise: 0.005, seed: 1 };

test("a pile by construction", function () {
	var p = rockPile(PILE), n = p.cols.count;
	assert.equal(p.truth.length, n);
	assert.ok(p.boxes.length >= 20, p.boxes.length + " boxes seen");
	var counts = {};
	for (var i = 0; i < n; i++) counts[p.truth[i]] = (counts[p.truth[i]] || 0) + 1;
	p.boxes.forEach(function (b) {
		assert.equal(counts[b.id], b.points, "box " + b.id);
		var idx = new Uint32Array(b.points), k = 0;
		for (i = 0; i < n; i++) if (p.truth[i] === b.id) idx[k++] = i;
		assert.equal(b.visibleB, fragmentAxes(p.cols.x, p.cols.y, p.cols.z, 1, idx).axes[1]);
		assert.ok(b.size[0] >= b.size[1] && b.size[1] >= b.size[2]);
	});
	Object.keys(counts).forEach(function (id) { assert.ok(id === "0" || p.boxes.some(function (b) { return b.id === Number(id); }), "box " + id + " listed"); });
	assert.ok(Math.abs(p.groundArea - counts[0] * 0.0004) <= 0.02 * p.groundArea, "ground area " + p.groundArea);
	assert.ok(counts[0] > 0.05 * n, "some ground shows");
});

test("the same seed gives the same cloud", function () {
	var a = rockPile(PILE), b = rockPile(PILE), c = rockPile(Object.assign({}, PILE, { seed: 2 }));
	assert.deepEqual(a.cols.z, b.cols.z);
	assert.deepEqual(a.truth, b.truth);
	assert.notDeepEqual(a.truth, c.truth);
});

test("given boxes are placed as given", function () {
	var p = rockPile({ boxes: [{ centre: [2, 2], size: [1, 1, 0.6], yaw: 0, tilt: 0 }], extent: 4, spacing: 0.02, noise: 0, seed: 1 });
	assert.equal(p.boxes.length, 1);
	var top = 0, cnt = 0;
	for (var i = 0; i < p.cols.count; i++) if (p.truth[i] === 1) { cnt++; top = Math.max(top, p.cols.z[i]); assert.ok(Math.abs(p.cols.x[i] - 2) <= 0.5 && Math.abs(p.cols.y[i] - 2) <= 0.5); }
	assert.ok(Math.abs(cnt * 0.0004 - 1) < 0.03, "a 1 x 1 top: " + cnt * 0.0004);
	assert.ok(Math.abs(top - 0.6) < 1e-9, "top at 0.6: " + top);
	// a bevel takes the +a top edge off: the top is narrower, the 45 degree face sampled over its area
	var b = rockPile({ boxes: [{ centre: [2, 2], size: [1, 1, 0.6], yaw: 0, tilt: 0, bevel: 0.2 }], extent: 4, spacing: 0.02, noise: 0, seed: 1 });
	var flat = 0, slope = 0;
	for (i = 0; i < b.cols.count; i++) if (b.truth[i] === 1) { if (b.cols.z[i] > 0.6 - 1e-9) flat++; else slope++; }
	assert.ok(Math.abs(flat * 0.0004 - 0.8) < 0.03 && Math.abs(slope * 0.0004 - 0.2 * Math.SQRT2) < 0.03, "flat " + flat + ", slope " + slope);
	// float32 about an origin: the same cloud less the origin, in Float32
	var f = rockPile(Object.assign({}, PILE, { float32: true, origin: [478000, 6772000, 300] }));
	var d = rockPile(PILE);
	assert.ok(f.cols.x instanceof Float32Array);
	assert.ok(Math.abs(f.cols.x[10] - d.cols.x[10]) < 1e-3);
	assert.deepEqual(f.truth, d.truth);
});

test("stray points are truth 0 and above the ground", function () {
	var p = rockPile(Object.assign({}, PILE, { stray: 0.01 })), d = rockPile(PILE);
	var extra = p.cols.count - d.cols.count;
	assert.ok(Math.abs(extra - 0.01 * d.cols.count) <= 1);
	for (var i = d.cols.count; i < p.cols.count; i++) assert.equal(p.truth[i], 0);
	assert.equal(p.groundArea, d.groundArea);
});
