// test/ops/polygon.test.js
//==========================================================
// selectPolygon on a hand-made "U" (a concave polygon with a notch),
// every expected index worked by hand; the 0.25 m grid check against
// independent predicates; and crop on read = selectPolygon after a
// full read, on every LAZ fixture and a built LAS.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPolygon, thinSelection, subtractSelections, intersectSelections } from "../../src/ops/select.js";
import * as lib from "../../src/index.js";
import { makePolygonTest } from "../../src/ops/polygon.js";
import { openLas } from "../../src/LasReader.js";
import { buildLas } from "../helpers/buildLas.js";
import { LAZ_MANIFEST, fixtureBytes } from "../helpers/lazFixtureFiles.js";

// U: arms x in [0,1] and [2,3] up to y = 3, base y in [0,1], notch x in (1,2), y in (1,3)
var U = [0, 0, 3, 0, 3, 3, 2, 3, 2, 1, 1, 1, 1, 3, 0, 3];

// 0 (0.5, 0.5) base: inside        5 (1.5, 1)    on the notch floor: boundary
// 1 (1.5, 2)   notch: out          6 (3, 1.5)    on the right edge: boundary
// 2 (1.5, 0.5) base: inside        7 (3.01, 1.5) 0.01 right of the edge: out
// 3 (2.5, 2.5) right arm: inside   8 (-1, -1)    out
// 4 (0, 0)     vertex: boundary    9 (1.5, 1.004) 0.004 above the floor: in the notch, out
var P = [[0.5, 0.5], [1.5, 2], [1.5, 0.5], [2.5, 2.5], [0, 0], [1.5, 1], [3, 1.5], [3.01, 1.5], [-1, -1], [1.5, 1.004]];
var cloud = {
	count: P.length,
	x: Float64Array.from(P.map(function (p) { return p[0]; })),
	y: Float64Array.from(P.map(function (p) { return p[1]; })),
	z: Float64Array.from(P.map(function (p, i) { return i; }))
};

function list(sel) { return Array.from(sel); }

test("touching keeps interior, vertex and edge points; the notch is out", function () {
	assert.deepEqual(list(selectPolygon(cloud, U)), [0, 2, 3, 4, 5, 6]);
	assert.deepEqual(list(selectPolygon(cloud, U, { boundary: "touching" })), [0, 2, 3, 4, 5, 6]);
});
test("inside drops exactly the vertex and edge points", function () {
	assert.deepEqual(list(selectPolygon(cloud, U, { boundary: "inside" })), [0, 2, 3]);
});
test("tolerance makes near-edge points boundary points", function () {
	assert.deepEqual(list(selectPolygon(cloud, U, { tolerance: 0.02 })), [0, 2, 3, 4, 5, 6, 7, 9]);
	assert.deepEqual(list(selectPolygon(cloud, U, { boundary: "inside", tolerance: 0.02 })), [0, 2, 3]);
	// 0.004 is not within 0.003 of the floor; 0.01 is not within 0.005 of the right edge
	assert.deepEqual(list(selectPolygon(cloud, U, { tolerance: 0.003 })), [0, 2, 3, 4, 5, 6]);
	assert.deepEqual(list(selectPolygon(cloud, U, { tolerance: 0.005 })), [0, 2, 3, 4, 5, 6, 9]);
});
test("a closed ring (first vertex repeated) gives the open ring's answer", function () {
	var closed = U.concat([0, 0]);
	assert.deepEqual(list(selectPolygon(cloud, closed)), list(selectPolygon(cloud, U)));
	assert.deepEqual(list(selectPolygon(cloud, closed, { boundary: "inside" })), list(selectPolygon(cloud, U, { boundary: "inside" })));
});
test("a typed-array polygon works like an Array", function () {
	assert.deepEqual(list(selectPolygon(cloud, Float64Array.from(U))), [0, 2, 3, 4, 5, 6]);
});

// 0.25 m grid over U, -0.5..3.5: 17 x 17 points, index = ix * 17 + iy
var grid = (function () {
	var xs = [], ys = [];
	for (var ix = 0; ix < 17; ix++) for (var iy = 0; iy < 17; iy++) { xs.push(-0.5 + ix * 0.25); ys.push(-0.5 + iy * 0.25); }
	return { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys) };
})();
function allOf(cols) { var a = new Uint32Array(cols.count); for (var i = 0; i < a.length; i++) a[i] = i; return a; }

