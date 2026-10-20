// test/io/NodeFileSource.test.js
//==========================================================
// NodeFileSource: the async range-reader contract over a Node
// file handle, so LAS files are read in windows, never whole.
// Run with: node --test test/io/NodeFileSource.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeFileSource } from "../../src/io/NodeFileSource.js";

function tempFile() {
	var dir = mkdtempSync(join(tmpdir(), "las-laz-js-"));
	var path = join(dir, "ten.bin");
	writeFileSync(path, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
	return path;
}

test("reads a byte range and reports the size", async function () {
	var src = await NodeFileSource.open(tempFile());
	assert.equal(src.size, 10);
	assert.deepEqual(Array.from(await src.read(3, 6)), [3, 4, 5]);
	await src.close();
});

test("a read past the end throws TRUNCATED; a bad range throws INVALID_ARGUMENT", async function () {
	var src = await NodeFileSource.open(tempFile());
	await assert.rejects(src.read(8, 12), { code: "TRUNCATED" });
	await assert.rejects(src.read(5, 2), { code: "INVALID_ARGUMENT" });
	await src.close();
});

test("an empty range reads nothing", async function () {
	var src = await NodeFileSource.open(tempFile());
	assert.equal((await src.read(4, 4)).length, 0);
	await src.close();
});
