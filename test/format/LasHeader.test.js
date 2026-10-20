// test/format/LasHeader.test.js
//==========================================================
// parseHeader against files built from the ASPRS tables
// (test/helpers/buildLas.js). Run with: node --test test/format/
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeader } from "../../src/format/LasHeader.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { buildLas } from "../helpers/buildLas.js";

var THREE_POINTS = [{ x: 10, y: 20, z: 30, returnNumber: 1 }, { x: 11, y: 21, z: 31, returnNumber: 1 }, { x: 12, y: 22, z: 29, returnNumber: 2 }];

test("LAS 1.2: version, sizes, count, scale, offset, bounds, per-return counts", function () {
	var b = buildLas({ version: "1.2", pointFormat: 3, scale: { x: 0.01, y: 0.02, z: 0.005 }, offset: { x: 5, y: 6, z: 7 }, points: THREE_POINTS, software: "PDAL" });
	var h = parseHeader(new MemorySource(b));
	assert.equal(h.versionMajor, 1); assert.equal(h.versionMinor, 2);
	assert.equal(h.headerSize, 227);
	assert.equal(h.pointFormat, 3);
	assert.equal(h.compressed, false);
	assert.equal(h.recordLength, 34);
	assert.equal(h.pointCount, 3);
	assert.equal(h.offsetToPointData, 227);
	assert.deepEqual(h.scale, { x: 0.01, y: 0.02, z: 0.005 });
	assert.deepEqual(h.offset, { x: 5, y: 6, z: 7 });
	assert.deepEqual(h.bounds, { minX: 10, maxX: 12, minY: 20, maxY: 22, minZ: 29, maxZ: 31 });
	assert.deepEqual(h.pointsByReturn.slice(0, 3), [2, 1, 0]);
	assert.equal(h.software, "PDAL");
	assert.equal(h.creationYear, 2026);
	assert.equal(h.creationDay, 294);
});

test("LAS 1.4: the u64 count wins when the legacy count is 0 (formats >= 6)", function () {
	var b = buildLas({ version: "1.4", pointFormat: 7, points: THREE_POINTS });
	var h = parseHeader(new MemorySource(b));
	assert.equal(h.headerSize, 375);
	assert.equal(h.pointCount, 3);
	assert.equal(h.numberOfEvlrs, 0);
	assert.deepEqual(h.pointsByReturn.slice(0, 3), [2, 1, 0]);
});

test("LAS 1.4 format 3 with a legacy count of 0 still reads the u64 count", function () {
	var b = buildLas({ version: "1.4", pointFormat: 3, points: THREE_POINTS, legacyCount: 0 });
	assert.equal(parseHeader(new MemorySource(b)).pointCount, 3);
});

test("LAS 1.3 carries the waveform start", function () {
	var h = parseHeader(new MemorySource(buildLas({ version: "1.3", pointFormat: 1, points: THREE_POINTS })));
	assert.equal(h.headerSize, 235);
	assert.equal(h.waveformStart, 0);
});

test("format byte 131 = LAZ-compressed format 3 (bit 7); bit 6 also marks LAZ", function () {
	var h = parseHeader(new MemorySource(buildLas({ version: "1.2", pointFormat: 3, formatByte: 131, points: THREE_POINTS })));
	assert.equal(h.pointFormat, 3);
	assert.equal(h.compressed, true);
	var h2 = parseHeader(new MemorySource(buildLas({ version: "1.4", pointFormat: 6, formatByte: 6 + 64, points: THREE_POINTS })));
	assert.equal(h2.pointFormat, 6);
	assert.equal(h2.compressed, true);
});

test("a wrong signature is NOT_LAS at offset 0", function () {
	var b = buildLas({ version: "1.2", pointFormat: 0, points: THREE_POINTS });
	b[3] = 0x58; // "LASX"
	assert.throws(function () { parseHeader(new MemorySource(b)); }, { code: "NOT_LAS", offset: 0 });
});

test("an unknown version is UNSUPPORTED_VERSION; an impossible format is BAD_HEADER", function () {
	var b = buildLas({ version: "1.2", pointFormat: 0, points: THREE_POINTS });
	b[24] = 2;
	assert.throws(function () { parseHeader(new MemorySource(b)); }, { code: "UNSUPPORTED_VERSION" });
	var c = buildLas({ version: "1.4", pointFormat: 0, formatByte: 11, points: THREE_POINTS });
	assert.throws(function () { parseHeader(new MemorySource(c)); }, { code: "BAD_HEADER" });
});

test("a record length shorter than the format needs is BAD_HEADER", function () {
	var b = buildLas({ version: "1.2", pointFormat: 3, points: THREE_POINTS });
	new DataView(b.buffer).setUint16(105, 20, true);
	assert.throws(function () { parseHeader(new MemorySource(b)); }, { code: "BAD_HEADER" });
});

test("extra bytes per record are allowed (record length larger than the format)", function () {
	var b = buildLas({ version: "1.2", pointFormat: 0, extraBytes: 4, points: THREE_POINTS });
	var h = parseHeader(new MemorySource(b));
	assert.equal(h.recordLength, 24);
	assert.equal(h.extraBytes, 4);
});