// U's 8 axis-aligned edges as [axis, fixed, lo, hi]: a point is on one when it matches exactly
var EDGES = [["y", 0, 0, 3], ["x", 3, 0, 3], ["y", 3, 2, 3], ["x", 2, 1, 3], ["y", 1, 1, 2], ["x", 1, 1, 3], ["y", 3, 0, 1], ["x", 0, 0, 3]];
function onEdge(x, y) {
	return EDGES.some(function (e) {
		var fixed = e[0] === "x" ? x : y, along = e[0] === "x" ? y : x;
		return fixed === e[1] && along >= e[2] && along <= e[3];
	});
}
// strictly inside: in one of three open rectangles (left arm, right arm, base)
function strictlyInside(x, y) {
	return (x > 0 && x < 1 && y > 0 && y < 3) || (x > 2 && x < 3 && y > 0 && y < 3) || (x > 0 && x < 3 && y > 0 && y < 1);
}

test("on a 0.25 m grid, touching minus inside is exactly the points on an edge", function () {
	var touching = selectPolygon(grid, U), inside = selectPolygon(grid, U, { boundary: "inside" });
	var expectedBoundary = [], expectedInside = [];
	for (var i = 0; i < grid.count; i++) {
		if (onEdge(grid.x[i], grid.y[i])) expectedBoundary.push(i);
		if (strictlyInside(grid.x[i], grid.y[i])) expectedInside.push(i);
	}
	assert.ok(expectedBoundary.length > 30 && expectedInside.length > 30);
	assert.deepEqual(list(subtractSelections(touching, inside)), expectedBoundary);
	assert.deepEqual(list(inside), expectedInside);
	assert.equal(intersectSelections(touching, inside).length, inside.length);   // inside is a subset of touching
});
test("split by a polygon loses and duplicates nothing", function () {
	[undefined, { boundary: "inside" }, { tolerance: 0.1 }].forEach(function (o) {
		var inside = selectPolygon(grid, U, o), out = subtractSelections(allOf(grid), inside);
		assert.equal(inside.length + out.length, grid.count);
		assert.equal(intersectSelections(inside, out).length, 0);
	});
});
test("Z limits", function () {
	// z = index; touching = [0, 2, 3, 4, 5, 6]
	assert.deepEqual(list(selectPolygon(cloud, U, { minZ: 3, maxZ: 5 })), [3, 4, 5]);
	assert.deepEqual(list(selectPolygon(cloud, U, { minZ: 4 })), [4, 5, 6]);
	assert.deepEqual(list(selectPolygon(cloud, U, { maxZ: 2 })), [0, 2]);
	assert.deepEqual(list(selectPolygon(cloud, U, { boundary: "inside", minZ: 2, maxZ: 3 })), [2, 3]);
	assert.deepEqual(list(selectPolygon(cloud, U, { minZ: 7 })), []);
	assert.throws(function () { selectPolygon({ count: 1, x: new Float64Array(1), y: new Float64Array(1) }, U, { minZ: 0 }); }, /needs a z column/);
	assert.throws(function () { selectPolygon(cloud, U, { minZ: NaN }); }, /minZ/);
	// z is not needed without a Z limit
	assert.deepEqual(list(selectPolygon({ count: 1, x: Float64Array.of(0.5), y: Float64Array.of(0.5) }, U)), [0]);
});
test("a diagonal edge: a point exactly on it is on the boundary", function () {
	var tri = [0, 0, 4, 0, 0, 4];   // hypotenuse x + y = 4
	var c = { count: 2, x: new Float64Array([1, 1]), y: new Float64Array([3, 2.999]) };
	assert.deepEqual(list(selectPolygon(c, tri, { boundary: "inside" })), [1]);
	assert.deepEqual(list(selectPolygon(c, tri)), [0, 1]);
});
test("a diagonal edge with tolerance: distance is to the segment, not the line", function () {
	var tri = [0, 0, 4, 0, 0, 4];
	// (1, 3.1) is 0.1 / sqrt(2) = 0.0707 from the hypotenuse; (5, -1) is on its line but 1.414 from the segment end (4, 0)
	var c = { count: 2, x: Float64Array.of(1, 5), y: Float64Array.of(3.1, -1) };
	assert.deepEqual(list(selectPolygon(c, tri, { tolerance: 0.08 })), [0]);
	assert.deepEqual(list(selectPolygon(c, tri, { tolerance: 0.07 })), []);
	assert.deepEqual(list(selectPolygon(c, tri, { tolerance: 1.5 })), [0, 1]);
});
test("a zero-length edge (a repeated vertex) is a point", function () {
	var dup = [0, 0, 3, 0, 3, 0, 3, 3, 0, 3];
	var c = { count: 3, x: Float64Array.of(3, 1.5, 3.1), y: Float64Array.of(0, 1.5, 0) };
	assert.deepEqual(list(selectPolygon(c, dup)), [0, 1]);
	assert.deepEqual(list(selectPolygon(c, dup, { boundary: "inside" })), [1]);
	assert.deepEqual(list(selectPolygon(c, dup, { tolerance: 0.2 })), [0, 1, 2]);
});
test("count 0 and nothing inside", function () {
	assert.equal(selectPolygon({ count: 0, x: new Float64Array(0), y: new Float64Array(0) }, U).length, 0);
	assert.equal(selectPolygon(cloud, [10, 10, 11, 10, 10, 11]).length, 0);
});
test("selectPolygon needs x and y", function () {
	assert.throws(function () { selectPolygon({ count: 1, x: new Float64Array(1) }, U); }, /needs a y column/);
});
test("bad polygons and options throw", function () {
	[[0, 0, 1, 0], [0, 0, 1, 0, 1], [0, 0, 1, NaN, 1, 1], [0, 0, 1, Infinity, 1, 1], [0, 0, 1, "a", 1, 1], [], "polygon", null, undefined, { length: 6 }].forEach(function (p) {
		assert.throws(function () { selectPolygon(cloud, p); }, { code: "INVALID_ARGUMENT", message: /polygon/ });
	});
	assert.throws(function () { selectPolygon(cloud, U, { boundary: "on" }); }, /boundary/);
	assert.throws(function () { selectPolygon(cloud, U, { tolerance: -1 }); }, /tolerance/);
	assert.throws(function () { selectPolygon(cloud, U, { tolerance: Infinity }); }, /tolerance/);
	assert.throws(function () { selectPolygon(cloud, U, { tolerance: NaN }); }, /tolerance/);
	assert.throws(function () { selectPolygon(cloud, U, { tolerance: "1" }); }, { code: "INVALID_ARGUMENT", message: /tolerance/ });
	assert.throws(function () { selectPolygon(cloud, U, 5); }, { code: "INVALID_ARGUMENT" });
});
test("makePolygonTest: the box is the polygon's grown by tolerance; test(x, y) decides a point", function () {
	var t = makePolygonTest(U, { tolerance: 0.5 });
	assert.deepEqual([t.minX, t.maxX, t.minY, t.maxY], [-0.5, 3.5, -0.5, 3.5]);
	var t0 = makePolygonTest(U);
	assert.deepEqual([t0.minX, t0.maxX, t0.minY, t0.maxY], [0, 3, 0, 3]);
	assert.equal(t0.test(0.5, 0.5), true);
	assert.equal(t0.test(1.5, 2), false);
	assert.equal(t0.test(1.5, 1), true);
	assert.equal(makePolygonTest(U, { boundary: "inside" }).test(1.5, 1), false);
	assert.equal(t0.test(10, 10), false);
});
test("selectPolygon is exported; makePolygonTest stays internal", function () {
	assert.equal(lib.selectPolygon, selectPolygon);
	assert.equal(lib.makePolygonTest, undefined);
});

