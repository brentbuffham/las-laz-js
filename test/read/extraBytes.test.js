// test/read/extraBytes.test.js
//==========================================================
// Reading extra-bytes columns: files written by the test helper with
// its own DataView code, every value computed here from a formula;
// each type in formats 0, 3, 6 and 8 at UTM offsets; scaled fields
// as Float64 with no-data NaN; arrays interleaved; raw bytes exact;
// the default fields unchanged; filters, thinning, chunks, scratch
// and the Worker agree with readPoints; PDAL's LAZ fixtures; a bad
// VLR reported.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { DEFAULT_FIELDS } from "../../src/read/decodeRecords.js";
import { createWorkerHandler } from "../../src/workers/workerProtocol.js";
import { openScratchReader } from "../../src/io/ScratchBinaryFile.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";
import { descriptorBytes, lasWithExtra } from "../helpers/extraBytes.js";
import { LAZ_FIXTURES } from "../helpers/lazFixtureData.js";
import { fixtureBytes } from "../helpers/lazFixtureFiles.js";

// [name, code, size, DataView setter, the typed array a column comes back in]
var T = [
	["u8", 1, 1, "setUint8", Uint8Array], ["i8", 2, 1, "setInt8", Int8Array],
	["u16", 3, 2, "setUint16", Uint16Array], ["i16", 4, 2, "setInt16", Int16Array],
	["u32", 5, 4, "setUint32", Uint32Array], ["i32", 6, 4, "setInt32", Int32Array],
	["u64", 7, 8, "setBigUint64", BigUint64Array], ["i64", 8, 8, "setBigInt64", BigInt64Array],
	["f32", 9, 4, "setFloat32", Float32Array], ["f64", 10, 8, "setFloat64", Float64Array]
];
var RANGE = { u8: [0, 255], i8: [-128, 127], u16: [0, 65535], i16: [-32768, 32767], u32: [0, 4294967295], i32: [-2147483648, 2147483647] };
// point i's raw value of a type: the type's min and max at points 0 and 1, then spread through it
function rawValue(type, i) {
	if (type === "u64") return i === 0 ? 0n : i === 1 ? 2n ** 64n - 1n : BigInt(i) * 123456789012345n;
	if (type === "i64") return i === 0 ? -(2n ** 63n) : i === 1 ? 2n ** 63n - 1n : BigInt(i - 20) * 98765432109876n;
	if (type === "f32") return Math.fround(i * 1.25 - 7.5);
	if (type === "f64") return i * 1e10 + 0.123;
	var r = RANGE[type];
	return i === 0 ? r[0] : i === 1 ? r[1] : r[0] + (i * 7919) % (r[1] - r[0]);
}
function points(n, fmt) {
	var out = [];
	for (var i = 0; i < n; i++) out.push({ x: 477000 + i * 0.5, y: 6770000 + (i % 7), z: 300 + i * 0.01, intensity: i, returnNumber: 1, numberOfReturns: 1, classification: 2 + (i % 3), red: i, green: i, blue: i, gpsTime: i });
	return out;
}
var UTM = { scale: { x: 0.001, y: 0.001, z: 0.001 }, offset: { x: 477000, y: 6770000, z: 300 } };
// every type 1-10, one field each, values by rawValue
function everyType(fmt, version, n) {
	var size = T.reduce(function (s, t) { return s + t[2]; }, 0);
	return lasWithExtra(Object.assign({ version: version, pointFormat: fmt, points: points(n, fmt), extraSize: size,
		descriptors: T.map(function (t) { return descriptorBytes({ code: t[1], name: "f_" + t[0] }); }),
		fill: function (i, v, rec, base) { var at = rec + base; T.forEach(function (t) { v[t[3]](at, rawValue(t[0], i), true); at += t[2]; }); } }, UTM));
}

test("each type decodes at UTM offsets in formats 0, 3, 6 and 8", async function () {
	for (var c of [[0, "1.2"], [3, "1.2"], [6, "1.4"], [8, "1.4"]]) {
		var las = await openLas(everyType(c[0], c[1], 40));
		assert.equal(las.extraBytesProblem, null);
		var p = await las.readPoints({ fields: ["x", "extra"] });
		T.forEach(function (t) {
			var col = p["f_" + t[0]];
			assert.ok(col instanceof t[4], "format " + c[0] + " " + t[0] + " is " + t[4].name);
			assert.deepEqual(Array.from(col), Array.from({ length: 40 }, function (_, i) { return rawValue(t[0], i); }), "format " + c[0] + " " + t[0]);
		});
		assert.ok(Math.abs(p.x[39] - (477000 + 39 * 0.5)) < 1e-9);
	}
});

