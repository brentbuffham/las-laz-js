// test/read/windows.test.js
//==========================================================
// windows(): the point data split into byte windows of WHOLE
// records. Worked by hand.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { windows } from "../../src/read/windows.js";

var H = { offsetToPointData: 227, recordLength: 34, pointCount: 10 };

test("10 records of 34 bytes in 100-byte windows: 2 records per window, 5 windows", function () {
	var w = windows(H, 100);
	assert.equal(w.length, 5);
	assert.deepEqual(w[0], { start: 227, end: 227 + 68, firstRecord: 0, count: 2 });
	assert.deepEqual(w[4], { start: 227 + 8 * 34, end: 227 + 340, firstRecord: 8, count: 2 });
});

test("a window smaller than one record still holds one record", function () {
	var w = windows(H, 10);
	assert.equal(w.length, 10);
	assert.equal(w[3].count, 1);
});

test("the last window holds the remainder", function () {
	var w = windows(H, 34 * 4);
	assert.deepEqual(w.map(function (x) { return x.count; }), [4, 4, 2]);
});

test("no points, no windows", function () {
	assert.deepEqual(windows({ offsetToPointData: 227, recordLength: 20, pointCount: 0 }, 1000), []);
});
