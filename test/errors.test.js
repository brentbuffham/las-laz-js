// test/errors.test.js
//==========================================================
// LasError: a stable code and, for byte-level problems, the
// file offset. Run with: node --test test/errors.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LasError, ERROR_CODES } from "../src/errors.js";

test("message carries the offset in hex; code and offset are kept", function () {
	var e = new LasError("TRUNCATED", "x", 26);
	assert.equal(e.message, "x (at 0x1a)");
	assert.equal(e.code, "TRUNCATED");
	assert.equal(e.offset, 26);
	assert.equal(e.name, "LasError");
	assert.ok(e instanceof Error);
});

test("without an offset the message is unchanged", function () {
	assert.equal(new LasError("NOT_LAS", "not a LAS file").message, "not a LAS file");
});

test("ERROR_CODES is frozen and every value equals its key", function () {
	assert.ok(Object.isFrozen(ERROR_CODES));
	var expected = ["NOT_LAS", "UNSUPPORTED_VERSION", "UNSUPPORTED", "COMPRESSED_LAZ", "TRUNCATED", "BAD_HEADER", "BAD_VLR", "INVALID_ARGUMENT", "ABORTED", "TOO_MANY_POINTS", "BAD_STORE"];
	assert.deepEqual(Object.keys(ERROR_CODES).sort(), expected.slice().sort());
	Object.keys(ERROR_CODES).forEach(function (k) { assert.equal(ERROR_CODES[k], k); });
});
