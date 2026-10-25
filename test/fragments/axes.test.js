// test/fragments/axes.test.js
//==========================================================
// fragmentAxes: the surface of a turned 4 x 2 x 1 box gives spans
// 4, 2, 1 along vectors that follow the turn; one point and a line of
// points give zeros, never NaN.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fragmentAxes } from "../../src/fragments/axes.js";
import { angleBetweenAxes } from "../../src/facets/orientation.js";

// rotation: yaw 30 degrees about z after a 20 degree tilt about y
var cy = Math.cos(30 * Math.PI / 180), sy = Math.sin(30 * Math.PI / 180), ct = Math.cos(20 * Math.PI / 180), st = Math.sin(20 * Math.PI / 180);
var R = [[cy * ct, -sy, cy * st], [sy * ct, cy, sy * st], [-st, 0, ct]];
function turn(p) { return [R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + 5, R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] - 3, R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + 2]; }

function boxSurface(a, b, c, s) {
	var pts = [], h = [a / 2, b / 2, c / 2];
	for (var ax = 0; ax < 3; ax++) {
		var u = (ax + 1) % 3, v = (ax + 2) % 3;
		for (var side = -1; side <= 1; side += 2)
			for (var i = -h[u] + s / 2; i < h[u]; i += s) for (var j = -h[v] + s / 2; j < h[v]; j += s) {
				var p = [0, 0, 0]; p[ax] = side * h[ax]; p[u] = i; p[v] = j;
				pts.push(turn(p));
			}
	}
	return pts;
}
function columns(pts) {
	var n = pts.length, x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), idx = new Uint32Array(n);
	for (var i = 0; i < n; i++) { x[i] = pts[i][0]; y[i] = pts[i][1]; z[i] = pts[i][2]; idx[i] = i; }
	return { x: x, y: y, z: z, idx: idx };
}

test("a box's surface gives its spans", function () {
	var c = columns(boxSurface(4, 2, 1, 0.02)), r = fragmentAxes(c.x, c.y, c.z, 1, c.idx);
	[4, 2, 1].forEach(function (want, k) { assert.ok(Math.abs(r.axes[k] - want) <= 0.02 * want, "axis " + k + ": " + r.axes[k]); });
	for (var k = 0; k < 3; k++) {
		var truth = [R[0][k], R[1][k], R[2][k]];
		assert.ok(angleBetweenAxes(r.vectors[k], truth) < 1, "vector " + k);
	}
	assert.ok(angleBetweenAxes(r.smallest, [R[0][2], R[1][2], R[2][2]]) < 1, "smallest");
	[5, -3, 2].forEach(function (want, d) { assert.ok(Math.abs(r.centroid[d] - want) < 0.01, "centroid " + d); });
	// a stride-3 positions column gives the same
	var P = new Float64Array(3 * c.x.length);
	for (var i = 0; i < c.x.length; i++) { P[3 * i] = c.x[i]; P[3 * i + 1] = c.y[i]; P[3 * i + 2] = c.z[i]; }
	var r3 = fragmentAxes(P, P.subarray(1), P.subarray(2), 3, c.idx);
	assert.deepEqual(r3.axes, r.axes);
});

test("one point or one line", function () {
	var one = columns([[1, 2, 3]]), r = fragmentAxes(one.x, one.y, one.z, 1, one.idx);
	assert.deepEqual(r.axes, [0, 0, 0]);
	assert.deepEqual(r.centroid, [1, 2, 3]);
	assert.ok(r.vectors.every(function (v) { return v.every(Number.isFinite); }) && r.smallest.every(Number.isFinite));
	var pts = [];
	for (var i = 0; i <= 100; i++) pts.push([i * 0.03, 0, 0]);
	var line = columns(pts), l = fragmentAxes(line.x, line.y, line.z, 1, line.idx);
	assert.ok(Math.abs(l.axes[0] - 0.03 * 96) < 1e-9, "the 2nd-98th percentile span " + l.axes[0]);
	assert.ok(l.axes[1] < 1e-12 && l.axes[2] < 1e-12);
	var none = fragmentAxes(line.x, line.y, line.z, 1, new Uint32Array(0));
	assert.deepEqual(none.axes, [0, 0, 0]);
});
