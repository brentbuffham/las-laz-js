// test/ops/transform.test.js
//==========================================================
// makeTransform, transformPoints and the transform on read. Expected
// values are worked by hand (or in plain Float64 from the file's
// world coordinates), never taken from the code under test.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTransform, transformPoints, applyTransform, checkTransform, transformBounds } from "../../src/ops/transform.js";
import { thinSelection } from "../../src/ops/select.js";
import * as lib from "../../src/index.js";
import { openLas } from "../../src/LasReader.js";
import { LasError, ERROR_CODES } from "../../src/errors.js";
import { buildLas } from "../helpers/buildLas.js";
import { LAZ_MANIFEST, fixtureBytes } from "../helpers/lazFixtureFiles.js";
import { createWorkerHandler } from "../../src/workers/workerProtocol.js";

function apply(T, x, y, z) { return Array.from(applyTransform(T, x, y, z, [0, 0, 0])); }
function invalid(fn, part) {
	assert.throws(fn, function (e) { return e instanceof LasError && e.code === ERROR_CODES.INVALID_ARGUMENT && e.message.indexOf(part) >= 0; });
}

test("the package exports makeTransform and transformPoints only", function () {
	assert.equal(typeof lib.makeTransform, "function");
	assert.equal(typeof lib.transformPoints, "function");
	assert.equal(lib.applyTransform, undefined);
	assert.equal(lib.checkTransform, undefined);
});

test("rotateZ 90 is exact and anticlockwise", function () {
	var T = makeTransform({ rotateZ: 90 });
	assert.deepEqual(T.m, [0, -1, 0, 1, 0, 0, 0, 0, 1]);
	assert.deepEqual(T.t, [0, 0, 0]);
	assert.deepEqual(apply(T, 1, 0, 0), [0, 1, 0]);
});
test("whole multiples of 90 degrees are exact, negative and above 360 too", function () {
	var cases = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1], 360: [1, 0], 450: [0, 1], 720: [1, 0], "-90": [0, -1], "-180": [-1, 0], "-270": [0, 1], "-360": [1, 0], "-450": [0, -1] };
	Object.keys(cases).forEach(function (deg) {
		var c = cases[deg][0], s = cases[deg][1];
		assert.deepEqual(makeTransform({ rotateZ: Number(deg) }).m, [c, -s + 0, 0, s, c, 0, 0, 0, 1], "rotateZ " + deg);
	});
});
test("other angles use cos and sin", function () {
	var m = makeTransform({ rotateZ: 30 }).m;
	assert.ok(Math.abs(m[0] - Math.sqrt(3) / 2) < 1e-15 && Math.abs(m[1] + 0.5) < 1e-15 && Math.abs(m[3] - 0.5) < 1e-15 && Math.abs(m[4] - Math.sqrt(3) / 2) < 1e-15);
});
test("the default is the identity", function () {
	var T = makeTransform();
	assert.deepEqual(T.m, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
	assert.deepEqual(T.t, [0, 0, 0]);
	assert.deepEqual(makeTransform({}).m, T.m);
});
test("a rotate matrix is used as given", function () {
	// 90 degrees about +X: y -> z, z -> -y
	var R = [1, 0, 0, 0, 0, -1, 0, 1, 0];
	var T = makeTransform({ rotate: R, shift: [1, 2, 3] });
	assert.deepEqual(T.m, R);
	assert.deepEqual(apply(T, 0, 1, 0), [1, 2, 4]);
	assert.deepEqual(apply(T, 0, 0, 1), [1, 1, 3]);
});
test("rotation about a point", function () { assert.deepEqual(apply(makeTransform({ rotateZ: 90, about: [10, 20, 0] }), 11, 20, 5), [10, 21, 5]); });
test("scale about a point", function () { assert.deepEqual(apply(makeTransform({ scale: 2, about: [1, 1, 1] }), 2, 2, 2), [3, 3, 3]); });
test("composition order: rotate about, then scale, then shift", function () {
	assert.deepEqual(apply(makeTransform({ rotateZ: 90, shift: [10, 0, 0] }), 1, 0, 0), [10, 1, 0]);
	assert.deepEqual(apply(makeTransform({ rotateZ: 180, scale: 3, about: [1, 0, 0], shift: [0, 0, 1] }), 2, 0, 0), [-2, 0, 1]);
});

test("a hand-computed affine through transformPoints", function () {
	var T = { m: [1, 2, 0, 0, 1, 0, 0, 0, 2], t: [5, -1, 0.5] };
	var c = { count: 2, x: new Float64Array([1, -2]), y: new Float64Array([3, 0]), z: new Float64Array([4, 1]), cls: new Uint8Array([2, 6]) };
	var r = transformPoints(c, T);
	assert.deepEqual(Array.from(r.x), [12, 3]); assert.deepEqual(Array.from(r.y), [2, -1]); assert.deepEqual(Array.from(r.z), [8.5, 2.5]);
	assert.equal(r.count, 2);
	assert.equal(r.cls, c.cls);              // shared by reference
	assert.equal(c.x[0], 1);                 // copy by default
	assert.deepEqual(Array.from(c.y), [3, 0]);
	var inPlace = transformPoints(c, T, { inPlace: true });
	assert.notEqual(inPlace, c);                  // a new object ...
	assert.equal(inPlace.x, c.x); assert.equal(inPlace.y, c.y); assert.equal(inPlace.z, c.z);   // ... holding the input arrays
	assert.equal(inPlace.cls, c.cls); assert.equal(inPlace.count, 2);
	assert.deepEqual(Object.keys(inPlace), ["count", "x", "y", "z", "cls"]);
	assert.deepEqual(Array.from(c.x), [12, 3]); assert.deepEqual(Array.from(c.y), [2, -1]); assert.deepEqual(Array.from(c.z), [8.5, 2.5]);
});
test("transformPoints computes in Float64 and stores in each column's own type", function () {
	var T = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0.5, 0, 0] };
	var c = { count: 2, x: new Float32Array([1, 2]), y: new Float64Array([1, 2]), z: new Float32Array([1, 2]) };
	var r = transformPoints(c, T);
	assert.ok(r.x instanceof Float32Array && r.y instanceof Float64Array && r.z instanceof Float32Array);
	assert.deepEqual(Array.from(r.x), [1.5, 2.5]);
	// each value is rounded to Float32 once, from the Float64 result
	var f = { count: 1, x: new Float32Array([16777216]), y: new Float32Array([0]), z: new Float32Array([0]) };
	var T3 = { m: [0.5, 0, 0, 0, 1, 0, 0, 0, 1], t: [0.25, 0, 0] };
	assert.equal(transformPoints(f, T3).x[0], Math.fround(16777216 * 0.5 + 0.25));
});
test("transformPoints on zero points", function () {
	var r = transformPoints({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }, makeTransform({ shift: [1, 1, 1] }));
	assert.equal(r.count, 0); assert.equal(r.x.length, 0);
});

