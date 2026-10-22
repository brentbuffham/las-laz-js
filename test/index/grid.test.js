// test/index/grid.test.js
//==========================================================
// buildIndex: every point lands in exactly one cell (its own, by
// floor((p - min) / cellSize)), cells keep ascending point order,
// the automatic cell size follows (16 · extent / count)^(1/D), the
// positions layout gives the same grid as x / y / z, and the limits
// (cell count above 2^53, more than 2^32 - 1 points) are refused.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, buildGrid, coordsOf, lookup, checkIndex, checkPointCount } from "../../src/index/grid.js";
import * as lib from "../../src/index.js";

function rng(seed) {
	return function () {
		seed = (seed + 0x6D2B79F5) | 0;
		var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function cloud(n, sx, sy, sz, seed, Type) {
	var r = rng(seed), T = Type || Float64Array;
	var c = { count: n, x: new T(n), y: new T(n), z: new T(n) };
	for (var i = 0; i < n; i++) { c.x[i] = r() * sx; c.y[i] = r() * sy; c.z[i] = r() * sz; }
	return c;
}
// Put the box corners in, so the extent is exact
function withCorners(c, sx, sy, sz, z0) {
	c.x[0] = 0; c.y[0] = 0; c.z[0] = z0 || 0;
	c.x[1] = sx; c.y[1] = sy; c.z[1] = (z0 || 0) + sz;
	return c;
}

test("buildIndex is exported from the package", function () {
	assert.equal(lib.buildIndex, buildIndex);
});

test("every point is in exactly one cell, in ascending order within its cell", function () {
	var c = cloud(2000, 50, 30, 10, 1);
	var ix = buildIndex(c, { cellSize: 2 });
	assert.equal(ix.count, 2000);
	assert.equal(ix.cellSize, 2);
	var seen = new Uint8Array(2000), total = 0;
	for (var s = 0; s < ix.keys.length; s++) {
		if (ix.keys[s] < 0) continue;
		var st = ix.start[s], len = ix.length[s];
		assert.ok(len > 0);
		for (var j = 0; j < len; j++) {
			var p = ix.order[st + j];
			assert.equal(seen[p], 0);
			seen[p] = 1; total++;
			if (j > 0) assert.ok(ix.order[st + j - 1] < p, "ascending within a cell");
			var cx = Math.min(ix.nx - 1, Math.floor((c.x[p] - ix.min[0]) / 2));
			var cy = Math.min(ix.ny - 1, Math.floor((c.y[p] - ix.min[1]) / 2));
			var cz = Math.min(ix.nz - 1, Math.floor((c.z[p] - ix.min[2]) / 2));
			assert.equal(ix.keys[s], (cx * ix.ny + cy) * ix.nz + cz);
			assert.equal(lookup(ix, cx, cy, cz), s);
		}
	}
	assert.equal(total, 2000);
	assert.equal(lookup(ix, -1, 0, 0), -1);
	assert.equal(lookup(ix, ix.nx, 0, 0), -1);
});

test("lookup of an empty cell inside the grid is -1", function () {
	var c = { count: 2, x: new Float64Array([0, 10]), y: new Float64Array([0, 0]), z: new Float64Array([0, 0]) };
	var ix = buildIndex(c, { cellSize: 1 });
	assert.equal(ix.nx, 11);
	assert.equal(lookup(ix, 5, 0, 0), -1);
	assert.notEqual(lookup(ix, 10, 0, 0), -1);
});

test("auto cellSize aims at 16 points per cell", function () {
	var near = function (a, b) { assert.ok(Math.abs(a - b) < 1e-9, a + " vs " + b); };
	near(buildIndex(withCorners(cloud(16000, 100, 100, 100, 2), 100, 100, 100)).cellSize, 10);
	var flat = withCorners(cloud(16000, 100, 100, 0, 3), 100, 100, 0, 5);
	for (var i = 0; i < flat.count; i++) flat.z[i] = 5;
	near(buildIndex(flat).cellSize, Math.sqrt(10));
	var line = { count: 160, x: new Float64Array(160), y: new Float64Array(160).fill(3), z: new Float64Array(160).fill(-2) };
	for (var j = 0; j < 160; j++) line.x[j] = j * 1000 / 159;
	near(buildIndex(line).cellSize, 100);
	assert.equal(buildIndex({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }).cellSize, 1);
	assert.equal(buildIndex({ count: 1, x: new Float64Array([5]), y: new Float64Array([6]), z: new Float64Array([7]) }).cellSize, 1);
	var same = { count: 50, x: new Float64Array(50).fill(1), y: new Float64Array(50).fill(2), z: new Float64Array(50).fill(3) };
	var ix = buildIndex(same);
	assert.equal(ix.cellSize, 1);
	assert.equal(ix.length[lookup(ix, 0, 0, 0)], 50);
});

test("count 0 builds an empty index", function () {
	var ix = buildIndex({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) });
	assert.equal(ix.order.length, 0);
	checkIndex(ix, "test");
});

test("positions (k = 3, Float32) give the same cells as x / y / z", function () {
	var c = cloud(3000, 40, 40, 8, 4, Float32Array);
	var pos = new Float32Array(3 * c.count);
	for (var i = 0; i < c.count; i++) { pos[3 * i] = c.x[i]; pos[3 * i + 1] = c.y[i]; pos[3 * i + 2] = c.z[i]; }
	var a = buildIndex(c, { cellSize: 1.5 });
	var b = buildIndex({ count: c.count, positions: pos, rgb: new Uint8Array(3 * c.count) }, { cellSize: 1.5 });
	assert.deepEqual(Array.from(b.order), Array.from(a.order));
	assert.deepEqual(Array.from(b.keys), Array.from(a.keys));
	assert.deepEqual(Array.from(b.start), Array.from(a.start));
	assert.deepEqual(Array.from(b.length), Array.from(a.length));
	assert.equal(b.coords.stride, 3);
	assert.equal(b.coords.y[3 * 7], c.y[7]);
	var co = coordsOf({ count: 2, x: new Float64Array(2), y: new Float64Array(2), z: new Float64Array(2) }, "f");
	assert.equal(co.stride, 1);
});

test("buildGrid with xy puts every point in nz = 1", function () {
	var c = cloud(500, 10, 10, 50, 5);
	var g = buildGrid(coordsOf(c, "t"), c.count, 1, true);
	assert.equal(g.nz, 1);
	var total = 0;
	for (var s = 0; s < g.keys.length; s++) if (g.keys[s] >= 0) total += g.length[s];
	assert.equal(total, 500);
});

test("cell count above 2^53 is refused", function () {
	var c = { count: 2, x: new Float64Array([0, 1e6]), y: new Float64Array([0, 1e6]), z: new Float64Array([0, 1e6]) };
	assert.throws(function () { buildIndex(c, { cellSize: 1e-3 }); }, { code: "INVALID_ARGUMENT", message: /cellSize too small for this extent/ });
});

test("bad arguments are refused, naming the argument", function () {
	assert.throws(function () { buildIndex({ count: 2, x: new Float64Array(2), y: new Float64Array(2) }); }, { code: "INVALID_ARGUMENT", message: /needs x, y, z columns or a k = 3 positions column/ });
	assert.throws(function () { buildIndex({ count: 2, positions: new Float32Array(4) }); }, { code: "INVALID_ARGUMENT", message: /positions column/ });
	var c = { count: 2, x: new Float64Array(2), y: new Float64Array(2), z: new Float64Array(2) };
	[0, -1, NaN, Infinity, "2"].forEach(function (v) {
		assert.throws(function () { buildIndex(c, { cellSize: v }); }, { code: "INVALID_ARGUMENT", message: /cellSize/ });
	});
	assert.throws(function () { buildIndex({ count: 1.5, x: new Float64Array(1) }); }, { code: "INVALID_ARGUMENT", message: /count/ });
	assert.throws(function () { checkPointCount(4294967296); }, { code: "TOO_MANY_POINTS" });
	checkPointCount(4294967295);
	var ix = buildIndex(c);
	assert.throws(function () { checkIndex(Object.assign({}, ix, { count: ix.count + 1 }), "nearestPoint"); }, { code: "INVALID_ARGUMENT", message: /nearestPoint: index is not self-consistent/ });
	assert.throws(function () { checkIndex(Object.assign({}, ix, { coords: { x: new Float64Array(1), y: ix.coords.y, z: ix.coords.z, stride: 1 } }), "f"); }, { message: /not self-consistent/ });
	assert.throws(function () { checkIndex(null, "f"); }, { message: /not self-consistent/ });
});

test("a 1 M-point index builds in under 3 s and costs under 10 bytes a point", function () {
	var n = 1000000;
	var c = cloud(n, 1000, 1000, 50, 6, Float32Array);
	var t0 = performance.now();
	var ix = buildIndex(c);
	var ms = performance.now() - t0;
	assert.ok(ms < 3000, "built in " + ms + " ms");
	var bytes = ix.order.byteLength + ix.keys.byteLength + ix.start.byteLength + ix.length.byteLength;
	assert.ok(bytes < 10 * n, (bytes / n).toFixed(2) + " bytes a point");
});