// ---- crop on read ----------------------------------------------------------------------------

// A concave 6-vertex L over the header bounds, arms 0.3 of the width / height (about half the area)
function lShape(b, arm) {
	var w = b.maxX - b.minX, h = b.maxY - b.minY;
	return [b.minX, b.minY, b.maxX, b.minY, b.maxX, b.minY + arm * h, b.minX + arm * w, b.minY + arm * h, b.minX + arm * w, b.maxY, b.minX, b.maxY];
}

function pick(cols, sel) {
	var out = { count: sel.length };
	Object.keys(cols).forEach(function (k) {
		if (!ArrayBuffer.isView(cols[k])) return;
		var a = new cols[k].constructor(sel.length);
		for (var j = 0; j < sel.length; j++) a[j] = cols[k][sel[j]];
		out[k] = a;
	});
	return out;
}

function sameColumns(got, want, label) {
	assert.equal(got.count, want.count, label + " count");
	var names = Object.keys(want).filter(function (k) { return ArrayBuffer.isView(want[k]); });
	assert.ok(names.length >= 3, label + " has columns");
	names.forEach(function (k) {
		assert.ok(ArrayBuffer.isView(got[k]), label + " " + k + " present");
		assert.equal(got[k].constructor, want[k].constructor, label + " " + k + " type");
		assert.deepEqual(got[k], want[k], label + " " + k);
	});
}

