// test/filter/filters.test.js
//==========================================================
// Filters: classes, returns, bounds (on raw records), countKept
// (for maxPoints over filtered points) and dedupe (Kirra's XY grid rule).
// Every count is worked by hand from the points below.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKeep, countKept } from "../../src/filter/filters.js";
import { dedupe } from "../../src/filter/dedupe.js";
import { decodeRecords } from "../../src/read/decodeRecords.js";
import { parseHeader } from "../../src/format/LasHeader.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { buildLas } from "../helpers/buildLas.js";

// 12 points along X = 0..11; class 2 (ground) at 0, 3, 6, 9; first returns at even X;
// Y = 0 except X 4, 5, 6 at Y = 10.
function twelve() {
	var pts = [];
	for (var i = 0; i < 12; i++) {
		pts.push({ x: i, y: (i >= 4 && i <= 6) ? 10 : 0, z: i * 0.5, classification: i % 3 === 0 ? 2 : 1, returnNumber: i % 2 === 0 ? 1 : 2, numberOfReturns: 2 });
	}
	return pts;
}

function count(fmt, version, filter) {
	var b = buildLas({ version: version, pointFormat: fmt, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: twelve() });
	var h = parseHeader(new MemorySource(b));
	var keep = makeKeep(filter, h);
	return decodeRecords(b.subarray(h.offsetToPointData), h, { fields: ["x"], keep: keep }).count;
}

test("classes [2] keeps the 4 ground points (legacy and extended layouts)", function () {
	assert.equal(count(0, "1.2", { classes: [2] }), 4);
	assert.equal(count(6, "1.4", { classes: [2] }), 4);
	assert.equal(count(1, "1.2", { classes: [1, 2] }), 12);
});

test("returns [1] keeps the 6 first returns", function () {
	assert.equal(count(0, "1.2", { returns: [1] }), 6);
	assert.equal(count(7, "1.4", { returns: [1] }), 6);
});

test("bounds keeps the 3 points inside the box (X 4-6, Y 10)", function () {
	assert.equal(count(0, "1.2", { bounds: { minX: 3.5, maxX: 7.5, minY: 5, maxY: 15, minZ: -1, maxZ: 100 } }), 3);
});

test("bounds with only some limits: omitted means open", function () {
	assert.equal(count(0, "1.2", { bounds: { minZ: 3 } }), 6);          // z = i * 0.5 >= 3 -> i = 6..11
	assert.equal(count(0, "1.2", { bounds: { maxX: 2 } }), 3);          // x = 0, 1, 2
	assert.equal(count(0, "1.2", { bounds: { minY: 5 } }), 3);          // the three at Y = 10
	assert.equal(count(0, "1.2", { bounds: { maxZ: 1 } }), 3);          // z = 0, 0.5, 1
	assert.equal(count(0, "1.2", { bounds: { minX: 3.5, maxX: 7.5 } }), 4);   // x = 4..7, no Y or Z limit
	assert.equal(count(0, "1.2", { bounds: {} }), 12);
});

test("polygon keeps the points inside it (world X, Y of the raw record); boundary and tolerance as selectPolygon", function () {
	var box = [3, -1, 9, -1, 9, 1, 3, 1];   // X 3..9, Y -1..1: x = 3, 7, 8, 9 (x = 4, 5, 6 are at Y = 10)
	assert.equal(count(0, "1.2", { polygon: box }), 4);
	assert.equal(count(0, "1.2", { polygon: box, boundary: "touching" }), 4);
	assert.equal(count(0, "1.2", { polygon: box, boundary: "inside" }), 2);     // 3 and 9 are on the polygon's edges
	var narrow = [3.5, -1, 8.5, -1, 8.5, 1, 3.5, 1];                            // x = 7, 8 inside; 3 and 9 are 0.5 outside an edge
	assert.equal(count(0, "1.2", { polygon: narrow }), 2);
	assert.equal(count(0, "1.2", { polygon: narrow, tolerance: 0.6 }), 4);
	assert.equal(count(0, "1.2", { polygon: narrow, tolerance: 0.4 }), 2);
	assert.equal(count(6, "1.4", { polygon: box, boundary: "inside" }), 2);
});

