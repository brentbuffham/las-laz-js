// test/format/classLookup.test.js
//==========================================================
// The Classification Lookup VLR (LASF_Spec, record 0): 16-byte entries
// { uint8 ClassNumber; char Description[15] }, checked against bytes
// built by hand from the LAS 1.4 R15 table; parse(build(x)) = x; names
// round-trip through LAS and LAZ, writeLas and createLasWriter.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClassLookup, buildClassLookup } from "../../src/format/ClassLookup.js";
import { writeLas, createLasWriter } from "../../src/write/writeLas.js";
import { openLas } from "../../src/LasReader.js";
import * as lib from "../../src/index.js";
import { rng } from "../helpers/clouds.js";
import { buildLas } from "../helpers/buildLas.js";

function entry(code, name) {
	var e = new Uint8Array(16);
	e[0] = code;
	for (var i = 0; i < name.length; i++) e[1 + i] = name.charCodeAt(i);
	return Array.from(e);
}
function vlr(bytes) { return { userId: "LASF_Spec", recordId: 0, bytes: Uint8Array.from(bytes) }; }

test("bytes match the LAS 1.4 table layout", function () {
	var got = buildClassLookup({ 64: "Bench face", 2: "Ground" });
	assert.deepEqual(Array.from(got), entry(2, "Ground").concat(entry(64, "Bench face")));
	assert.equal(got.length, 32);
});

test("parse(build(x)) is x", function () {
	var r = rng(3);
	for (var t = 0; t < 50; t++) {
		var map = {}, k = 1 + Math.floor(r() * 20);
		for (var j = 0; j < k; j++) {
			var code = Math.floor(r() * 256), len = 1 + Math.floor(r() * 15), name = "";
			for (var c = 0; c < len; c++) name += String.fromCharCode(0x21 + Math.floor(r() * 94));
			if (r() < 0.3 && len < 15) name += " ";   // a trailing space is kept
			map[code] = name;
		}
		assert.deepEqual(parseClassLookup([vlr(buildClassLookup(map))]), map);
	}
});

test("empty descriptions are left out", function () {
	var bytes = [];
	for (var code = 0; code < 256; code++) bytes = bytes.concat(entry(code, code === 2 ? "Ground" : code === 64 ? "Bench face" : code === 200 ? "Crest" : ""));
	assert.deepEqual(parseClassLookup([vlr(bytes)]), { 2: "Ground", 64: "Bench face", 200: "Crest" });
});

test("only a LASF_Spec record 0 is read", function () {
	var other = { userId: "LASF_Projection", recordId: 0, bytes: Uint8Array.from(entry(2, "Ground")) };
	var rec1 = { userId: "LASF_Spec", recordId: 3, bytes: Uint8Array.from(entry(2, "Ground")) };
	assert.deepEqual(parseClassLookup([other, rec1]), {});
	assert.deepEqual(parseClassLookup([]), {});
	assert.deepEqual(parseClassLookup([other, vlr(entry(9, "Water"))]), { 9: "Water" });
});

test("a length not a multiple of 16 is BAD_VLR", function () {
	assert.throws(function () { parseClassLookup([vlr(new Array(20).fill(0))]); }, function (e) { return e.code === "BAD_VLR"; });
});

test("bad names and codes are refused", function () {
	assert.throws(function () { buildClassLookup({ 64: "Sixteen chars ab" }); }, /15/);
	assert.throws(function () { buildClassLookup({ 64: "Bänch" }); }, function (e) { return /ASCII/.test(e.message) && /64/.test(e.message) && e.code === "INVALID_ARGUMENT"; });
	assert.throws(function () { buildClassLookup({ 64: "" }); }, /64/);
	assert.throws(function () { buildClassLookup({ 64: 7 }); }, /64/);
	assert.throws(function () { buildClassLookup({ 256: "x" }); }, /code/);
	assert.throws(function () { buildClassLookup({ "-1": "x" }); }, /code/);
	assert.throws(function () { buildClassLookup({ 1.5: "x" }); }, /code/);
	assert.throws(function () { buildClassLookup(null); }, /classNames/);
});

function cloud(n, maxClass) {
	var c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), classification: new Uint8Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = 477000 + i; c.y[i] = 6770000 + i; c.z[i] = i * 0.5; c.classification[i] = (i * 7) % (maxClass + 1); }
	return c;
}
var NAMES = { 64: "Bench face", 65: "Crest" };

test("names round-trip through LAS and LAZ", async function () {
	for (var fmt of [1, 3, 6, 7]) {
		for (var compress of [false, true]) {
			var c = cloud(50, fmt < 6 ? 31 : 255);
			var bytes = await writeLas(c, { version: fmt < 6 ? "1.2" : "1.4", pointFormat: fmt, compress: compress, classNames: NAMES });
			var las = await openLas(bytes);
			assert.deepEqual(las.classNames, NAMES, "format " + fmt + (compress ? " LAZ" : ""));
			var back = await las.readPoints({ fields: ["classification"] });
			assert.deepEqual(back.classification, c.classification);
		}
	}
	// the streaming writer
	var s = cloud(30, 255), buf = [];
	var sink = { write: function (b, pos) { buf.push({ b: Uint8Array.from(b), pos: pos }); } };
	var w = await createLasWriter(sink, { version: "1.4", pointFormat: 6, scale: { x: 0.001, y: 0.001, z: 0.001 }, offset: { x: 477000, y: 6770000, z: 0 }, classNames: NAMES });
	await w.writePoints(s);
	await w.close();
	var size = buf.reduce(function (m, p) { return Math.max(m, p.pos + p.b.length); }, 0), file = new Uint8Array(size);
	buf.forEach(function (p) { file.set(p.b, p.pos); });
	assert.deepEqual((await openLas(file)).classNames, NAMES);
});

test("no VLR, no names", async function () {
	var las = await openLas(await writeLas(cloud(10, 31), {}));
	assert.deepEqual(las.classNames, {});
	assert.ok(!las.vlrs.some(function (r) { return r.userId === "LASF_Spec" && r.recordId === 0; }));
});

test("the writer refuses bad classNames before writing anything", async function () {
	await assert.rejects(writeLas(cloud(10, 31), { classNames: { 64: "Sixteen chars ab" } }), /15/);
	var wrote = 0, sink = { write: function () { wrote++; } };
	await assert.rejects(createLasWriter(sink, { scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, classNames: { 300: "x" } }), /code/);
	assert.equal(wrote, 0);
});

test("a malformed lookup VLR from other software still opens, with no names", async function () {
	var b = buildLas({ version: "1.2", pointFormat: 0, points: [{ x: 0, y: 0, z: 0 }], vlrs: [{ userId: "LASF_Spec", recordId: 0, description: "Classification", bytes: new Uint8Array(20) }] });
	var las = await openLas(b);
	assert.deepEqual(las.classNames, {});
	assert.equal((await las.readPoints({ fields: ["x"] })).count, 1);
	var good = buildLas({ version: "1.2", pointFormat: 0, points: [{ x: 0, y: 0, z: 0 }], vlrs: [{ userId: "LASF_Spec", recordId: 0, description: "Classification", bytes: Uint8Array.from(entry(64, "Bench face")) }] });
	assert.deepEqual((await openLas(good)).classNames, { 64: "Bench face" });
});

test("parseClassLookup is exported", function () {
	assert.equal(lib.parseClassLookup, parseClassLookup);
});