async function cropMatches(las, label) {
	var full = await las.readPoints({});
	var polygon = lShape(las.header.bounds, 0.3);
	for (var boundary of ["touching", "inside"]) {
		var cropped = await las.readPoints({ polygon: polygon, boundary: boundary });
		var sel = selectPolygon(full, polygon, { boundary: boundary });
		assert.ok(sel.length > 0 && sel.length < full.count, label + " " + boundary + " keeps part of the cloud (" + sel.length + " of " + full.count + ")");
		sameColumns(cropped, pick(full, sel), label + " " + boundary);
	}
	return full;
}

test("crop on read = selectPolygon after a full read, on every LAZ fixture (threads 1 and 4)", async function () {
	for (var name of Object.keys(LAZ_MANIFEST)) {
		for (var threads of [1, 4]) {
			var las = await openLas(fixtureBytes(name), { threads: threads });
			await cropMatches(las, name + " threads " + threads);
			await las.close();
		}
	}
});
test("crop on read on a built LAS, legacy and extended formats", async function () {
	for (var fmt of [0, 6]) {
		var pts = [];
		for (var i = 0; i < 2000; i++) pts.push({ x: (i * 37) % 100, y: (i * 11) % 60, z: i % 17, classification: i % 5, returnNumber: 1, numberOfReturns: 1, intensity: i });
		var las = await openLas(buildLas({ version: fmt === 0 ? "1.2" : "1.4", pointFormat: fmt, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: pts }));
		await cropMatches(las, "format " + fmt);
	}
});
test("crop on read with chunks gives the same points as readPoints", async function () {
	var las = await openLas(fixtureBytes("f0"), { threads: 1 });
	var polygon = lShape(las.header.bounds, 0.3), xs = [];
	for await (var c of las.chunks({ polygon: polygon })) for (var i = 0; i < c.count; i++) xs.push(c.x[i]);
	var cropped = await las.readPoints({ polygon: polygon });
	assert.ok(cropped.count > 0);
	assert.deepEqual(Float64Array.from(xs), cropped.x);
});
test("crop on read with maxPoints keeps exactly maxPoints of the inside points", async function () {
	var las = await openLas(fixtureBytes("f0"), { threads: 1 });
	var polygon = lShape(las.header.bounds, 0.3);
	var cropped = await las.readPoints({ polygon: polygon });
	var thinned = await las.readPoints({ polygon: polygon, maxPoints: 25 });
	assert.ok(cropped.count > 25);
	assert.equal(thinned.count, 25);
	var sel = thinSelection(cropped.count, 25);
	for (var j = 0; j < 25; j++) {
		assert.equal(thinned.x[j], cropped.x[sel[j]]);
		assert.equal(thinned.y[j], cropped.y[sel[j]]);
		assert.equal(thinned.z[j], cropped.z[sel[j]]);
	}
});
test("a bad polygon on read throws before any point is read", async function () {
	var las = await openLas(fixtureBytes("f0"), { threads: 1 });
	await assert.rejects(las.readPoints({ polygon: [0, 0, 1, 0] }), { code: "INVALID_ARGUMENT", message: /polygon/ });
	await assert.rejects(las.readPoints({ polygon: U, boundary: "on" }), { code: "INVALID_ARGUMENT", message: /boundary/ });
	await assert.rejects(las.readPoints({ polygon: U, tolerance: -1 }), { code: "INVALID_ARGUMENT", message: /tolerance/ });
	await assert.rejects(async function () { for await (var c of las.chunks({ polygon: [0, 0, 1, NaN, 1, 1] })) { void c; } }, { code: "INVALID_ARGUMENT" });
});