test("scaled fields are Float64, no-data NaN; an unscaled one keeps its no-data value", async function () {
	var raw = [[-2147483648, 12345, -7], [7, 65534, 3], [1.5, -2, 0]];
	var bytes = lasWithExtra(Object.assign({ pointFormat: 6, points: points(3), extraSize: 12,
		descriptors: [descriptorBytes({ code: 6, name: "a", scale: 0.001, offset: 500, noData: -2147483648 }), descriptorBytes({ code: 3, name: "b", scale: 0.5 }),
			descriptorBytes({ code: 9, name: "c", offset: 10 }), descriptorBytes({ code: 3, name: "d", noData: 65535 })],
		fill: function (i, v, rec, base) { v.setInt32(rec + base, raw[0][i], true); v.setUint16(rec + base + 4, raw[1][i], true); v.setFloat32(rec + base + 6, raw[2][i], true); v.setUint16(rec + base + 10, i === 1 ? 65535 : i, true); } }, UTM));
	var p = await (await openLas(bytes)).readPoints({ fields: ["extra"] });
	assert.ok(p.a instanceof Float64Array && p.b instanceof Float64Array && p.c instanceof Float64Array);
	assert.ok(Number.isNaN(p.a[0]));
	assert.equal(p.a[1], 12345 * 0.001 + 500); assert.equal(p.a[2], -7 * 0.001 + 500);
	assert.deepEqual(Array.from(p.b), [3.5, 32767, 1.5]);
	assert.deepEqual(Array.from(p.c), [11.5, 8, 10]);
	assert.ok(p.d instanceof Uint16Array);
	assert.deepEqual(Array.from(p.d), [0, 65535, 2]);
});

test("array fields are interleaved, k values a point", async function () {
	var bytes = lasWithExtra(Object.assign({ pointFormat: 6, points: points(5), extraSize: 6, descriptors: [descriptorBytes({ code: 23, name: "dir" })],
		fill: function (i, v, rec, base) { for (var j = 0; j < 3; j++) v.setUint16(rec + base + 2 * j, 100 * i + j, true); } }, UTM));
	var las = await openLas(bytes);
	assert.deepEqual([las.extraBytes[0].type, las.extraBytes[0].k], ["u16", 3]);
	var p = await las.readPoints({ fields: ["x", "dir"] });
	assert.ok(p.dir instanceof Uint16Array);
	assert.equal(p.dir.length, 15);
	for (var i = 0; i < 5; i++) for (var j = 0; j < 3; j++) assert.equal(p.dir[3 * i + j], 100 * i + j);
});

test("raw bytes come back exact", async function () {
	var bytes = lasWithExtra(Object.assign({ pointFormat: 3, version: "1.2", points: points(6), extraSize: 5, descriptors: [descriptorBytes({ code: 0, name: "spare", size: 3 })],
		fill: function (i, v, rec, base) { for (var j = 0; j < 5; j++) v.setUint8(rec + base + j, (i * 31 + j * 7) % 256); } }, UTM));
	var p = await (await openLas(bytes)).readPoints({ fields: ["extra"] });
	assert.equal(p.spare.length, 18); assert.equal(p.extraBytes.length, 12);
	for (var i = 0; i < 6; i++) {
		for (var j = 0; j < 3; j++) assert.equal(p.spare[3 * i + j], (i * 31 + j * 7) % 256);
		for (j = 0; j < 2; j++) assert.equal(p.extraBytes[2 * i + j], (i * 31 + (j + 3) * 7) % 256);
	}
});

test("default fields are unchanged", async function () {
	var p = await (await openLas(everyType(3, "1.2", 10))).readPoints();
	assert.deepEqual(Object.keys(p).filter(function (k) { return ArrayBuffer.isView(p[k]); }).sort(), DEFAULT_FIELDS.concat(["red", "green", "blue"]).slice().sort());
});

test("named fields, \"extra\" and unknown names", async function () {
	var las = await openLas(everyType(6, "1.4", 10));
	var p = await las.readPoints({ fields: ["f_u16"] });
	assert.deepEqual(Object.keys(p).filter(function (k) { return ArrayBuffer.isView(p[k]); }), ["f_u16"]);
	await assert.rejects(las.readPoints({ fields: ["nope"] }), { code: "INVALID_ARGUMENT", message: /nope.*extra columns: f_u8, f_i8/ });
	// a file with no extras: the message is as before
	await assert.rejects((await openLas(lasWithExtra({ points: points(2), extraSize: 0 }))).readPoints({ fields: ["nope"] }), function (e) { return e.code === "INVALID_ARGUMENT" && !/extra columns/.test(e.message); });
});

