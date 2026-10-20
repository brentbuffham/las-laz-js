// test/io/MemorySource.test.js
//==========================================================
// MemorySource: the sync source contract over a Uint8Array.
// Run with: node --test test/io/MemorySource.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemorySource } from "../../src/io/MemorySource.js";

var src = new MemorySource(Uint8Array.from([0x00, 0x01, 0xEB, 0x1D, 0xFF, 0xFF, 0xFF, 0xFE]));

test("big- and little-endian integer getters", function () {
	assert.equal(src.length(), 8);
	assert.equal(src.getUint8(2), 0xEB);
	assert.equal(src.getUint32(0, false), 0x0001EB1D);
	assert.equal(src.getUint16(2, true), 0x1DEB);
	assert.equal(src.getUint16(2, false), 0xEB1D);
	assert.equal(src.getInt32(4, false), -2);
});

test("getFloat64 little-endian", function () {
	var b = new Uint8Array(8);
	new DataView(b.buffer).setFloat64(0, -0.15, true);
	assert.equal(new MemorySource(b).getFloat64(0, true), -0.15);
});

test("out-of-range read throws TRUNCATED with the position", function () {
	assert.throws(function () { src.getUint32(6, false); }, { code: "TRUNCATED", offset: 6 });
	assert.throws(function () { src.getUint8(8); }, { code: "TRUNCATED", offset: 8 });
	assert.throws(function () { src.slice(4, 9); }, { code: "TRUNCATED", offset: 9 });
});

test("slice is a view of the requested range", function () {
	assert.deepEqual(Array.from(src.slice(1, 3)), [0x01, 0xEB]);
	assert.equal(src.slice(3, 3).length, 0);
});

test("reversed or negative slice throws INVALID_ARGUMENT", function () {
	assert.throws(function () { src.slice(3, 2); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { src.slice(-1, 2); }, { code: "INVALID_ARGUMENT" });
});

test("works on a subarray with a non-zero byteOffset", function () {
	var big = Uint8Array.from([9, 9, 0x12, 0x34]);
	assert.equal(new MemorySource(big.subarray(2)).getUint16(0, false), 0x1234);
});

test("getInt16 little-endian (LAS scan angle)", function () {
	assert.equal(new MemorySource(Uint8Array.from([0xFE, 0xFF])).getInt16(0, true), -2);
	assert.equal(new MemorySource(Uint8Array.from([0xC4, 0x09])).getInt16(0, true), 2500);
});
