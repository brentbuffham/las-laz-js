// test/ops/sparse.test.js
//==========================================================
// selectSparse: the points with fewer than minNeighbours other
// points within radius (inclusive), against a brute-force count;
// plus the cases it exists for — a lone dust point above a bench,
// and a scanned blasthole that must survive at minNeighbours 1.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSparse } from "../../src/ops/sparse.js";
import * as lib from "../../src/index.js";
import { randomCloud, pointReader, rng } from "../helpers/clouds.js";

function bruteSparse(cols, radius, minN, xy) {
	var at = pointReader(cols), out = [], r2 = radius * radius, pts = [];
	for (var i = 0; i < cols.count; i++) pts.push(at(i));
	for (i = 0; i < cols.count; i++) {
		var k = 0;
		for (var j = 0; j < cols.count && k < minN; j++) {
			if (j === i) continue;
			var dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], dz = xy ? 0 : pts[i][2] - pts[j][2];
			if (dx * dx + dy * dy + dz * dz <= r2) k++;
		}
		if (k < minN) out.push(i);
	}
	return out;
}
function cols3(xs, ys, zs) {
	var n = xs.length;
	return { count: n, x: Float64Array.from(xs), y: ys ? Float64Array.from(ys) : new Float64Array(n), z: zs ? Float64Array.from(zs) : new Float64Array(n) };
}
function bench(nx, spacing) {
	var xs = [], ys = [], zs = [];
	for (var i = 0; i < nx; i++) for (var j = 0; j < nx; j++) { xs.push(i * spacing); ys.push(j * spacing); zs.push(0); }
	return { xs: xs, ys: ys, zs: zs };
}

test("selectSparse is exported from the package", function () {
	assert.equal(lib.selectSparse, selectSparse);
});

test("selectSparse equals a brute-force neighbour count", function () {
	var seed = 1, flagged = 0;
	["uniform", "clustered", "plane"].forEach(function (kind) {
		[false, true].forEach(function (f32) {
			var cols = randomCloud(1500, { seed: seed++, kind: kind, float32: f32, positions: f32 });
			[0.5, 2, 5].forEach(function (radius) {
				[1, 3, 8].forEach(function (minN) {
					[false, true].forEach(function (xy) {
						var want = bruteSparse(cols, radius, minN, xy);
						flagged += want.length;
						assert.deepEqual(Array.from(selectSparse(cols, { radius: radius, minNeighbours: minN, xy: xy })), want, kind + " f32=" + f32 + " r=" + radius + " k=" + minN + " xy=" + xy);
					});
				});
			});
		});
	});
	assert.ok(flagged > 100);
});

test("one lone point among a dense patch is the only one flagged", function () {
	var b = bench(20, 0.5);
	b.xs.push(5); b.ys.push(5); b.zs.push(30);
	var s = selectSparse(cols3(b.xs, b.ys, b.zs), { radius: 2 });
	assert.ok(s instanceof Uint32Array);
	assert.deepEqual(Array.from(s), [400]);
});

test("a scanned blasthole survives at minNeighbours 1 and is flagged at 3", function () {
	var b = bench(40, 0.5), hole = [];
	for (var i = 1; i <= 8; i++) { hole.push(b.xs.length); b.xs.push(10.25); b.ys.push(10.25); b.zs.push(-1.5 * i); }
	var c = cols3(b.xs, b.ys, b.zs);
	assert.deepEqual(Array.from(selectSparse(c, { radius: 2, minNeighbours: 1 })), []);
	var at3 = Array.from(selectSparse(c, { radius: 2, minNeighbours: 3 }));
	assert.ok(at3.indexOf(hole[7]) >= 0, "the hole's bottom point is flagged at 3");
	at3.forEach(function (p) { assert.ok(hole.indexOf(p) >= 0, "only hole points are flagged"); });
});

test("points exactly at the radius count; coincident points are each other's neighbours", function () {
	assert.deepEqual(Array.from(selectSparse(cols3([0, 2, 10, 10]), { radius: 2 })), []);
	assert.deepEqual(Array.from(selectSparse(cols3([0, 2.0001, 10, 10]), { radius: 2 })), [0, 1]);
});

test("xy counts in 2D", function () {
	var c = cols3([0, 0], [0, 0], [0, 50]);
	assert.deepEqual(Array.from(selectSparse(c, { radius: 2 })), [0, 1]);
	assert.deepEqual(Array.from(selectSparse(c, { radius: 2, xy: true })), []);
});

test("count 0 gives an empty selection; one point is sparse", function () {
	assert.equal(selectSparse(cols3([]), { radius: 1 }).length, 0);
	assert.deepEqual(Array.from(selectSparse(cols3([4]), { radius: 1 })), [0]);
});

test("bad arguments are refused, naming the argument", function () {
	var c = cols3([0, 1]);
	assert.throws(function () { selectSparse(c); }, { code: "INVALID_ARGUMENT", message: /radius/ });
	assert.throws(function () { selectSparse(c, {}); }, { message: /radius/ });
	assert.throws(function () { selectSparse(c, { radius: 0 }); }, { message: /radius/ });
	assert.throws(function () { selectSparse(c, { radius: NaN }); }, { message: /radius/ });
	assert.throws(function () { selectSparse(c, { radius: 1, minNeighbours: 0 }); }, { message: /minNeighbours/ });
	assert.throws(function () { selectSparse(c, { radius: 1, minNeighbours: 1.5 }); }, { message: /minNeighbours/ });
	assert.throws(function () { selectSparse({ count: 2, x: new Float64Array(2) }, { radius: 1 }); }, { message: /selectSparse needs x, y, z/ });
});

test("points on cell faces (quantised coordinates) stay fast in dense cells", function () {
	// 300 000 points in a 6 m cube on a 1 cm grid: 1.5 % sit exactly on a 2 m cell face and
	// take the face path; scanning a far 11 000-point cell first made this ~25× slower
	var r = rng(41), n = 300000, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = Math.round(r() * 600) / 100; c.y[i] = Math.round(r() * 600) / 100; c.z[i] = Math.round(r() * 600) / 100; }
	c.x[0] = 0; c.y[0] = 0; c.z[0] = 0;
	var t = performance.now();
	assert.equal(selectSparse(c, { radius: 2 }).length, 0);
	var ms = performance.now() - t;
	if (!(process.env.NODE_V8_COVERAGE || process.env.CI)) assert.ok(ms < 200, "took " + Math.round(ms) + " ms");
});