test("polygon and classes combine with AND; polygon and bounds too", function () {
	var box = [3, -1, 9, -1, 9, 1, 3, 1];                                       // x = 3, 7, 8, 9
	assert.equal(count(0, "1.2", { polygon: box, classes: [2] }), 2);                      // ground at 0, 3, 6, 9: 3 and 9 (6 is at Y = 10)
	assert.equal(count(0, "1.2", { polygon: box, boundary: "inside", classes: [2] }), 0);  // 3 and 9 are on the edges
	assert.equal(count(0, "1.2", { polygon: box, returns: [1] }), 1);                      // first returns at even x: 8 (4 and 6 are at Y = 10)
	assert.equal(count(0, "1.2", { polygon: box, bounds: { minZ: 4 } }), 2);               // z = x / 2 >= 4: x = 8, 9
});

test("a polygon counts as a filter (makeKeep is not null); a bad one throws", function () {
	var h = parseHeader(new MemorySource(buildLas({ version: "1.2", pointFormat: 0, points: twelve() })));
	assert.equal(typeof makeKeep({ polygon: [0, 0, 1, 0, 0, 1] }, h), "function");
	assert.throws(function () { makeKeep({ polygon: [0, 0, 1, 0] }, h); }, { code: "INVALID_ARGUMENT", message: /polygon/ });
	assert.equal(makeKeep({ boundary: "inside", tolerance: 1 }, h), null);       // no polygon: nothing to filter
});

test("filters combine (AND): ground AND inside the box = X 6 only", function () {
	assert.equal(count(0, "1.2", { classes: [2], bounds: { minX: 3.5, maxX: 7.5, minY: 5, maxY: 15, minZ: -1, maxZ: 100 } }), 1);
});

test("no filter gives null (the decoder then skips the test)", function () {
	var h = parseHeader(new MemorySource(buildLas({ version: "1.2", pointFormat: 0, points: twelve() })));
	assert.equal(makeKeep({}, h), null);
	assert.equal(makeKeep(undefined, h), null);
});

test("countKept counts the records that pass", function () {
	var bytes = new Uint8Array(5 * 4);
	for (var i = 0; i < 5; i++) bytes[i * 4] = i;          // record i holds i in its first byte
	assert.equal(countKept(bytes, 4, function (v, at) { return v.getUint8(at) % 2 === 0; }), 3);   // 0, 2, 4
});

test("dedupe at 0.1 m: points 0.00 / 0.05 / 0.30 m apart keep 2 (XY)", function () {
	var cols = { count: 3, x: Float64Array.from([0, 0.05, 0.30]), y: new Float64Array(3), z: Float64Array.from([1, 2, 3]), intensity: Uint16Array.from([10, 20, 30]) };
	var out = dedupe(cols, 0.1);
	assert.equal(out.count, 2);
	assert.deepEqual(Array.from(out.x), [0, 0.30]);
	assert.deepEqual(Array.from(out.intensity), [10, 30]); // every column follows
	assert.deepEqual(Array.from(out.z), [1, 3]);
});

test("dedupe in XYZ keeps points stacked in Z; XY drops them", function () {
	var cols = { count: 2, x: new Float64Array(2), y: new Float64Array(2), z: Float64Array.from([0, 5]) };
	assert.equal(dedupe(cols, 0.1).count, 1);
	assert.equal(dedupe(cols, 0.1, { z: true }).count, 2);
});

test("dedupe tolerance must be positive", function () {
	assert.throws(function () { dedupe({ count: 0, x: new Float64Array(0), y: new Float64Array(0) }, 0); }, { code: "INVALID_ARGUMENT" });
});
