// test/io/BlobSource.test.js
//==========================================================
// BlobSource: async range reads from a File/Blob.
// Run with: node --test test/io/BlobSource.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BlobSource } from "../../src/io/BlobSource.js";

var blob = new Blob([Uint8Array.from([1, 2, 3, 4, 5])]);

test("reads the requested range", async function () {
	var s = new BlobSource(blob);
	assert.equal(s.size, 5);
	assert.deepEqual(Array.from(await s.read(1, 4)), [2, 3, 4]);
});

test("empty range returns empty array", async function () {
	assert.equal((await new BlobSource(blob).read(2, 2)).length, 0);
});

test("end past size rejects TRUNCATED", async function () {
	await assert.rejects(new BlobSource(blob).read(3, 9), { code: "TRUNCATED", offset: 9 });
});

test("negative or reversed range rejects INVALID_ARGUMENT", async function () {
	await assert.rejects(new BlobSource(blob).read(-1, 2), { code: "INVALID_ARGUMENT" });
	await assert.rejects(new BlobSource(blob).read(3, 2), { code: "INVALID_ARGUMENT" });
});

test("non-Blob argument throws INVALID_ARGUMENT", function () {
	assert.throws(function () { new BlobSource({}); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { new BlobSource(null); }, { code: "INVALID_ARGUMENT" });
});
