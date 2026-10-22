// test/ops/interleave.test.js
//==========================================================
// interleavePositions: layouts, origin shift in Float64 (with and
// without Z), a caller's buffer at an offset, the Float32 / Float64
// default, and the INVALID_ARGUMENT cases. Oracle: the values
// written, read back element by element against the input columns
// minus the origin.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { interleavePositions } from "../../src/ops/interleave.js";
import * as lib from "../../src/index.js";

// 3 points, x / y in the millions; whole values, so Float32 holds them exactly before any shift
var c = {
	count: 3,
	x: Float64Array.from([500001, 500002, 500003]),
	y: Float64Array.from([7000001, 7000002, 7000003]),
	z: Float64Array.from([10, 20, 30])
};

test("xyz into a new Float32Array with an origin", function () {
	var p = interleavePositions(c, { origin: { x: 500000, y: 7000000, z: 0 } });
	assert.ok(p instanceof Float32Array);
	assert.deepEqual(Array.from(p), [1, 1, 10, 2, 2, 20, 3, 3, 30]);
});
test("origin without z keeps world Z (Kirra)", function () {
	assert.deepEqual(Array.from(interleavePositions(c, { origin: { x: 500000, y: 7000000 } })).slice(0, 3), [1, 1, 10]);
});
test("xy layout, Float64, at offset into a caller's buffer", function () {
	var into = new Float64Array(10).fill(-1);
	interleavePositions(c, { layout: "xy", into: into, at: 2, origin: { x: 500000, y: 7000000 } });
	assert.deepEqual(Array.from(into), [-1, -1, -1, -1, 1, 1, 2, 2, 3, 3]);
});
test("float32: false gives a Float64Array", function () { assert.ok(interleavePositions(c, { float32: false }) instanceof Float64Array); });
test("into too short, a bad layout or a bad into type throws", function () {
	assert.throws(function () { interleavePositions(c, { into: new Float32Array(8) }); }, /into/);
	assert.throws(function () { interleavePositions(c, { into: new Float32Array(9), at: 1 }); }, /into/);
	assert.throws(function () { interleavePositions(c, { layout: "yxz" }); }, /layout/);
	assert.throws(function () { interleavePositions(c, { into: new Uint16Array(9) }); }, /into/);
});
test("count 0 writes nothing", function () { assert.equal(interleavePositions({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }).length, 0); });
test("interleavePositions is exported from the entry point", function () { assert.equal(lib.interleavePositions, interleavePositions); });

// Fractional world coordinates: Float32 rounds at 2^-5 near 500000, so
// storing x and subtracting the origin afterwards gives a different value.
test("the origin is subtracted before the Float32 store", function () {
	var fc = {
		count: 1,
		x: Float64Array.from([500000.123456]),
		y: Float64Array.from([7000000.654321]),
		z: Float64Array.from([0])
	};
	var p = interleavePositions(fc, { origin: { x: 500000, y: 7000000 } });
	var x = fc.x[0], y = fc.y[0];
	assert.equal(p[0], Math.fround(x - 500000));
	assert.equal(p[1], Math.fround(y - 7000000));
	assert.notEqual(p[0], Math.fround(x) - 500000);
	assert.notEqual(p[1], Math.fround(y) - 7000000);
});
test("at must be a whole number ≥ 0", function () {
	[-1, 1.5, NaN].forEach(function (at) {
		assert.throws(function () { interleavePositions(c, { at: at }); }, /at/);
	});
});
test("xyz needs z; xy works without z", function () {
	var noZ = { count: 3, x: c.x, y: c.y };
	assert.throws(function () { interleavePositions(noZ); }, /needs a z column/);
	assert.deepEqual(Array.from(interleavePositions(noZ, { layout: "xy", origin: { x: 500000, y: 7000000 } })), [1, 1, 2, 2, 3, 3]);
});
test("a non-finite origin axis is ignored", function () {
	var p = interleavePositions(c, { origin: { x: NaN, y: 7000000, z: 0 } });
	assert.equal(p[0], 500001);
	assert.equal(p[1], 1);
});
test("float32: false with a Float32Array into writes into that array", function () {
	var into = new Float32Array(9);
	var p = interleavePositions(c, { into: into, float32: false, origin: { x: 500000, y: 7000000 } });
	assert.equal(p, into);
	assert.deepEqual(Array.from(into), [1, 1, 10, 2, 2, 20, 3, 3, 30]);
});