test("bad transforms throw", function () {
	var c = { count: 1, x: new Float64Array(1), y: new Float64Array(1), z: new Float64Array(1) };
	invalid(function () { makeTransform({ rotate: [1, 0, 0, 0, 1, 0, 0, 0, 1], rotateZ: 10 }); }, "rotate");
	invalid(function () { makeTransform({ rotate: [1, 0, 0, 0, 1, 0, 0, 1] }); }, "rotate");
	invalid(function () { makeTransform({ rotate: [1, 0, 0, 0, 1, 0, 0, 0, NaN] }); }, "rotate");
	invalid(function () { makeTransform({ rotateZ: Infinity }); }, "rotateZ");
	invalid(function () { makeTransform({ scale: NaN }); }, "scale");
	invalid(function () { makeTransform({ scale: "2" }); }, "scale");
	invalid(function () { makeTransform({ shift: [1, 2] }); }, "shift");
	invalid(function () { makeTransform({ about: [1, 2, NaN] }); }, "about");
	invalid(function () { makeTransform(5); }, "options");
	invalid(function () { transformPoints(c, { m: [1, 0, 0, 0, 1, 0, 0, 0], t: [0, 0, 0] }); }, "m");
	invalid(function () { transformPoints(c, { m: [1, 0, 0, 0, 1, 0, 0, 0, NaN], t: [0, 0, 0] }); }, "m");
	invalid(function () { transformPoints(c, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0] }); }, "t");
	invalid(function () { transformPoints(c, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, Infinity] }); }, "t");
	invalid(function () { transformPoints(c, null); }, "transform");
	invalid(function () { checkTransform({}, "T"); }, "T.m");
	var ok = checkTransform({ m: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: new Float32Array(3) }, "T");
	assert.equal(ok.m.length, 9);
	invalid(function () { transformPoints({ count: 1, x: new Float64Array(1), y: new Float64Array(1) }, makeTransform()); }, "transformPoints needs x, y and z");
	invalid(function () { transformPoints({ count: 1, x: new Float64Array(1), y: new Float64Array(1), z: new Float64Array(3) }, makeTransform()); }, "transformPoints needs x, y and z");
	invalid(function () { transformPoints({ count: 1, x: new Float64Array(1), y: new Float64Array(1), z: [0] }, makeTransform()); }, "transformPoints needs x, y and z");
	invalid(function () { transformPoints({ count: 1, x: new Float64Array(1), y: new Float64Array(1), z: new Float64Array(2) }, makeTransform()); }, "transformPoints needs x, y and z");   // k = 2 is not a coordinate column
	invalid(function () { transformPoints({ count: 1, x: new BigInt64Array(1), y: new Float64Array(1), z: new Float64Array(1) }, makeTransform()); }, "BigInt");
	invalid(function () { transformPoints({ count: 1, x: new Float64Array(1), y: new Float64Array(1), z: new BigUint64Array(1) }, makeTransform(), { inPlace: true }); }, "BigInt");
});

