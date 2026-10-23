// test/ops/classify.test.js
//==========================================================
// classifyPoints against a brute-force loop on random clouds (classes
// drawn from 0-255) and random selections: the default keeps every
// class but 0 and 1, overwrite changes every selected point, only
// changes the listed classes; copy vs inPlace; ASPRS_CLASSES.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPoints, ASPRS_CLASSES } from "../../src/ops/classify.js";
import * as lib from "../../src/index.js";
import { rng } from "../helpers/clouds.js";

var N = 10000;

// Classes uniform 0-255, with plenty of 0s, 1s and the target code mixed in
function cloud(seed) {
	var r = rng(seed), cls = new Uint8Array(N), x = new Float64Array(N);
	for (var i = 0; i < N; i++) {
		var u = r();
		cls[i] = u < 0.2 ? 0 : u < 0.4 ? 1 : u < 0.45 ? 64 : Math.floor(r() * 256);
		x[i] = i;
	}
	return { count: N, x: x, y: new Float64Array(N), z: new Float64Array(N), classification: cls };
}

function selection(seed, share) {
	var r = rng(seed), out = [];
	for (var i = 0; i < N; i++) if (r() < share) out.push(i);
	return Uint32Array.from(out);
}

// The oracle: change selected points whose class may change; count real changes
function brute(cls, sel, code, mayChange) {
	var out = Uint8Array.from(cls), changed = 0;
	for (var j = 0; j < sel.length; j++) {
		var i = sel[j];
		if (mayChange(out[i]) && out[i] !== code) { out[i] = code; changed++; }
	}
	return { cls: out, changed: changed };
}

test("by default only classes 0 and 1 change", function () {
	for (var seed = 1; seed <= 5; seed++) {
		var c = cloud(seed), sel = selection(seed + 100, 0.5);
		var want = brute(c.classification, sel, 64, function (k) { return k === 0 || k === 1; });
		var r = classifyPoints(c, sel, 64);
		assert.deepEqual(r.columns.classification, want.cls);
		assert.equal(r.changed, want.changed);
	}
	var two = { count: 3, x: new Float64Array(3), classification: Uint8Array.from([2, 0, 1]) };
	var res = classifyPoints(two, Uint32Array.from([0, 1, 2]), 9);
	assert.deepEqual(Array.from(res.columns.classification), [2, 9, 9]);
	assert.equal(res.changed, 2);
});

test("overwrite changes every selected point", function () {
	var c = cloud(7), sel = selection(8, 0.3);
	var want = brute(c.classification, sel, 7, function () { return true; });
	var r = classifyPoints(c, sel, 7, { overwrite: true });
	assert.deepEqual(r.columns.classification, want.cls);
	assert.equal(r.changed, want.changed);
	// unselected points unchanged
	var inSel = new Uint8Array(N);
	for (var j = 0; j < sel.length; j++) inSel[sel[j]] = 1;
	for (var i = 0; i < N; i++) if (!inSel[i]) assert.equal(r.columns.classification[i], c.classification[i]);
});

test("only changes the listed classes", function () {
	var c = cloud(9), sel = selection(10, 0.6);
	var want = brute(c.classification, sel, 2, function (k) { return k === 7 || k === 18; });
	var r = classifyPoints(c, sel, 2, { only: [7, 18] });
	assert.deepEqual(r.columns.classification, want.cls);
	assert.equal(r.changed, want.changed);
});