test("filters, thinning and the other read paths agree with readPoints", async function () {
	var bytes = lasWithExtra(Object.assign({ pointFormat: 6, points: points(300), extraSize: 6,
		descriptors: [descriptorBytes({ code: 3, name: "w" }), descriptorBytes({ code: 6, name: "h", scale: 0.01, offset: 2 })],
		fill: function (i, v, rec, base) { v.setUint16(rec + base, i * 3, true); v.setInt32(rec + base + 2, i * 11 - 900, true); } }, UTM));
	var las = await openLas(bytes, { windowSize: 1000 });
	var cases = [{ classes: [3] }, { bounds: { minX: 477010, maxX: 477100, minY: -Infinity, maxY: Infinity, minZ: -Infinity, maxZ: Infinity } }, { maxPoints: 7 }, { classes: [2, 4], maxPoints: 9 }];
	for (var c of cases) {
		var p = await las.readPoints(Object.assign({ fields: ["index", "x", "extra"] }, c));
		assert.ok(p.count > 0 && p.count < 300, JSON.stringify(c));
		for (var i = 0; i < p.count; i++) {
			var s = p.index[i];
			assert.equal(p.w[i], s * 3, JSON.stringify(c) + " w " + i);
			assert.equal(p.h[i], (s * 11 - 900) * 0.01 + 2, JSON.stringify(c) + " h " + i);
			assert.ok(Math.abs(p.x[i] - (477000 + s * 0.5)) < 1e-9);
		}
	}
	var all = await las.readPoints({ fields: ["x", "extra"] });
	// chunks, joined
	var w = [], h = [];
	for await (var ch of las.chunks({ fields: ["x", "extra"] })) { w.push.apply(w, Array.from(ch.w)); h.push.apply(h, Array.from(ch.h)); }
	assert.deepEqual(w, Array.from(all.w)); assert.deepEqual(h, Array.from(all.h));
	// scratch files hold the columns' bytes
	var root = createFakeRoot(), res = await las.readPointsToScratch({ fields: ["w", "h"], root: root, prefix: "eb" });
	assert.deepEqual([res.types.w, res.types.h], ["Uint16Array", "Float64Array"]);
	for (var f of ["w", "h"]) {
		var r = await openScratchReader(res.fields[f], { root: root });
		var got = r.slice(0, r.length()).slice();
		r.close();
		assert.deepEqual(Array.from(got), Array.from(new Uint8Array(all[f].buffer, all[f].byteOffset, all[f].byteLength)), f);
	}
	// the Worker
	var msgs = [], handle = createWorkerHandler(function (m) { msgs.push(m); });
	await handle({ id: 1, type: "open", payload: { bytes: bytes } });
	var opened = msgs.pop().result;
	assert.deepEqual(opened.extraBytes.map(function (e) { return e.column; }), ["w", "h"]);
	assert.equal(opened.extraBytesProblem, null);
	await handle({ id: 2, type: "readPoints", payload: { fields: ["x", "extra"] } });
	var wr = msgs.pop().result;
	assert.deepEqual(Array.from(wr.w), Array.from(all.w)); assert.deepEqual(Array.from(wr.h), Array.from(all.h));
});

test("PDAL's LAZ files decode their extra bytes", async function () {
	for (var name of ["f3x", "f7x"]) {
		var fx = LAZ_FIXTURES.find(function (f) { return f.name === name; });
		var las = await openLas(fixtureBytes(name), { threads: 1 });
		assert.deepEqual(las.extraBytes.map(function (e) { return [e.column, e.type]; }), [["extra0", "u8"], ["extra1", "u8"], ["extra2", "u8"]]);
		var p = await las.readPoints({ fields: ["extra"] });
		assert.equal(p.count, fx.points);
		for (var i = 0; i < p.count; i++) for (var j = 0; j < 3; j++) assert.equal(p["extra" + j][i], (i * (j + 3) + (i >> 4)) % 256, name + " " + i + " " + j);
	}
});

test("the reader reports a bad VLR and reads the bytes raw", async function () {
	var bytes = lasWithExtra(Object.assign({ pointFormat: 6, points: points(4), extraSize: 2, descriptors: [descriptorBytes({ code: 5, name: "too big" })],
		fill: function (i, v, rec, base) { v.setUint8(rec + base, i); v.setUint8(rec + base + 1, 200 + i); } }, UTM));
	var las = await openLas(bytes);
	assert.match(las.extraBytesProblem, /describes 4 bytes but records have 2/);
	assert.deepEqual(las.extraBytes.map(function (e) { return [e.column, e.type, e.size]; }), [["extraBytes", "raw", 2]]);
	var p = await las.readPoints({ fields: ["extraBytes"] });
	assert.deepEqual(Array.from(p.extraBytes), [0, 200, 1, 201, 2, 202, 3, 203]);
});
