// test/io/ByteSource.test.js
//==========================================================
// readU64 (exact past 2^32, null past 2^53) and readAscii.
// Run with: node --test test/io/ByteSource.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readU64, readAscii } from "../../src/io/ByteSource.js";
import { MemorySource } from "../../src/io/MemorySource.js";

function bytes(list) { return new MemorySource(Uint8Array.from(list)); }
function ascii(text) { return new MemorySource(new TextEncoder().encode(text)); }

test("readU64 is exact above 2^32", function () {
	assert.equal(readU64(bytes([0, 0, 0, 0, 1, 0, 0, 0]), 0, true), 4294967296);
});

test("readU64 big-endian", function () {
	assert.equal(readU64(bytes([0, 0, 0, 2, 0, 0, 0, 5]), 0, false), 2 * 4294967296 + 5);
});

test("readU64 returns null above MAX_SAFE_INTEGER", function () {
	assert.equal(readU64(bytes([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]), 0, true), null);
	assert.equal(readU64(bytes([0, 0, 0, 0, 0, 0, 0x20, 0]), 0, true), null);
});

test("readU64 returns 2^53-1 exactly", function () {
	assert.equal(readU64(bytes([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x1F, 0]), 0, true), Number.MAX_SAFE_INTEGER);
});

test("readU64 past the end throws TRUNCATED", function () {
	assert.throws(function () { readU64(bytes([0, 0, 0, 0, 0, 0, 0]), 0, true); }, { code: "TRUNCATED" });
});

test("readAscii stops at NUL", function () {
	assert.equal(readAscii(ascii("GDA\u0000junk"), 0, 16), "GDA");
});

test("readAscii with no NUL returns exactly maxLength chars", function () {
	assert.equal(readAscii(ascii("ABCDEFGHIJKLMNOPQ"), 0, 16), "ABCDEFGHIJKLMNOP");
});

test("readAscii replaces non-ASCII bytes", function () {
	assert.equal(readAscii(bytes([0x41, 0xC3, 0x42, 0x00]), 0, 16), "A?B");
});

test("readAscii stops at the end of the source", function () {
	assert.equal(readAscii(ascii("AB"), 0, 16), "AB");
});

test("readU64 builds hi * 2^32 + lo without bit operators (LAS 1.4 point counts)", function () {
	var b = new Uint8Array(8);
	var v = new DataView(b.buffer);
	v.setUint32(0, 5, true);
	v.setUint32(4, 1, true);
	assert.equal(readU64(new MemorySource(b), 0, true), 4294967301);
});