test("copy by default, inPlace writes through", function () {
	var c = cloud(11), sel = selection(12, 0.5), before = Uint8Array.from(c.classification);
	var r = classifyPoints(c, sel, 64);
	assert.deepEqual(c.classification, before);
	assert.notEqual(r.columns, c);
	assert.notEqual(r.columns.classification, c.classification);
	assert.equal(r.columns.x, c.x);
	assert.equal(r.columns.y, c.y);
	assert.equal(r.columns.z, c.z);
	assert.equal(r.columns.count, N);
	var p = classifyPoints(c, sel, 64, { inPlace: true });
	assert.equal(p.columns, c);
	assert.equal(p.columns.classification, c.classification);
	assert.deepEqual(c.classification, r.columns.classification);
	// a view into a larger buffer: copy leaves the buffer alone, inPlace changes only the view
	var big = new Uint8Array(20), view = big.subarray(5, 15);
	var v = { count: 10, x: new Float64Array(10), classification: view };
	classifyPoints(v, Uint32Array.from([0, 9]), 3);
	assert.deepEqual(Array.from(big), new Array(20).fill(0));
	classifyPoints(v, Uint32Array.from([0, 9]), 3, { inPlace: true });
	var want = new Array(20).fill(0); want[5] = 3; want[14] = 3;
	assert.deepEqual(Array.from(big), want);
});

test("an empty selection changes nothing", function () {
	var c = cloud(13);
	var r = classifyPoints(c, new Uint32Array(0), 2, { overwrite: true });
	assert.equal(r.changed, 0);
	assert.deepEqual(r.columns.classification, c.classification);
});

test("ASPRS_CLASSES", function () {
	assert.ok(Object.isFrozen(ASPRS_CLASSES));
	assert.deepEqual(Object.keys(ASPRS_CLASSES).map(Number), Array.from({ length: 23 }, function (_, i) { return i; }));
	assert.equal(ASPRS_CLASSES[2], "Ground");
	assert.equal(ASPRS_CLASSES[7], "Low point (noise)");
	assert.equal(ASPRS_CLASSES[22], "Temporal exclusion");
	assert.equal(lib.ASPRS_CLASSES, ASPRS_CLASSES);
	assert.equal(lib.classifyPoints, classifyPoints);
});

test("bad arguments are refused, naming the argument", function () {
	var c = cloud(14), sel = Uint32Array.from([1, 2]);
	[-1, 256, 1.5, "2", undefined, NaN].forEach(function (code) {
		assert.throws(function () { classifyPoints(c, sel, code); }, /code/);
	});
	assert.throws(function () { classifyPoints(c, sel, 2, { only: [300] }); }, /only/);
	assert.throws(function () { classifyPoints(c, sel, 2, { only: "7" }); }, /only/);
	assert.throws(function () { classifyPoints(c, sel, 2, { only: [7], overwrite: true }); }, /only.*overwrite|overwrite.*only/);
	assert.throws(function () { classifyPoints({ count: 2, x: new Float64Array(2) }, Uint32Array.from([0]), 2); }, /classification/);
	assert.throws(function () { classifyPoints(c, Uint32Array.from([2, 1]), 2); }, /is not above/);
	assert.throws(function () { classifyPoints(c, sel, 2, null); }, /options/);
});

// readPoints results carry stats.classCounts: the copy drops it (it would be stale, as transformPoints
// drops it); inPlace keeps the input's counts true to the new classes
test("stats.classCounts is never left stale", function () {
	var c = cloud(15), sel = selection(16, 0.5);
	var counts = {};
	for (var i = 0; i < N; i++) counts[c.classification[i]] = (counts[c.classification[i]] || 0) + 1;
	c.stats = { count: N, classCounts: counts };
	var r = classifyPoints(c, sel, 64);
	assert.equal(r.columns.stats, undefined);
	assert.equal(c.stats.classCounts, counts);
	classifyPoints(c, sel, 64, { inPlace: true });
	var want = {};
	for (i = 0; i < N; i++) want[c.classification[i]] = (want[c.classification[i]] || 0) + 1;
	assert.deepEqual(c.stats.classCounts, want);
});

test("overwrite and inPlace must be true or false", function () {
	var c = cloud(17), sel = Uint32Array.from([1, 2]);
	["false", 0, 1, null].forEach(function (v) {
		assert.throws(function () { classifyPoints(c, sel, 2, { overwrite: v }); }, /overwrite/);
		assert.throws(function () { classifyPoints(c, sel, 2, { inPlace: v }); }, /inPlace/);
	});
});
