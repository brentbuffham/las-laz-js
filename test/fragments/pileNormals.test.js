// test/fragments/pileNormals.test.js
//==========================================================
// pileNormals on surfaces of known shape: a tilted plane faces up, a
// dome faces out everywhere, a wall faces the viewpoint (or one way
// throughout without one), separate patches each start again, sparse
// cells take their parent's normal, and every point maps to a cell
// whose centroid is the mean of its points.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pileNormals } from "../../src/fragments/pileNormals.js";
import { poleFromOrientation, angleBetweenAxes } from "../../src/facets/orientation.js";
import { planeBasis } from "../helpers/planes.js";

function cloud(pts) {
	var n = pts.length / 3, x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
	for (var i = 0; i < n; i++) { x[i] = pts[3 * i]; y[i] = pts[3 * i + 1]; z[i] = pts[3 * i + 2]; }
	return { count: n, x: x, y: y, z: z };
}
// a w x h rectangle about centre on the plane of normal nrm, on a grid of spacing s
function rect(out, centre, nrm, w, h, s) {
	var b = planeBasis(nrm);
	for (var a = -w / 2 + s / 2; a < w / 2; a += s) for (var c = -h / 2 + s / 2; c < h / 2; c += s)
		out.push(centre[0] + a * b.u[0] + c * b.v[0], centre[1] + a * b.u[1] + c * b.v[1], centre[2] + a * b.u[2] + c * b.v[2]);
	return out;
}
function normalOf(r, c) { return [r.normal[3 * c], r.normal[3 * c + 1], r.normal[3 * c + 2]]; }
function angle(a, b) { return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI; }

test("a tilted plane faces up", function () {
	var pole = poleFromOrientation(30, 120), r = pileNormals(cloud(rect([], [0, 0, 0], pole, 40, 40, 0.1)), { cellSize: 2 });
	assert.ok(r.cells > 100);
	for (var c = 0; c < r.cells; c++) {
		var nc = normalOf(r, c);
		assert.ok(angle(nc, pole) < 1, "cell " + c + ": " + angle(nc, pole) + " degrees");
	}
});

test("a dome faces out everywhere", function () {
	var pts = [], R = 20;
	for (var t = 0.1; t < 90; t += 0.6) {
		var ring = Math.max(1, Math.round(2 * Math.PI * R * Math.cos(t * Math.PI / 180) / 0.2));
		for (var k = 0; k < ring; k++) {
			var ph = 2 * Math.PI * k / ring, ct = Math.cos(t * Math.PI / 180);
			pts.push(R * ct * Math.cos(ph), R * ct * Math.sin(ph), R * Math.sin(t * Math.PI / 180));
		}
	}
	var r = pileNormals(cloud(pts), { cellSize: 2 });
	for (var c = 0; c < r.cells; c++) {
		var nc = normalOf(r, c), out = [r.centroid[3 * c], r.centroid[3 * c + 1], r.centroid[3 * c + 2]];
		assert.ok(nc[0] * out[0] + nc[1] * out[1] + nc[2] * out[2] > 0, "cell " + c + " faces in");
	}
});

test("a wall faces the viewpoint", function () {
	var c0 = cloud(rect([], [0, 15, 5], [1, 0, 0], 30, 10, 0.1)), c;
	var r = pileNormals(c0, { cellSize: 2, viewpoint: [10, 0, 5] });
	for (c = 0; c < r.cells; c++) assert.ok(angle(normalOf(r, c), [1, 0, 0]) < 2, "toward +x");
	r = pileNormals(c0, { cellSize: 2, viewpoint: [-10, 0, 5] });
	for (c = 0; c < r.cells; c++) assert.ok(angle(normalOf(r, c), [-1, 0, 0]) < 2, "toward -x");
	r = pileNormals(c0, { cellSize: 2 });
	var sign = Math.sign(r.normal[0]);
	assert.ok(sign !== 0);
	for (c = 0; c < r.cells; c++) assert.ok(Math.sign(r.normal[3 * c]) === sign && Math.abs(r.normal[3 * c]) > 0.999, "one way throughout");
});

