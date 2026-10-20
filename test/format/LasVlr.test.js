// test/format/LasVlr.test.js
//==========================================================
// VLRs (54-byte header, u16 length) and EVLRs (60-byte header,
// u64 length). Run with: node --test test/format/
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVlrs, parseEvlrs } from "../../src/format/LasVlr.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { buildLas } from "../helpers/buildLas.js";

test("two VLRs: user id, record id, description, start and bytes", function () {
	var b = buildLas({ version: "1.2", pointFormat: 0, points: [{ x: 0, y: 0, z: 0 }], vlrs: [
		{ userId: "LASF_Projection", recordId: 34735, description: "GeoKeys", bytes: Uint8Array.from([1, 2, 3]) },
		{ userId: "liblas", recordId: 2112, description: "WKT", bytes: Uint8Array.from([65, 66]) }
	] });
	var vlrs = parseVlrs(new MemorySource(b), 227, 2);
	assert.equal(vlrs.length, 2);
	assert.equal(vlrs[0].userId, "LASF_Projection");
	assert.equal(vlrs[0].recordId, 34735);
	assert.equal(vlrs[0].description, "GeoKeys");
	assert.equal(vlrs[0].start, 227 + 54);
	assert.deepEqual(Array.from(vlrs[0].bytes), [1, 2, 3]);
	assert.equal(vlrs[1].start, 227 + 54 + 3 + 54);
	assert.deepEqual(Array.from(vlrs[1].bytes), [65, 66]);
});

test("a VLR running past the given limit is BAD_VLR at its offset", function () {
	var b = buildLas({ version: "1.2", pointFormat: 0, points: [{ x: 0, y: 0, z: 0 }], vlrs: [{ userId: "x", recordId: 1, bytes: Uint8Array.from([1, 2]) }] });
	new DataView(b.buffer).setUint16(227 + 20, 60000, true);
	assert.throws(function () { parseVlrs(new MemorySource(b), 227, 1, 227 + 54 + 2); }, { code: "BAD_VLR", offset: 227 });
});

test("EVLRs: 60-byte header with a u64 length", function () {
	var b = buildLas({ version: "1.4", pointFormat: 6, points: [{ x: 0, y: 0, z: 0 }], evlrs: [{ userId: "LASF_Projection", recordId: 2112, description: "WKT", bytes: Uint8Array.from([80, 82, 79]) }] });
	var start = 375 + 30;
	var e = parseEvlrs(new MemorySource(b), start, 1);
	assert.equal(e[0].userId, "LASF_Projection");
	assert.equal(e[0].recordId, 2112);
	assert.equal(e[0].start, start + 60);
	assert.deepEqual(Array.from(e[0].bytes), [80, 82, 79]);
});
