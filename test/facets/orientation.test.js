// test/facets/orientation.test.js
//==========================================================
// Kirra's convention (dip 0-90, dip direction a bearing from north,
// clockwise) round the whole compass, a normal and its opposite giving
// the same answer, and Fisher statistics against hand-computed values.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { poleOf, orientationOf, poleFromOrientation, fisherStats, angleBetweenAxes } from "../../src/facets/orientation.js";
import * as lib from "../../src/index.js";

var D = Math.PI / 180;
function near(a, b, tol, what) { assert.ok(Math.abs(a - b) <= tol, what + ": " + a + " vs " + b); }
function bearingDiff(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

test("dip and dip direction follow Kirra's convention", function () {
	var o = orientationOf(poleFromOrientation(30, 90));
	near(o.dip, 30, 1e-9, "dip"); near(o.dipDirection, 90, 1e-9, "dip direction");
	o = orientationOf(poleFromOrientation(30, 0)); near(o.dip, 30, 1e-9, "dip"); assert.ok(bearingDiff(o.dipDirection, 0) < 1e-9);
	o = orientationOf(poleFromOrientation(45, 225)); near(o.dip, 45, 1e-9, "dip"); near(o.dipDirection, 225, 1e-9, "dip direction");
	o = orientationOf([0, 0, 1]); assert.equal(o.dip, 0); assert.equal(o.dipDirection, 0);
	o = orientationOf([0, 0, -1]); assert.equal(o.dip, 0); assert.equal(o.dipDirection, 0);
	o = orientationOf([1, 0, 0]); near(o.dip, 90, 1e-9, "dip"); near(o.dipDirection, 90, 1e-9, "east-facing vertical");
	o = orientationOf([-1, 0, 0]); near(o.dip, 90, 1e-9, "dip"); near(o.dipDirection, 90, 1e-9, "west-given vertical oriented east");
	// a plane dipping 30 degrees east: its up-pointing normal leans east
	var n = [Math.sin(30 * D), 0, Math.cos(30 * D)];
	o = orientationOf(n); near(o.dip, 30, 1e-9, "dip"); near(o.dipDirection, 90, 1e-9, "dip direction east");
	assert.deepEqual(poleOf([0, 0, -2]), [0, 0, 1]);
});

test("every dip direction round the compass", function () {
	[5, 45, 80, 89.9].forEach(function (dip) {
		for (var dd = 0; dd < 360; dd += 10) {
			var p = poleFromOrientation(dip, dd), o = orientationOf(p), q = orientationOf([-p[0], -p[1], -p[2]]);
			near(o.dip, dip, 1e-9, "dip " + dip + "/" + dd);
			assert.ok(bearingDiff(o.dipDirection, dd) < 1e-9, "dip direction " + dip + "/" + dd + " gave " + o.dipDirection);
			near(q.dip, o.dip, 1e-9, "opposite normal, dip");
			assert.ok(bearingDiff(q.dipDirection, o.dipDirection) < 1e-9, "opposite normal, dip direction");
			assert.ok(o.dipDirection >= 0 && o.dipDirection < 360);
		}
	});
	// 80 to 350 and 80 to 10 stay apart (not folded)
	near(orientationOf(poleFromOrientation(80, 350)).dipDirection, 350, 1e-9, "350");
	near(orientationOf(poleFromOrientation(80, 10)).dipDirection, 10, 1e-9, "10");
});

test("fisherStats against hand values", function () {
	var s5 = Math.sin(5 * D), c5 = Math.cos(5 * D);
	var f = fisherStats(Float64Array.from([0, 0, 1, s5, 0, c5, -s5, 0, c5]), null);
	var R = 1 + 2 * c5, K = 2 / (3 - R), cone = Math.acos(1 - (3 - R) / R * (Math.pow(20, 1 / 2) - 1)) / D;
	assert.equal(f.N, 3);
	near(f.R, R, 1e-12, "R"); near(f.fisherK, K, 1e-9 * K, "K"); near(f.cone95, cone, 1e-9, "cone95");
	near(f.normal[0], 0, 1e-12, "mean x"); near(f.normal[1], 0, 1e-12, "mean y"); near(f.normal[2], 1, 1e-12, "mean z");
	var one = fisherStats(Float64Array.from([0, 0, 1]), null);
	assert.ok(one.fisherK !== one.fisherK && one.cone95 !== one.cone95, "NaN for one pole");
	var w = fisherStats(Float64Array.from([0, 0, 1, s5, 0, c5, -s5, 0, c5]), Float64Array.from([2, 1, 1]));
	assert.equal(w.N, 3);
	var w2 = fisherStats(Float64Array.from([s5, 0, c5, 0, 0, 1, -s5, 0, c5]), Float64Array.from([4, 1, 1]));
	assert.ok(w2.normal[0] > 0, "weights pull the mean toward the heavier pole");
	near(w.normal[0], 0, 1e-12, "symmetric weights keep the mean");
});

test("axial: a pole and its opposite are one", function () {
	var f = fisherStats(Float64Array.from([0, 0, 1, 0, 0, -1]), null);
	near(Math.abs(f.normal[2]), 1, 1e-12, "mean on the axis");
	near(f.R, 2, 1e-12, "R");
	near(angleBetweenAxes([1, 0, 0], [-1, 0, 0]), 0, 1e-12, "opposite axes");
	near(angleBetweenAxes([1, 0, 0], [0, 1, 0]), 90, 1e-12, "perpendicular");
	near(angleBetweenAxes([1, 0, 0], [Math.cos(100 * D), Math.sin(100 * D), 0]), 80, 1e-9, "axial angle <= 90");
});

test("exports", function () {
	assert.equal(lib.poleOf, poleOf);
	assert.equal(lib.orientationOf, orientationOf);
	assert.equal(lib.poleFromOrientation, poleFromOrientation);
});

// identical poles: rounding can put R a hair above N; K must never be negative (it is Infinity),
// the cone 0
test("identical poles give K Infinity and a zero cone, never negative", function () {
	for (var t = 0; t < 2000; t++) {
		var dip = (t * 37.1) % 90, dd = (t * 91.7) % 360, p = poleFromOrientation(dip, dd), poles = [];
		for (var i = 0; i < 5; i++) poles.push(p[0], p[1], p[2]);
		var f = fisherStats(Float64Array.from(poles), null);
		assert.ok(!(f.fisherK < 0), "K " + f.fisherK + " at " + dip + "/" + dd);
		assert.ok(f.cone95 >= 0 && f.cone95 < 1e-4, "cone " + f.cone95);   // acos near 1: ~1e-6 degrees of rounding
	}
});
