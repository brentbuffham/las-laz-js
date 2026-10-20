// test/format/PointFormats.test.js
//==========================================================
// Point data record formats 0-10: sizes and field offsets from
// the ASPRS LAS 1.4 R15 tables.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POINT_FORMATS } from "../../src/format/PointFormats.js";

test("record sizes 20 28 26 34 57 63 30 36 38 59 67", function () {
	assert.deepEqual(POINT_FORMATS.map(function (f) { return f.size; }), [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67]);
});

test("field offsets from the ASPRS tables", function () {
	assert.equal(POINT_FORMATS[1].fields.gpsTime.offset, 20);
	assert.equal(POINT_FORMATS[2].fields.red.offset, 20);
	assert.equal(POINT_FORMATS[3].fields.red.offset, 28);
	assert.equal(POINT_FORMATS[5].fields.red.offset, 28);
	assert.equal(POINT_FORMATS[6].fields.gpsTime.offset, 22);
	assert.equal(POINT_FORMATS[6].fields.scanAngle.offset, 18);
	assert.equal(POINT_FORMATS[7].fields.red.offset, 30);
	assert.equal(POINT_FORMATS[8].fields.nir.offset, 36);
	assert.equal(POINT_FORMATS[10].fields.nir.offset, 36);
	assert.equal(POINT_FORMATS[4].fields.red, undefined);
	assert.equal(POINT_FORMATS[9].fields.nir, undefined);
});

test("legacy (0-5) vs extended (6-10) layout flag", function () {
	assert.deepEqual(POINT_FORMATS.map(function (f) { return f.extended; }), [false, false, false, false, false, false, true, true, true, true, true]);
});