test("two separate patches each start again", function () {
	var pts = rect([], [0, 0, 0], [0, 0, 1], 10, 10, 0.1);
	rect(pts, [50, 0, 3], poleFromOrientation(20, 45), 10, 10, 0.1);
	var r = pileNormals(cloud(pts), { cellSize: 2 });
	for (var c = 0; c < r.cells; c++) assert.ok(r.normal[3 * c + 2] > 0.9, "cell " + c + " faces up");
});

test("sparse cells take their parent's normal", function () {
	// a 20 x 20 m plane on cells 0 ... 9 and a 0.5 m patch in cell (10, 10), diagonally beyond its corner
	var pts = [];
	for (var a = 0.05; a < 20; a += 0.1) for (var b = 0.05; b < 20; b += 0.1) pts.push(a, b, 0.002 * a);
	for (a = 20.55; a < 21; a += 0.1) for (b = 20.55; b < 21; b += 0.1) pts.push(a, b, 0.002 * a);
	var cols = cloud(pts), r = pileNormals(cols, { cellSize: 2 });
	var patch = r.cellOf[cols.count - 1], corner = -1;
	for (var i = 0; i < cols.count; i++) if (cols.x[i] > 19 && cols.x[i] < 20 && cols.y[i] > 19 && cols.y[i] < 20) { corner = r.cellOf[i]; break; }
	assert.ok(patch !== corner && corner >= 0);
	assert.deepEqual(normalOf(r, patch), normalOf(r, corner));
	var two = pileNormals(cloud([0, 0, 0, 100, 100, 0]), { cellSize: 2 });
	assert.ok(two.cells >= 1 && two.cells <= 2);
	for (var c = 0; c < two.cells; c++) assert.deepEqual(normalOf(two, c), [0, 0, 1]);
	var none = pileNormals({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }, { cellSize: 2 });
	assert.equal(none.cells, 0);
	assert.equal(none.cellOf.length, 0);
});

test("a tall rock on flat ground keeps the pile facing out", function () {
	// a 2 x 1.4 x 1 m block on a 12 x 12 m floor, seen from above (top and floor only), cells 0.6 m:
	// a step taller than a cell - every cell's normal faces up (z > 0)
	var pts = [];
	for (var x = 0.01; x < 12; x += 0.02) for (var y = 0.01; y < 12; y += 0.02) pts.push(x, y, x > 5 && x < 7 && y > 5 && y < 6.4 ? 1 : 0);
	var r = pileNormals(cloud(pts), { cellSize: 0.6 });
	for (var c = 0; c < r.cells; c++) assert.ok(r.normal[3 * c + 2] > 0, "cell " + c + " faces down: " + normalOf(r, c).map(function (v) { return v.toFixed(2); }));
});

test("cellOf maps every point", function () {
	var cols = cloud(rect([], [3, 4, 5], poleFromOrientation(50, 200), 12, 9, 0.1)), r = pileNormals(cols, { cellSize: 2 });
	var sum = new Float64Array(3 * r.cells), cnt = new Float64Array(r.cells);
	for (var i = 0; i < cols.count; i++) {
		var c = r.cellOf[i];
		assert.ok(c < r.cells);
		sum[3 * c] += cols.x[i]; sum[3 * c + 1] += cols.y[i]; sum[3 * c + 2] += cols.z[i]; cnt[c]++;
	}
	for (c = 0; c < r.cells; c++) {
		assert.ok(cnt[c] > 0);
		for (var d = 0; d < 3; d++) assert.ok(Math.abs(sum[3 * c + d] / cnt[c] - r.centroid[3 * c + d]) < 1e-9);
		assert.ok(Math.abs(Math.hypot.apply(null, normalOf(r, c)) - 1) < 1e-12);
	}
	assert.ok(angleBetweenAxes(normalOf(r, 0), poleFromOrientation(50, 200)) < 1);
});
