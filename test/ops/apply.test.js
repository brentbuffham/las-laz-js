// test/ops/apply.test.js
//==========================================================
// keepPoints, removePoints, splitPoints, mergePoints and widestType.
// Expected values are worked by hand or from a plain-array oracle.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../../src/index.js";
import { keepPoints, removePoints, splitPoints, mergePoints } from "../../src/index.js";
import { widestType } from "../../src/ops/columns.js";

// 6 points; x Float64 [0..5]; positions Float32 k=3 (i*3+j); rgb Uint8 k=3 (i*10+j); classification Uint8
function sixPoints() {
	var c = { count: 6, x: new Float64Array([0, 1, 2, 3, 4, 5]), positions: new Float32Array(18), rgb: new Uint8Array(18), classification: new Uint8Array([2, 1, 2, 6, 1, 2]) };
	for (var i = 0; i < 6; i++) for (var j = 0; j < 3; j++) { c.positions[i * 3 + j] = i * 3 + j; c.rgb[i * 3 + j] = i * 10 + j; }
	return c;
}
function mulberry32(a) {
	return function () {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		var t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function expectCode(fn, re) {
	assert.throws(fn, function (e) { return e.code === "INVALID_ARGUMENT" && re.test(e.message); });
}

test("keepPoints copies the selected points of every column, k values each", function () {
	var c = sixPoints();
	var r = keepPoints(c, new Uint32Array([1, 4]));
	assert.equal(r.count, 2);
	assert.deepEqual(Array.from(r.x), [1, 4]);
	assert.deepEqual(Array.from(r.positions), [3, 4, 5, 12, 13, 14]);
	assert.deepEqual(Array.from(r.rgb), [10, 11, 12, 40, 41, 42]);
	assert.deepEqual(Array.from(r.classification), [1, 1]);
	assert.deepEqual(Object.keys(r).sort(), ["classification", "count", "positions", "rgb", "x"]);
	assert.ok(r.x instanceof Float64Array && r.positions instanceof Float32Array && r.rgb instanceof Uint8Array);
	assert.notEqual(r.x.buffer, c.x.buffer);
	assert.equal(c.x[1], 1);
	assert.equal(c.x.length, 6);
});
test("keepPoints drops properties that are not columns and takes a plain Array selection", function () {
	var c = sixPoints();
	c.bounds = { minX: 0 }; c.name = "a"; c.lut = new Uint8Array(4);
	var r = keepPoints(c, [0, 5]);
	assert.deepEqual(Object.keys(r).sort(), ["classification", "count", "positions", "rgb", "x"]);
	assert.deepEqual(Array.from(r.x), [0, 5]);
});
test("removePoints keeps the complement", function () {
	var c = sixPoints();
	var r = removePoints(c, new Uint32Array([0, 5]));
	assert.equal(r.count, 4);
	assert.deepEqual(Array.from(r.x), [1, 2, 3, 4]);
	assert.deepEqual(Array.from(r.rgb), [10, 11, 12, 20, 21, 22, 30, 31, 32, 40, 41, 42]);
	assert.deepEqual(Array.from(r.classification), [1, 2, 6, 1]);
	assert.equal(removePoints(c, new Uint32Array(0)).count, 6);
	assert.deepEqual(Array.from(removePoints(c, new Uint32Array(0)).x), [0, 1, 2, 3, 4, 5]);
	var all = removePoints(c, new Uint32Array([0, 1, 2, 3, 4, 5]));
	assert.equal(all.count, 0);
	assert.equal(all.positions.length, 0);
	assert.equal(c.x[0], 0);
});

test("inPlace equals the copy and shares the input's buffers (random selections)", function () {
	var rnd = mulberry32(12345);
	var N = 1000;
	function cloud() {
		var c = { count: N, x: new Float64Array(N), classification: new Uint8Array(N), positions: new Float32Array(N * 3), rgb: new Uint8Array(N * 3), index: new Uint32Array(N) };
		for (var i = 0; i < N; i++) {
			c.x[i] = i + 0.5; c.classification[i] = i % 7; c.index[i] = i;
			for (var j = 0; j < 3; j++) { c.positions[i * 3 + j] = i * 3 + j; c.rgb[i * 3 + j] = (i * 3 + j) % 251; }
		}
		return c;
	}
	var names = ["x", "classification", "positions", "rgb", "index"];
	var ks = { x: 1, classification: 1, positions: 3, rgb: 3, index: 1 };
	function same(a, b, label) {
		names.forEach(function (n) {
			assert.equal(a[n].length, b[n].length, label + " " + n + " length");
			assert.ok(a[n].constructor === b[n].constructor, label + " " + n + " type");
			for (var i = 0; i < a[n].length; i++) if (a[n][i] !== b[n][i]) assert.fail(label + " " + n + "[" + i + "] " + a[n][i] + " !== " + b[n][i]);
		});
	}
	for (var trial = 0; trial < 200; trial++) {
		var p = trial === 0 ? 0 : trial === 1 ? 1 : rnd();
		var sel = [];
		for (var i = 0; i < N; i++) if (rnd() < p) sel.push(i);
		var u = new Uint32Array(sel);
		var inSet = new Set(sel);
		var base = cloud();
		// oracle from plain arrays
		var wantKeep = [], wantRemove = [];
		for (i = 0; i < N; i++) (inSet.has(i) ? wantKeep : wantRemove).push(i);

		var kc = keepPoints(base, u);
		var rc = removePoints(base, u);
		var kClone = cloud(), rClone = cloud();
		var kp = keepPoints(kClone, u, { inPlace: true });
		var rp = removePoints(rClone, u, { inPlace: true });
		same(kp, kc, "keep trial " + trial);
		same(rp, rc, "remove trial " + trial);
		assert.equal(kp.count, sel.length);
		assert.equal(rp.count, N - sel.length);
		names.forEach(function (n) {
			assert.equal(kp[n].buffer, kClone[n].buffer, "keep shares " + n);
			assert.equal(rp[n].buffer, rClone[n].buffer, "remove shares " + n);
			assert.equal(kp[n].length, sel.length * ks[n]);
		});
		assert.deepEqual(Array.from(kc.index), wantKeep);
		assert.deepEqual(Array.from(rc.index), wantRemove);
		// copies leave the input as it was
		same(base, cloud(), "input untouched trial " + trial);
		// k = 3 values follow their point
		for (i = 0; i < wantKeep.length; i++) assert.equal(kc.positions[i * 3 + 2], wantKeep[i] * 3 + 2);
	}
});
test("inPlace with an empty selection keeps everything, with the full one nothing", function () {
	var c = sixPoints();
	var k = keepPoints(c, new Uint32Array(0), { inPlace: true });
	assert.equal(k.count, 0);
	assert.equal(k.x.length, 0);
	assert.equal(k.x.buffer, c.x.buffer);
	var d = sixPoints();
	var r = removePoints(d, new Uint32Array(0), { inPlace: true });
	assert.equal(r.count, 6);
	assert.deepEqual(Array.from(r.x), [0, 1, 2, 3, 4, 5]);
	assert.equal(r.x.buffer, d.x.buffer);
});

test("splitPoints loses and duplicates nothing", function () {
	var c = sixPoints();
	var s = splitPoints(c, new Uint32Array([0, 2, 5]));
	assert.equal(s.length, 2);
	assert.equal(s[0].count, 3);
	assert.equal(s[1].count, 3);
	assert.deepEqual(Array.from(s[0].x), [0, 2, 5]);
	assert.deepEqual(Array.from(s[1].x), [1, 3, 4]);
	assert.deepEqual(Array.from(s[0].rgb), [0, 1, 2, 20, 21, 22, 50, 51, 52]);
	assert.deepEqual(Array.from(s[1].rgb), [10, 11, 12, 30, 31, 32, 40, 41, 42]);
	assert.notEqual(s[0].x.buffer, c.x.buffer);
	assert.notEqual(s[1].x.buffer, c.x.buffer);
	assert.deepEqual(Object.keys(s[1]).sort(), ["classification", "count", "positions", "rgb", "x"]);
	assert.equal(c.x[2], 2);
});

test("count 0 and empty selections", function () {
	var z = { count: 0, x: new Float64Array(0) };
	assert.equal(keepPoints(z, new Uint32Array(0)).count, 0);
	assert.equal(removePoints(z, new Uint32Array(0)).count, 0);
	assert.equal(keepPoints(z, new Uint32Array(0)).x.length, 0);
	assert.equal(keepPoints(sixPoints(), new Uint32Array(0)).x.length, 0);
	var s = splitPoints(z, new Uint32Array(0));
	assert.equal(s[0].count + s[1].count, 0);
	var s6 = splitPoints(sixPoints(), new Uint32Array(0));
	assert.equal(s6[0].count, 0);
	assert.equal(s6[1].count, 6);
});

test("a stale or malformed selection throws", function () {
	var c = sixPoints();
	expectCode(function () { keepPoints(c, new Uint32Array([2, 6])); }, /selection\[1\] = 6 is not below count 6/);
	expectCode(function () { removePoints(c, [3, 2]); }, /selection\[1\] = 2 is not above selection\[0\] = 3/);
	expectCode(function () { splitPoints(c, new Uint32Array([6])); }, /selection\[0\] = 6 is not below count 6/);
	expectCode(function () { keepPoints(c, null); }, /selection/);
	expectCode(function () { keepPoints(null, new Uint32Array(0)); }, /columns/);
	// a bad selection leaves in-place columns untouched
	var d = sixPoints();
	expectCode(function () { keepPoints(d, new Uint32Array([4, 9]), { inPlace: true }); }, /not below count 6/);
	assert.deepEqual(Array.from(d.x), [0, 1, 2, 3, 4, 5]);
});

test("mergePoints concatenates, fills missing columns with 0 and widens types", function () {
	var a = { count: 2, x: new Float32Array([1, 2]), intensity: new Uint8Array([7, 8]) };
	var b = { count: 1, x: new Float64Array([3]), classification: new Uint8Array([6]) };
	var m = mergePoints([a, b]);
	assert.equal(m.count, 3);
	assert.ok(m.x instanceof Float64Array);
	assert.deepEqual(Array.from(m.x), [1, 2, 3]);
	assert.deepEqual(Array.from(m.intensity), [7, 8, 0]);
	assert.deepEqual(Array.from(m.classification), [0, 0, 6]);
	assert.ok(m.intensity instanceof Uint8Array && m.classification instanceof Uint8Array);
	assert.deepEqual(m.filled, ["intensity", "classification"]);
	assert.deepEqual(Object.keys(m), ["count", "x", "intensity", "classification", "filled"]);
	assert.equal(a.x.length, 2);
});
test("mergePoints: filled is an array even when nothing is filled; [] and one input", function () {
	var a = { count: 2, x: new Float64Array([1, 2]) };
	var m = mergePoints([a, { count: 1, x: new Float64Array([3]) }]);
	assert.deepEqual(m.filled, []);
	assert.deepEqual(Array.from(m.x), [1, 2, 3]);
	var e = mergePoints([]);
	assert.equal(e.count, 0);
	assert.deepEqual(e.filled, []);
	assert.deepEqual(Object.keys(e).sort(), ["count", "filled"]);
	var one = mergePoints([a]);
	assert.deepEqual(Array.from(one.x), [1, 2]);
	assert.notEqual(one.x.buffer, a.x.buffer);
});
test("mergePoints carries k = 3 columns and fills an absent one with k zeros per point", function () {
	var a = { count: 2, positions: new Float32Array([1, 2, 3, 4, 5, 6]) };
	var b = { count: 3, x: new Float64Array([9, 8, 7]) };
	var c = { count: 1, positions: new Float32Array([7, 8, 9]), x: new Float64Array([6]) };
	var m = mergePoints([a, b, c]);
	assert.equal(m.count, 6);
	assert.deepEqual(Array.from(m.positions), [1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 8, 9]);
	assert.deepEqual(Array.from(m.x), [0, 0, 9, 8, 7, 6]);
	assert.deepEqual(m.filled, ["positions", "x"]);
});
test("mergePoints: zero-point inputs add their column names but not a k, nor a fill", function () {
	var a = { count: 2, positions: new Float32Array(6).fill(1) };
	var e = { count: 0, positions: new Float32Array(0), x: new Float64Array(0) };
	var m = mergePoints([e, a]);
	assert.equal(m.count, 2);
	assert.deepEqual(Array.from(m.positions), [1, 1, 1, 1, 1, 1]);
	assert.deepEqual(Array.from(m.x), [0, 0]);
	assert.deepEqual(m.filled, ["x"]);
	var all = mergePoints([e, { count: 0, positions: new Float32Array(0) }]);
	assert.equal(all.count, 0);
	assert.equal(all.positions.length, 0);
	assert.deepEqual(all.filled, []);
});

test("merge widening rules", function () {
	function widen(ta, tb) {
		var a = { count: 1, v: new ta([1]) };
		var b = { count: 1, v: new tb([2]) };
		return mergePoints([a, b]).v;
	}
	assert.ok(widen(Uint8Array, Uint16Array) instanceof Uint16Array);
	assert.ok(widen(Uint8Array, Int16Array) instanceof Int16Array);
	assert.ok(widen(Int16Array, Uint8Array) instanceof Int16Array);
	assert.ok(widen(Int32Array, Float32Array) instanceof Float32Array);
	assert.ok(widen(Uint32Array, Float64Array) instanceof Float64Array);
	assert.ok(widen(Float32Array, Float64Array) instanceof Float64Array);
	assert.ok(widen(Uint8Array, Uint8ClampedArray) instanceof Uint8Array);
	assert.ok(widen(Int8Array, Int32Array) instanceof Int32Array);
	// values survive the widening
	var m = mergePoints([{ count: 2, v: new Int8Array([-5, 127]) }, { count: 1, v: new Int16Array([-300]) }]);
	assert.deepEqual(Array.from(m.v), [-5, 127, -300]);
	var big = mergePoints([{ count: 1, v: new Uint32Array([4294967295]) }, { count: 1, v: new Float64Array([4294967296]) }]);
	assert.deepEqual(Array.from(big.v), [4294967295, 4294967296]);
	// same-width signed + unsigned and narrower signed + wider unsigned throw, naming the column
	expectCode(function () { widen(Int16Array, Uint16Array); }, /column "v".*Int16Array.*Uint16Array/);
	expectCode(function () { widen(Int8Array, Uint16Array); }, /column "v"/);
	expectCode(function () { widen(Uint32Array, Int32Array); }, /column "v"/);
	// k differing throws, naming the column
	expectCode(function () {
		mergePoints([{ count: 2, positions: new Float32Array(2) }, { count: 2, positions: new Float32Array(6) }]);
	}, /column "positions".*k = 1.*k = 3/);
	// a bad list
	expectCode(function () { mergePoints(null); }, /list/);
	expectCode(function () { mergePoints([null]); }, /columns/);
});

test("widestType rules", function () {
	assert.equal(widestType([Uint8Array], "a"), Uint8Array);
	assert.equal(widestType([Uint8ClampedArray], "a"), Uint8Array);
	assert.equal(widestType([Uint8ClampedArray, Int16Array], "a"), Int16Array);
	assert.equal(widestType([Uint8Array, Int8Array, Int16Array], "a"), Int16Array);
	assert.equal(widestType([Uint16Array, Uint8Array, Uint32Array], "a"), Uint32Array);
	assert.equal(widestType([Uint32Array, Float32Array, Uint8Array], "a"), Float32Array);
	assert.equal(widestType([Float32Array, Float64Array, Int8Array], "a"), Float64Array);
	assert.equal(widestType([BigInt64Array, BigInt64Array], "a"), BigInt64Array);
	// signed and unsigned of one width, or a wider unsigned
	expectCode(function () { widestType([Uint8Array, Int8Array], "alpha"); }, /column "alpha"/);
	expectCode(function () { widestType([Int16Array, Uint8Array, Uint16Array], "a"); }, /column "a"/);
	// BigInt arrays only merge with their own type
	expectCode(function () { widestType([BigInt64Array, BigUint64Array], "big"); }, /column "big"/);
	expectCode(function () { widestType([BigInt64Array, Float64Array], "big"); }, /column "big"/);
	expectCode(function () { widestType([Float64Array, BigUint64Array], "big"); }, /column "big"/);
	expectCode(function () { widestType([], "none"); }, /column "none"/);
	expectCode(function () { widestType([Array], "bad"); }, /column "bad"/);
	// internal: not part of the package
	assert.equal(api.widestType, undefined);
});

test("a Kirra kadCloud through keep, remove, split and merge", function () {
	var N = 300;
	var rnd = mulberry32(777);
	var c = { count: N, positions: new Float32Array(N * 3), rgb: new Uint8Array(N * 3), classification: new Uint8Array(N), intensity: new Uint16Array(N), index: new Uint32Array(N) };
	for (var i = 0; i < N; i++) {
		c.index[i] = i * 11 + 5;
		c.classification[i] = Math.floor(rnd() * 10);
		c.intensity[i] = Math.floor(rnd() * 65536);
		for (var j = 0; j < 3; j++) {
			c.positions[i * 3 + j] = Math.fround(rnd() * 1000);
			c.rgb[i * 3 + j] = Math.floor(rnd() * 256);
		}
	}
	var sel = [];
	for (i = 0; i < N; i++) if (c.classification[i] < 4) sel.push(i);
	var u = new Uint32Array(sel);
	assert.ok(sel.length > 20 && sel.length < N - 20);
	var inSet = new Set(sel);
	var order = sel.concat(Array.from({ length: N }, function (_, q) { return q; }).filter(function (q) { return !inSet.has(q); }));

	var s = splitPoints(c, u);
	assert.equal(s[0].count + s[1].count, N);
	assert.deepEqual(Array.from(s[0].index), sel.map(function (q) { return q * 11 + 5; }));
	assert.deepEqual(Array.from(keepPoints(c, u).index), Array.from(s[0].index));
	assert.deepEqual(Array.from(removePoints(c, u).index), Array.from(s[1].index));

	var m = mergePoints(s);
	assert.equal(m.count, N);
	assert.deepEqual(m.filled, []);
	assert.deepEqual(Object.keys(m).sort(), ["classification", "count", "filled", "index", "intensity", "positions", "rgb"]);
	assert.ok(m.positions instanceof Float32Array && m.rgb instanceof Uint8Array && m.intensity instanceof Uint16Array && m.index instanceof Uint32Array);
	// the same points as c, inside then outside, matched by index
	var byIndex = {};
	for (i = 0; i < N; i++) byIndex[c.index[i]] = i;
	for (i = 0; i < N; i++) {
		var src = byIndex[m.index[i]];
		assert.equal(src, order[i], "point " + i + " is c's point " + order[i]);
		assert.equal(m.classification[i], c.classification[src]);
		assert.equal(m.intensity[i], c.intensity[src]);
		for (j = 0; j < 3; j++) {
			assert.equal(m.positions[i * 3 + j], c.positions[src * 3 + j]);
			assert.equal(m.rgb[i * 3 + j], c.rgb[src * 3 + j]);
		}
	}
	// merging with a cloud that has no colour fills rgb with zeros and reports it
	var plain = { count: 2, positions: new Float32Array([1, 2, 3, 4, 5, 6]), index: new Uint32Array([1000, 1001]) };
	var m2 = mergePoints([s[0], plain]);
	assert.equal(m2.count, s[0].count + 2);
	assert.deepEqual(m2.filled.slice().sort(), ["classification", "intensity", "rgb"]);
	assert.deepEqual(Array.from(m2.rgb.subarray(s[0].count * 3)), [0, 0, 0, 0, 0, 0]);
	assert.deepEqual(Array.from(m2.index.subarray(s[0].count)), [1000, 1001]);
	// the input of an in-place keep is the cloud the caller gives up
	var clone = { count: N, positions: c.positions.slice(), rgb: c.rgb.slice(), classification: c.classification.slice(), intensity: c.intensity.slice(), index: c.index.slice() };
	var k = keepPoints(clone, u, { inPlace: true });
	assert.deepEqual(Array.from(k.index), Array.from(s[0].index));
	assert.deepEqual(Array.from(k.positions), Array.from(s[0].positions));
	assert.equal(k.positions.buffer, clone.positions.buffer);
});
test("mergePoints accepts a Node Buffer column and names the list position of a k clash", function () {
	var m = mergePoints([{ count: 2, v: Buffer.from([1, 2]) }, { count: 1, v: new Uint8Array([3]) }]);
	assert.ok(m.v instanceof Uint8Array);
	assert.deepEqual(Array.from(m.v), [1, 2, 3]);
	var a = { count: 2, p: new Float32Array(2) };
	expectCode(function () { mergePoints([a, a, { count: 2, p: new Float32Array(6) }]); }, /list\[2\]/);
});
