// test/ops/columns.test.js
//==========================================================
// Column discovery (the count * k rule), selection validation and
// needColumn. Every expected value is worked by hand.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnsOf, checkSelection, needColumn } from "../../src/ops/columns.js";

test("columnsOf finds k = 1 and k = 3 columns and skips the rest", function () {
	var c = { count: 2, x: new Float64Array(2), positions: new Float32Array(6), lut: new Uint8Array(5), bounds: {}, name: "a" };
	assert.deepEqual(columnsOf(c), [{ name: "x", k: 1 }, { name: "positions", k: 3 }]);
});
test("count 0: every empty typed array is a k = 1 column", function () {
	assert.deepEqual(columnsOf({ count: 0, x: new Float64Array(0), lut: new Uint8Array(4) }), [{ name: "x", k: 1 }]);
});
test("a DataView and a plain array are not columns", function () {
	var c = { count: 2, x: new Float64Array(2), dv: new DataView(new ArrayBuffer(2)), arr: [1, 2] };
	assert.deepEqual(columnsOf(c), [{ name: "x", k: 1 }]);
});
test("a bad count throws", function () {
	assert.throws(function () { columnsOf({ count: -1 }); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { columnsOf({ count: 1.5 }); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { columnsOf({ count: 1.5 }); }, /count/);
	assert.throws(function () { columnsOf({}); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { columnsOf(null); }, { code: "INVALID_ARGUMENT" });
});
test("checkSelection names the first bad position", function () {
	assert.throws(function () { checkSelection(new Uint32Array([1, 5, 5]), 10); }, /selection\[2\] = 5 is not above selection\[1\] = 5/);
	assert.throws(function () { checkSelection(new Uint32Array([0, 3, 12]), 10); }, /selection\[2\] = 12 is not below count 10/);
	assert.throws(function () { checkSelection([0, 1.5], 10); }, /selection\[1\] = 1.5/);
	assert.throws(function () { checkSelection([-1], 10); }, /selection\[0\] = -1/);
	assert.throws(function () { checkSelection("0,1", 10); }, { code: "INVALID_ARGUMENT" });
});
test("checkSelection: the name replaces 'selection', count Infinity has no upper limit", function () {
	assert.throws(function () { checkSelection(new Uint32Array([3, 2]), Infinity, "a"); }, /a\[1\] = 2 is not above a\[0\] = 3/);
	assert.deepEqual(Array.from(checkSelection(new Uint32Array([0, 4000000000]), Infinity, "b")), [0, 4000000000]);
	assert.throws(function () { checkSelection([0, 4294967296], Infinity); }, { code: "INVALID_ARGUMENT" });
	assert.equal(checkSelection([], 0).length, 0);
});
test("a plain Array of whole numbers is accepted (Kirra) and comes back as a Uint32Array", function () {
	var s = checkSelection([0, 2, 9], 10);
	assert.ok(s instanceof Uint32Array);
	assert.deepEqual(Array.from(s), [0, 2, 9]);
});
test("a Uint32Array is returned as given (no copy)", function () {
	var u = new Uint32Array([1, 2]);
	assert.equal(checkSelection(u, 5), u);
});
test("needColumn returns the k = 1 column or names the function and the column", function () {
	var x = new Float64Array(3);
	assert.equal(needColumn({ count: 3, x: x }, "x", "selectBox"), x);
	assert.throws(function () { needColumn({ count: 3, x: x }, "z", "selectBox"); }, /selectBox needs a z column/);
	assert.throws(function () { needColumn({ count: 3, z: new Float32Array(9) }, "z", "f"); }, { code: "INVALID_ARGUMENT" });
});
