// test/facets/findFacets.test.js
//==========================================================
// findFacets on planes of known orientation: 9 planes in 3 joint sets
// come back plane for plane (normal, dip / dip direction, points, area);
// a crest and a step split; hard inputs do not crash; Float32 local at
// a UTM origin equals Float64; reused normals; progress; linear growth;
// bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFacets } from "../../src/facets/findFacets.js";
import { angleBetweenAxes } from "../../src/facets/orientation.js";
import { pointNormals } from "../../src/ops/normals.js";
import * as lib from "../../src/index.js";
import { planesCloud } from "../helpers/planes.js";

var SETS = [[70, 135], [40, 300], [85, 30]];
function ninePlanes(extra) {
	var planes = [];
	SETS.forEach(function (s, i) {
		for (var j = 0; j < 3; j++) planes.push({ centre: [i * 12, j * 12, 0], dip: s[0], dipDirection: s[1], width: 6, height: 6 });
	});
	return planesCloud(Object.assign({ planes: planes, spacing: 0.05, noise: 0.005, stray: 0.01, seed: 3 }, extra || {}));
}
function bearingDiff(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
var NINE = ninePlanes(), NINE_F = findFacets(NINE.cols, { maxDistance: 0.2 });

test("known planes come back plane for plane", function () {
	var f = NINE_F, t = NINE.truth;
	assert.equal(f.facets.length, 9);
	for (var i = 1; i < f.facets.length; i++) assert.ok(f.facets[i - 1].area >= f.facets[i].area, "ids by area");
	f.facets.forEach(function (x, i) { assert.equal(x.id, i + 1); });
	for (var p = 1; p <= 9; p++) {
		var counts = {}, total = 0;
		for (var k = 0; k < t.length; k++) if (t[k] === p) { total++; counts[f.facet[k]] = (counts[f.facet[k]] || 0) + 1; }
		var best = Object.keys(counts).filter(function (id) { return id !== "0"; }).sort(function (a, b) { return counts[b] - counts[a]; })[0];
		assert.ok(counts[best] >= 0.95 * total, "plane " + p + ": " + counts[best] + " of " + total);
		var fc = f.facets[best - 1], s = SETS[Math.floor((p - 1) / 3)];
		assert.ok(angleBetweenAxes(fc.normal, NINE.normals[p - 1]) < 1, "normal within 1 degree");
		assert.ok(Math.abs(fc.dip - s[0]) < 0.5, "dip " + fc.dip + " vs " + s[0]);
		assert.ok(bearingDiff(fc.dipDirection, s[1]) < 0.5, "dip direction " + fc.dipDirection + " vs " + s[1]);
		assert.ok(Math.abs(fc.area - 36) <= 0.05 * 36, "area " + fc.area);
		assert.ok(fc.rms > 0 && fc.rms < 0.02, "rms " + fc.rms);
		assert.ok(fc.outline instanceof Float64Array && fc.outline.length >= 12);
		// a few stray points lying on the plane may join it
		assert.ok(fc.count >= counts[best] && fc.count <= 1.01 * counts[best], "count " + fc.count + " vs " + counts[best]);
	}
	var stray = 0, strayZero = 0;
	for (k = 0; k < t.length; k++) if (t[k] === 0) { stray++; if (f.facet[k] === 0) strayZero++; }
	assert.ok(strayZero >= 0.9 * stray, "stray points left out: " + strayZero + " of " + stray);
	assert.ok(f.planeDistance > 0 && f.planeDistance < 0.05, "measured plane distance " + f.planeDistance);
	assert.equal(lib.findFacets, findFacets);
});

test("a crest splits two facets", function () {
	// a floor (z 0, x < 0) and a face dipping 70 degrees east from the crest line x = 0
	var x = [], y = [], z = [], side = [];
	for (var a = -8; a < 0; a += 0.05) for (var b = 0; b < 8; b += 0.05) { x.push(a); y.push(b); z.push(0); side.push(1); }
	for (var d = 0.025; d < 8; d += 0.05) for (b = 0; b < 8; b += 0.05) { x.push(d * Math.cos(70 * Math.PI / 180)); y.push(b); z.push(-d * Math.sin(70 * Math.PI / 180)); side.push(2); }
	var cols = { count: x.length, x: Float64Array.from(x), y: Float64Array.from(y), z: Float64Array.from(z) };
	var f = findFacets(cols, { maxDistance: 0.2, planeDistance: 0.01 });
	assert.equal(f.facets.length, 2);
	[1, 2].forEach(function (s) {
		var counts = {}, total = 0;
		for (var k = 0; k < side.length; k++) if (side[k] === s) { total++; counts[f.facet[k]] = (counts[f.facet[k]] || 0) + 1; }
		var best = Math.max.apply(null, Object.keys(counts).filter(function (id) { return id !== "0"; }).map(function (id) { return counts[id]; }));
		assert.ok(best >= 0.95 * total, "side " + s + ": " + best + " of " + total);
	});
});

test("a step: two parallel planes 0.5 m apart are two facets", function () {
	var c = planesCloud({ planes: [{ centre: [-4, 0, 0], dip: 0, dipDirection: 0, width: 8, height: 8 }, { centre: [4, 0, 0.5], dip: 0, dipDirection: 0, width: 8, height: 8 }], spacing: 0.1, noise: 0.005, seed: 5 });
	var f = findFacets(c.cols, { maxDistance: 1.0 });
	assert.equal(f.facets.length, 2);
});

test("hard inputs do not crash", function () {
	function ok(cols, opts) {
		var f = findFacets(cols, opts);
		for (var i = 0; i < f.facet.length; i++) assert.ok(f.facet[i] <= f.facets.length);
		f.facets.forEach(function (x) { x.normal.concat(x.centroid, [x.dip, x.dipDirection, x.area, x.rms]).forEach(function (v) { assert.ok(isFinite(v), "finite"); }); });
		return f;
	}
	var dup = { count: 1000, x: new Float64Array(1000).fill(5), y: new Float64Array(1000).fill(5), z: new Float64Array(1000).fill(5) };
	assert.equal(ok(dup, { maxDistance: 0.2 }).facets.length, 0);
	var line = { count: 400, x: Float64Array.from({ length: 400 }, function (_, i) { return i * 0.01; }), y: new Float64Array(400), z: new Float64Array(400) };
	assert.equal(ok(line, { maxDistance: 0.2 }).facets.length, 0);
	var sparse = planesCloud({ planes: [{ centre: [0, 0, 0], dip: 30, dipDirection: 45, width: 25, height: 20 }], spacing: 1, seed: 2 });
	assert.equal(ok(sparse.cols, { maxDistance: 0.2 }).facets.length, 0);
	var empty = findFacets({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }, { maxDistance: 0.2 });
	assert.equal(empty.facets.length, 0); assert.equal(empty.facet.length, 0);
});

test("Float32 local at a UTM origin equals Float64 at the origin", function () {
	var O = [478000, 6772000, 300];
	var planes = [];
	SETS.forEach(function (s, i) { planes.push({ centre: [O[0] + i * 12, O[1], O[2]], dip: s[0], dipDirection: s[1], width: 6, height: 6 }); });
	var a = planesCloud({ planes: planes.map(function (p) { return Object.assign({}, p, { centre: [p.centre[0] - O[0], p.centre[1] - O[1], p.centre[2] - O[2]] }); }), spacing: 0.05, noise: 0.005, seed: 9 });
	var b = planesCloud({ planes: planes, spacing: 0.05, noise: 0.005, seed: 9, float32: true, origin: O });
	var fa = findFacets(a.cols, { maxDistance: 0.2 }), fb = findFacets(b.cols, { maxDistance: 0.2 });
	assert.equal(fb.facets.length, fa.facets.length);
	fa.facets.forEach(function (x, i) {
		assert.ok(angleBetweenAxes(x.normal, fb.facets[i].normal) < 1e-4, "normals agree");   // 1e-6 rad
		assert.ok(Math.abs(x.area - fb.facets[i].area) <= 0.001 * x.area, "areas agree");
	});
});

test("reused normals give the same facets", function () {
	var n = pointNormals(NINE.cols, { k: 16, maxDistance: 0.2 });
	var f = findFacets(NINE.cols, { maxDistance: 0.2, normals: n });
	assert.deepEqual(f.facet, NINE_F.facet);
});

test("onProgress", function () {
	var c = planesCloud({ planes: [{ centre: [0, 0, 0], dip: 20, dipDirection: 10, width: 5, height: 5 }], spacing: 0.05, noise: 0.003, seed: 4 });
	var calls = [];
	findFacets(c.cols, { maxDistance: 0.2, onProgress: function (d, t) { calls.push([d, t]); } });
	assert.ok(calls.length > 1);
	var last = calls[calls.length - 1];
	assert.equal(last[0], last[1]);
});

test("growth stays linear", { skip: !!process.env.NODE_V8_COVERAGE }, function () {
	function time(side) {
		var c = planesCloud({ planes: [{ centre: [0, 0, 0], dip: 5, dipDirection: 200, width: side, height: side }], spacing: 0.05, noise: 0.003, seed: 6 });
		var n = pointNormals(c.cols, { k: 16, maxDistance: 0.2 });
		var t0 = performance.now(), f = findFacets(c.cols, { maxDistance: 0.2, normals: n });
		assert.equal(f.facets.length, 1);
		return performance.now() - t0;
	}
	var small = time(25), big = time(50);   // 250,000 and 1,000,000 points
	assert.ok(big / small < 6, "4x the points took " + (big / small).toFixed(1) + "x the time");
});

test("bad options are refused, naming them", function () {
	var c = NINE.cols;
	assert.throws(function () { findFacets(c, {}); }, /maxDistance is required/);
	[0, 90, "10"].forEach(function (v) { assert.throws(function () { findFacets(c, { maxDistance: 0.2, maxAngle: v }); }, /maxAngle/); });
	assert.throws(function () { findFacets(c, { maxDistance: 0.2, planeDistance: 0 }); }, /planeDistance/);
	assert.throws(function () { findFacets(c, { maxDistance: 0.2, minArea: -1 }); }, /minArea/);
	assert.throws(function () { findFacets(c, { maxDistance: 0.2, minPoints: 2 }); }, /minPoints/);
	assert.throws(function () { findFacets(c, { maxDistance: 0.2, k: 2 }); }, /k/);
	assert.throws(function () { findFacets(c, { maxDistance: 0.2, outlineCell: 0 }); }, /outlineCell/);
	assert.throws(function () { findFacets(c, { maxDistance: 0.2, normals: { normal: new Float32Array(3) } }); }, /normals/);
	assert.throws(function () { findFacets(c, null); }, /options/);
});
