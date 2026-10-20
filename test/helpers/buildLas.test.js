// test/helpers/buildLas.test.js
//==========================================================
// The test-file builder against the ASPRS LAS 1.4 R15 tables
// (header field offsets, record lengths) — so the files the
// decoder tests read are right by the SPEC, not by the decoder.
// Run with: node --test test/helpers/buildLas.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLas } from "./buildLas.js";

function view(b) { return new DataView(b.buffer, b.byteOffset, b.byteLength); }

test("signature and header size per version (ASPRS: 227 / 235 / 375)", function () {
	[["1.2", 227], ["1.3", 235], ["1.4", 375]].forEach(function (c) {
		var b = buildLas({ version: c[0], pointFormat: 0, points: [{ x: 1, y: 2, z: 3 }] });
		assert.equal(String.fromCharCode(b[0], b[1], b[2], b[3]), "LASF");
		assert.equal(b[24], 1);
		assert.equal(b[25], Number(c[0].split(".")[1]));
		assert.equal(view(b).getUint16(94, true), c[1]);
	});
});

test("record length per point format (ASPRS tables)", function () {
	var sizes = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
	sizes.forEach(function (size, fmt) {
		var b = buildLas({ version: fmt >= 6 ? "1.4" : "1.2", pointFormat: fmt, points: [{ x: 0, y: 0, z: 0 }] });
		assert.equal(b[104], fmt);
		assert.equal(view(b).getUint16(105, true), size);
		assert.equal(b.length, view(b).getUint32(96, true) + size);
	});
});

test("X of 1.5 at scale 0.01, offset 0 is the int32 150 at the first record", function () {
	var b = buildLas({ version: "1.2", pointFormat: 0, scale: { x: 0.01, y: 0.01, z: 0.01 }, offset: { x: 0, y: 0, z: 0 }, points: [{ x: 1.5, y: 0, z: 0 }] });
	var start = view(b).getUint32(96, true);
	assert.equal(view(b).getInt32(start, true), 150);
});

test("1.4 point count is the u64 at 247; legacy count 0 for formats >= 6", function () {
	var pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }];
	var b = buildLas({ version: "1.4", pointFormat: 6, points: pts });
	assert.equal(view(b).getUint32(107, true), 0);
	assert.equal(view(b).getUint32(247, true), 2);
	assert.equal(view(b).getUint32(251, true), 0);
});

test("a VLR is laid out as 54-byte header + data, and the point offset follows it", function () {
	var data = Uint8Array.from([1, 2, 3, 4]);
	var b = buildLas({ version: "1.2", pointFormat: 0, points: [{ x: 0, y: 0, z: 0 }], vlrs: [{ userId: "LASF_Projection", recordId: 34735, description: "geokeys", bytes: data }] });
	var v = view(b);
	assert.equal(v.getUint32(100, true), 1);
	assert.equal(String.fromCharCode.apply(null, b.subarray(227 + 2, 227 + 2 + 15)), "LASF_Projection");
	assert.equal(v.getUint16(227 + 18, true), 34735);
	assert.equal(v.getUint16(227 + 20, true), 4);
	assert.equal(v.getUint32(96, true), 227 + 54 + 4);
});

test("bounds and per-return counts come from the points", function () {
	var b = buildLas({ version: "1.2", pointFormat: 0, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: [{ x: 2, y: 5, z: -1, returnNumber: 1 }, { x: -3, y: 7, z: 4, returnNumber: 2 }] });
	var v = view(b);
	assert.equal(v.getFloat64(179, true), 2);  // max X
	assert.equal(v.getFloat64(187, true), -3); // min X
	assert.equal(v.getFloat64(211, true), 4);  // max Z
	assert.equal(v.getUint32(111, true), 1);   // 1st returns
	assert.equal(v.getUint32(115, true), 1);   // 2nd returns
});
