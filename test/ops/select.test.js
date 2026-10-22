// test/ops/select.test.js
//==========================================================
// Box, class and return selections, thinSelection and the set
// operations, on one hand-made cloud of 10 points; plus the thinning
// identity: readPoints({ maxPoints }) picks the points thinSelection
// names (compared by value, no keepPoints yet).
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectBox, selectClasses, selectReturns, thinSelection, thinStep, unionSelections, intersectSelections, subtractSelections } from "../../src/ops/select.js";
import * as lib from "../../src/index.js";
import { openLas } from "../../src/LasReader.js";
import { buildLas } from "../helpers/buildLas.js";
import { LAZ_MANIFEST, fixtureBytes } from "../helpers/lazFixtureFiles.js";

// x = 0..9, y = x % 3, z = x * 10
var c = {
	count: 10,
	x: Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
	y: Float64Array.from([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]),
	z: Float64Array.from([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]),
	classification: Uint8Array.from([2, 2, 1, 6, 2, 1, 6, 6, 2, 1]),
	returnNumber: Uint8Array.from([1, 2, 1, 1, 3, 1, 2, 1, 1, 2]),
	numberOfReturns: Uint8Array.from([2, 2, 1, 1, 3, 1, 2, 3, 1, 2])
};

test("selectBox is inclusive and omitted bounds are open", function () {
	assert.deepEqual(Array.from(selectBox(c, { minX: 2, maxX: 5 })), [2, 3, 4, 5]);
	assert.deepEqual(Array.from(selectBox(c, { minY: 2 })), [2, 5, 8]);
	assert.deepEqual(Array.from(selectBox(c, { minX: 1, maxZ: 30 })), [1, 2, 3]);
	assert.deepEqual(Array.from(selectBox(c, {})), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
test("selectBox returns a Uint32Array that owns only its indices", function () {
	var s = selectBox(c, { minX: 2, maxX: 5 });
	assert.ok(s instanceof Uint32Array);
	assert.equal(s.buffer.byteLength, 16);
	assert.equal(selectBox(c, { minX: 100 }).length, 0);
});
test("selectBox with a Z bound needs z", function () {
	assert.throws(function () { selectBox({ count: 1, x: new Float64Array(1), y: new Float64Array(1) }, { minZ: 0 }); }, /needs a z column/);
	// without a Z bound z is not needed
	assert.deepEqual(Array.from(selectBox({ count: 1, x: new Float64Array(1), y: new Float64Array(1) }, {})), [0]);
	assert.throws(function () { selectBox({ count: 1, y: new Float64Array(1) }, {}); }, /needs a x column/);
});
test("selectBox on count 0, and a NaN bound throws", function () {
	assert.equal(selectBox({ count: 0, x: new Float64Array(0), y: new Float64Array(0) }, { minX: 1 }).length, 0);
	assert.throws(function () { selectBox(c, { minX: NaN }); }, /minX/);
});
test("selectClasses", function () {
	assert.deepEqual(Array.from(selectClasses(c, [6])), [3, 6, 7]);
	assert.deepEqual(Array.from(selectClasses(c, [1, 6])), [2, 3, 5, 6, 7, 9]);
	assert.equal(selectClasses(c, []).length, 0);
	assert.throws(function () { selectClasses(c, 6); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { selectClasses({ count: 1 }, [2]); }, /needs a classification column/);
});
test("selectReturns: returns list, first, last, single, OR-combined", function () {
	assert.deepEqual(Array.from(selectReturns(c, { returns: [2] })), [1, 6, 9]);
	assert.deepEqual(Array.from(selectReturns(c, { first: true })), [0, 2, 3, 5, 7, 8]);
	assert.deepEqual(Array.from(selectReturns(c, { last: true })), [1, 2, 3, 4, 5, 6, 8, 9]);
	assert.deepEqual(Array.from(selectReturns(c, { single: true })), [2, 3, 5, 8]);
	assert.deepEqual(Array.from(selectReturns(c, { returns: [3], single: true })), [2, 3, 4, 5, 8]);
	assert.throws(function () { selectReturns(c, {}); }, { code: "INVALID_ARGUMENT" });
});
test("selectReturns needs numberOfReturns only for last / single", function () {
	var d = { count: 2, returnNumber: Uint8Array.from([1, 2]) };
	assert.deepEqual(Array.from(selectReturns(d, { first: true })), [0]);
	assert.deepEqual(Array.from(selectReturns(d, { returns: [2] })), [1]);
	assert.throws(function () { selectReturns(d, { last: true }); }, /needs a numberOfReturns column/);
	assert.throws(function () { selectReturns(d, { single: true }); }, /needs a numberOfReturns column/);
});
test("thinSelection follows the reader's rule: ceil(j * total / target) - 1", function () {
	assert.deepEqual(Array.from(thinSelection(10, 4)), [2, 4, 7, 9]);
	assert.deepEqual(Array.from(thinSelection(3, 5)), [0, 1, 2]);
	assert.equal(thinSelection(10, 0).length, 0);
	assert.equal(thinSelection(1000003, 777).length, 777);
	assert.throws(function () { thinSelection(10, -1); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { thinSelection(1.5, 1); }, { code: "INVALID_ARGUMENT" });
});
test("thinSelection indices match the closed form ceil(j * count / target) - 1", function () {
	[[1000003, 777], [100, 7], [13, 13], [13, 12]].forEach(function (p) {
		var s = thinSelection(p[0], p[1]);
		assert.equal(s.length, p[1]);
		for (var j = 1; j <= p[1]; j++) assert.equal(s[j - 1], Math.ceil(j * p[0] / p[1]) - 1);
	});
});
test("thinStep: the accumulator rule on its own", function () {
	var thin = { total: 10, target: 4, acc: 0 };
	var kept = [];
	for (var i = 0; i < 10; i++) if (thinStep(thin)) kept.push(i);
	assert.deepEqual(kept, [2, 4, 7, 9]);
	assert.equal(thin.acc, 0);
});
test("set operations", function () {
	var a = new Uint32Array([1, 3, 5]), b = new Uint32Array([2, 3, 6]);
	assert.deepEqual(Array.from(unionSelections(a, b)), [1, 2, 3, 5, 6]);
	assert.deepEqual(Array.from(intersectSelections(a, b)), [3]);
	assert.deepEqual(Array.from(subtractSelections(a, b)), [1, 5]);
	assert.deepEqual(Array.from(unionSelections(new Uint32Array(0), b)), [2, 3, 6]);
	assert.throws(function () { unionSelections(new Uint32Array([2, 1]), b); }, /a\[1\]/);
	assert.throws(function () { intersectSelections(a, new Uint32Array([4, 4])); }, /b\[1\]/);
});
test("set operations: empty sides, tails, plain Arrays", function () {
	var e = new Uint32Array(0);
	assert.deepEqual(Array.from(subtractSelections([4, 8], e)), [4, 8]);
	assert.deepEqual(Array.from(subtractSelections(e, [4, 8])), []);
	assert.deepEqual(Array.from(intersectSelections([4, 8], e)), []);
	assert.deepEqual(Array.from(subtractSelections([1, 2, 3, 9], [3, 4])), [1, 2, 9]);
	assert.deepEqual(Array.from(unionSelections([1, 9], [2, 3, 4])), [1, 2, 3, 4, 9]);
	assert.ok(unionSelections([1], [2]) instanceof Uint32Array);
});
test("the public names are exported from the package entry", function () {
	["selectBox", "selectClasses", "selectReturns", "thinSelection", "unionSelections", "intersectSelections", "subtractSelections"].forEach(function (n) {
		assert.equal(typeof lib[n], "function", n);
	});
});

// ---- thinning identity (Step 1b): readPoints({ maxPoints }) = the thinSelection points of the full read ----
var F = ["x", "y", "z"];
async function identity(las, extra, target) {
	var all = await las.readPoints(Object.assign({ fields: F }, extra));
	var thin = await las.readPoints(Object.assign({ fields: F, maxPoints: target }, extra));
	var sel = thinSelection(all.count, target);
	assert.equal(thin.count, sel.length);
	for (var j = 0; j < sel.length; j++) {
		assert.equal(thin.x[j], all.x[sel[j]]);
		assert.equal(thin.y[j], all.y[sel[j]]);
		assert.equal(thin.z[j], all.z[sel[j]]);
	}
	return all.count;
}

test("thinning identity on every LAZ fixture, unfiltered and with classes [2]", async function () {
	for (var name of Object.keys(LAZ_MANIFEST)) {
		var las = await openLas(fixtureBytes(name), { threads: 1 });
		var n = await identity(las, {}, 37);
		assert.ok(n > 37, name + " has more than 37 points");
		await identity(las, { classes: [2] }, 37);
	}
});
test("thinning identity on a built 1000-point file", async function () {
	var pts = [];
	for (var i = 0; i < 1000; i++) pts.push({ x: i * 0.5, y: (i * 7) % 100, z: i % 13, classification: i % 4 === 0 ? 2 : 1, returnNumber: 1, numberOfReturns: 1 });
	var las = await openLas(buildLas({ version: "1.2", pointFormat: 0, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: pts }));
	assert.equal(await identity(las, {}, 37), 1000);
	assert.equal(await identity(las, { classes: [2] }, 37), 250);
});
test("selectBox: a null bound is open, as the reader's bounds are", function () {
	assert.deepEqual(Array.from(selectBox(c, { minX: null, maxX: 3 })), [0, 1, 2, 3]);
	assert.deepEqual(Array.from(selectBox(c, { minX: 7, maxX: null, minZ: null, maxZ: null })), [7, 8, 9]);
	assert.deepEqual(Array.from(selectBox(c, { minX: null, maxX: null, minY: null, maxY: null })), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	// a null Z bound alone does not ask for z
	assert.deepEqual(Array.from(selectBox({ count: 1, x: new Float64Array(1), y: new Float64Array(1) }, { minZ: null })), [0]);
	// the polygon's Z limits read the same way
	assert.deepEqual(Array.from(lib.selectPolygon(c, [-1, -1, 11, -1, 11, 3, -1, 3], { minZ: null, maxZ: 20 })), [0, 1, 2]);
});