// ---- on read ----
var SCALE = { x: 0.001, y: 0.001, z: 0.001 };
var OFFSET = { x: 500000, y: 7000000, z: 0 };
function utmPoints() {
	var pts = [];
	for (var i = 0; i < 500; i++) pts.push({ x: 500000 + (i * 200) / 499 + (i % 7) * 0.001, y: 7000000 + ((i * 37) % 500) * 0.4 + (i % 5) * 0.001, z: 300 + (i % 11) * 1.003, classification: 2, returnNumber: 1, numberOfReturns: 1 });
	return pts;
}
function las500() { return openLas(buildLas({ version: "1.2", pointFormat: 0, scale: SCALE, offset: OFFSET, points: utmPoints() }), { threads: 1 }); }

test("transform on read: Float64 first, then localOrigin, then Float32 (sub-millimetre at UTM)", async function () {
	var las = await las500();
	var T = makeTransform({ rotateZ: 33.3, about: [500100, 7000100, 0], shift: [0.25, -0.75, 2] });
	var origin = { x: 500100, y: 7000100, z: 300 };
	var raw = await las.readPoints({ fields: ["x", "y", "z"] });      // world Float64, no transform
	var r = await las.readPoints({ fields: ["x", "y", "z"], transform: T, localOrigin: origin, float32: true });
	assert.equal(r.count, 500);
	assert.ok(r.x instanceof Float32Array && r.y instanceof Float32Array && r.z instanceof Float32Array);
	// expected, by hand in Float64: T(world) - origin, with T as the formula p' = R (p - a) + a + d
	var th = (33.3 * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
	var ex = new Float64Array(500), ey = new Float64Array(500), ez = new Float64Array(500);
	for (var i = 0; i < 500; i++) {
		var dx = raw.x[i] - 500100, dy = raw.y[i] - 7000100, dz = raw.z[i];
		ex[i] = c * dx - s * dy + 500100 + 0.25 - origin.x;
		ey[i] = s * dx + c * dy + 7000100 - 0.75 - origin.y;
		ez[i] = dz + 2 - origin.z;
		assert.ok(Math.abs(r.x[i] - ex[i]) < 0.0005, "x " + i);
		assert.ok(Math.abs(r.y[i] - ey[i]) < 0.0005, "y " + i);
		assert.ok(Math.abs(r.z[i] - ez[i]) < 0.0005, "z " + i);
	}
	// bounds are of the output, in world (origin added back)
	var mn = function (a, o) { return Math.min.apply(null, a) + o; }, mx = function (a, o) { return Math.max.apply(null, a) + o; };
	var tol = 1e-6 + 0.0005;       // the output holds Float32 values
	assert.ok(Math.abs(r.bounds.minX - mn(ex, origin.x)) < tol);
	assert.ok(Math.abs(r.bounds.maxX - mx(ex, origin.x)) < tol);
	assert.ok(Math.abs(r.bounds.minY - mn(ey, origin.y)) < tol);
	assert.ok(Math.abs(r.bounds.maxY - mx(ey, origin.y)) < tol);
	assert.ok(Math.abs(r.bounds.minZ - mn(ez, origin.z)) < tol);
	assert.ok(Math.abs(r.bounds.maxZ - mx(ez, origin.z)) < tol);
	// a Float64 read with the same transform matches the hand values to 1e-9, bounds to 1e-6
	var r64 = await las.readPoints({ fields: ["x", "y", "z"], transform: T, localOrigin: origin });
	assert.ok(r64.x instanceof Float64Array);
	for (var j = 0; j < 500; j++) {
		assert.ok(Math.abs(r64.x[j] - ex[j]) < 1e-9 && Math.abs(r64.y[j] - ey[j]) < 1e-9 && Math.abs(r64.z[j] - ez[j]) < 1e-9);
	}
	assert.ok(Math.abs(r64.bounds.minX - mn(ex, origin.x)) < 1e-6 && Math.abs(r64.bounds.maxX - mx(ex, origin.x)) < 1e-6);
	assert.ok(Math.abs(r64.bounds.minY - mn(ey, origin.y)) < 1e-6 && Math.abs(r64.bounds.maxY - mx(ey, origin.y)) < 1e-6);
	assert.ok(Math.abs(r64.bounds.minZ - mn(ez, origin.z)) < 1e-6 && Math.abs(r64.bounds.maxZ - mx(ez, origin.z)) < 1e-6);
});
test("a transform with only one coordinate asked for still uses all three world coordinates", async function () {
	var las = await las500();
	var T = makeTransform({ rotateZ: 90, about: [500100, 7000100, 0] });
	var all = await las.readPoints({ fields: ["x", "y", "z"], transform: T });
	var onlyX = await las.readPoints({ fields: ["x"], transform: T });
	assert.deepEqual(Array.from(onlyX.x), Array.from(all.x));
	// z' = x (the matrix row 3 is [1 0 0])
	var onlyZ = await las.readPoints({ fields: ["z"], transform: makeTransform({ rotate: [1, 0, 0, 0, 1, 0, 1, 0, 0] }) });
	var raw = await las.readPoints({ fields: ["x"] });
	for (var j = 0; j < 500; j++) assert.ok(Math.abs(onlyZ.z[j] - raw.x[j]) < 1e-9, "z' = x at " + j);
});
test("a null or identity transform reads as without", async function () {
	var las = await las500();
	var a = await las.readPoints({ fields: ["x", "y", "z"] });
	var b = await las.readPoints({ fields: ["x", "y", "z"], transform: null });
	var c = await las.readPoints({ fields: ["x", "y", "z"], transform: makeTransform() });
	assert.deepEqual(Array.from(b.x), Array.from(a.x));
	for (var i = 0; i < 500; i++) assert.ok(Math.abs(c.x[i] - a.x[i]) < 1e-9 && Math.abs(c.y[i] - a.y[i]) < 1e-9 && Math.abs(c.z[i] - a.z[i]) < 1e-9);
});
test("filters on read apply in file coordinates", async function () {
	var las = await las500();
	var T = makeTransform({ shift: [1000, 0, 0] });
	var box = { minX: 500000, maxX: 500100 };
	var plain = await las.readPoints({ fields: ["index", "x", "y"], bounds: box });
	var moved = await las.readPoints({ fields: ["index", "x", "y"], bounds: box, transform: T });
	assert.ok(plain.count > 0 && plain.count < 500);
	assert.deepEqual(Array.from(moved.index), Array.from(plain.index));
	for (var i = 0; i < plain.count; i++) {
		assert.ok(Math.abs(moved.x[i] - (plain.x[i] + 1000)) < 1e-9);
		assert.ok(Math.abs(moved.y[i] - plain.y[i]) < 1e-9);
	}
	assert.ok(Math.abs(moved.bounds.minX - (plain.bounds.minX + 1000)) < 1e-6);
});
test("transform with float32 but no localOrigin stays Float64", async function () {
	var las = await las500();
	var r = await las.readPoints({ fields: ["x", "y", "z"], transform: makeTransform({ shift: [1, 2, 3] }), float32: true });
	assert.ok(r.x instanceof Float64Array);
});
test("chunks pass the transform through", async function () {
	var las = await las500();
	var T = makeTransform({ rotateZ: 45, shift: [5, 5, 5] });
	var whole = await las.readPoints({ fields: ["x", "y", "z"], transform: T });
	var n = 0;
	for await (var c of las.chunks({ fields: ["x", "y", "z"], transform: T })) {
		for (var i = 0; i < c.count; i++) { assert.equal(c.x[i], whole.x[n + i]); assert.equal(c.y[i], whole.y[n + i]); }
		n += c.count;
	}
	assert.equal(n, 500);
});
test("a bad transform on read throws INVALID_ARGUMENT", async function () {
	var las = await las500();
	await assert.rejects(las.readPoints({ transform: { m: [1], t: [0, 0, 0] } }), function (e) { return e instanceof LasError && e.code === ERROR_CODES.INVALID_ARGUMENT && e.message.indexOf("transform.m") >= 0; });
});

// ---- transformBounds and the worker's colour range ----
test("transformBounds: a 90 degree rotation about X swaps the Y and Z ranges", function () {
	// y2 = -z, z2 = y
	var R = [1, 0, 0, 0, 0, -1, 0, 1, 0];
	var box = { minX: 0, maxX: 10, minY: 0, maxY: 20, minZ: 0, maxZ: 30 };
	assert.deepEqual(transformBounds(makeTransform({ rotate: R }), box), { minX: 0, maxX: 10, minY: -30, maxY: 0, minZ: 0, maxZ: 20 });
	assert.deepEqual(transformBounds(makeTransform({ rotate: R, shift: [1, 2, 3] }), box), { minX: 1, maxX: 11, minY: -28, maxY: 2, minZ: 3, maxZ: 23 });
	// 45 degrees about Z: the unit square becomes a diamond, x from -sqrt(2)/2 to sqrt(2)/2, y from 0 to sqrt(2)
	var d = transformBounds(makeTransform({ rotateZ: 45 }), { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 5, maxZ: 6 });
	assert.ok(Math.abs(d.minX + Math.SQRT1_2) < 1e-12 && Math.abs(d.maxX - Math.SQRT1_2) < 1e-12);
	assert.ok(Math.abs(d.minY) < 1e-12 && Math.abs(d.maxY - Math.SQRT2) < 1e-12);
	assert.equal(d.minZ, 5); assert.equal(d.maxZ, 6);
});
function workerFile(n) {
	var pts = [];
	for (var i = 0; i < n; i++) pts.push({ x: 1000 + i, y: 2000 + i, z: i, classification: 2 });
	return new Blob([buildLas({ version: "1.2", pointFormat: 0, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: pts })]);
}
function chunksOf(msgs, id) { return msgs.filter(function (m) { return m.id === id && m.type === "chunk"; }).map(function (m) { return m.chunk; }); }
test("worker chunks colour by elevation over the transformed Z range", async function () {
	var msgs = [];
	var handle = createWorkerHandler(function (m) { msgs.push(m); });
	await handle({ id: 1, type: "open", payload: { blob: workerFile(100), windowSize: 20 * 10 } });   // 10 windows; z = 0..99, y = 2000..2099
	// y2 = -z, z2 = y: after the transform Z runs 2000..2099, not 0..99
	var rot = makeTransform({ rotate: [1, 0, 0, 0, 0, -1, 0, 1, 0] });
	await handle({ id: 2, type: "chunks", payload: { fields: ["z"], transform: rot, colour: { by: "elevation" } } });
	var chunks = chunksOf(msgs, 2);
	assert.equal(chunks.length, 10);
	// z2 = 2009 -> t = 9 / 99 -> green floor(t * 4 * 255) = 92; z2 = 2010 -> t = 10 / 99 -> green 103
	// (a range of the untransformed header box, 0..99, would clamp both to the top colour)
	assert.deepEqual(Array.from(chunks[0].colours.subarray(27, 30)), [0, 92, 255]);
	assert.deepEqual(Array.from(chunks[1].colours.subarray(0, 3)), [0, 103, 255]);
	// a localOrigin shifts the points and the range alike
	await handle({ id: 3, type: "chunks", payload: { fields: ["z"], transform: rot, localOrigin: { x: 0, y: 0, z: 2000 }, colour: { by: "elevation" } } });
	assert.deepEqual(Array.from(chunksOf(msgs, 3)[0].colours.subarray(27, 30)), [0, 92, 255]);
	// no transform: the file's Z range as before
	await handle({ id: 4, type: "chunks", payload: { fields: ["z"], colour: { by: "elevation" } } });
	assert.deepEqual(Array.from(chunksOf(msgs, 4)[0].colours.subarray(27, 30)), [0, 92, 255]);
	// a bad transform is an INVALID_ARGUMENT error message
	await handle({ id: 5, type: "chunks", payload: { fields: ["z"], transform: { m: [1], t: [0, 0, 0] }, colour: { by: "elevation" } } });
	assert.equal(msgs.filter(function (m) { return m.id === 5; }).pop().code, "INVALID_ARGUMENT");
});

// ---- more transform-on-read ----
function mixedLas() {
	var pts = utmPoints().map(function (p, i) { p.classification = i % 3 === 0 ? 2 : (i % 3 === 1 ? 6 : 1); return p; });
	return openLas(buildLas({ version: "1.2", pointFormat: 0, scale: SCALE, offset: OFFSET, points: pts }), { threads: 1 });
}
test("classes and polygon filters under a transform pick the same points (by index) as without", async function () {
	var las = await mixedLas();
	var T = makeTransform({ rotateZ: 71, about: [500100, 7000100, 0], shift: [300, -200, 5], scale: 1.5 });
	// a triangle in file coordinates covering part of the cloud
	var polygon = [500000, 7000000, 500150, 7000000, 500000, 7000150];
	var cases = [{ classes: [2] }, { classes: [2, 6] }, { polygon: polygon }, { polygon: polygon, boundary: "inside" }, { classes: [6], polygon: polygon }];
	for (var opts of cases) {
		var fields = ["index", "x", "y", "z", "classification"];
		var plain = await las.readPoints(Object.assign({ fields: fields }, opts));
		var moved = await las.readPoints(Object.assign({ fields: fields, transform: T }, opts));
		assert.ok(plain.count > 0 && plain.count < 500, JSON.stringify(Object.keys(opts)) + " keeps part of the cloud (" + plain.count + ")");
		assert.deepEqual(Array.from(moved.index), Array.from(plain.index));
		assert.deepEqual(Array.from(moved.classification), Array.from(plain.classification));
		var expect = transformPoints(plain, T);
		for (var i = 0; i < plain.count; i++) {
			assert.ok(Math.abs(moved.x[i] - expect.x[i]) < 1e-9 && Math.abs(moved.y[i] - expect.y[i]) < 1e-9 && Math.abs(moved.z[i] - expect.z[i]) < 1e-9);
		}
	}
});
test("maxPoints with a transform keeps the thinSelection points, transformed", async function () {
	var las = await las500();
	var T = makeTransform({ rotateZ: -20, about: [500100, 7000100, 0], shift: [10, 20, 30] });
	var all = await las.readPoints({ fields: ["index", "x", "y", "z"], transform: T });
	var thin = await las.readPoints({ fields: ["index", "x", "y", "z"], transform: T, maxPoints: 37 });
	var sel = thinSelection(all.count, 37);
	assert.equal(thin.count, 37);
	for (var j = 0; j < sel.length; j++) {
		assert.equal(thin.index[j], all.index[sel[j]]);
		assert.equal(thin.x[j], all.x[sel[j]]); assert.equal(thin.y[j], all.y[sel[j]]); assert.equal(thin.z[j], all.z[sel[j]]);
	}
});
test("every LAZ fixture read with a transform equals transformPoints of the plain read", async function () {
	var T = makeTransform({ rotateZ: 33.3, about: [10, 20, 0], shift: [0.25, -0.75, 2], scale: 1.0001 });
	for (var name of Object.keys(LAZ_MANIFEST)) {
		var las = await openLas(fixtureBytes(name), { threads: 1 });
		var plain = await las.readPoints({ fields: ["x", "y", "z", "classification"] });
		var moved = await las.readPoints({ fields: ["x", "y", "z", "classification"], transform: T });
		var expect = transformPoints(plain, T);
		assert.equal(moved.count, plain.count, name);
		assert.ok(moved.count > 0, name);
		for (var i = 0; i < plain.count; i++) {
			assert.ok(Math.abs(moved.x[i] - expect.x[i]) < 1e-9 && Math.abs(moved.y[i] - expect.y[i]) < 1e-9 && Math.abs(moved.z[i] - expect.z[i]) < 1e-9, name + " point " + i);
		}
		assert.deepEqual(Array.from(moved.classification), Array.from(plain.classification), name);
	}
});
