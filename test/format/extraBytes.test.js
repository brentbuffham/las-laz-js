// test/format/extraBytes.test.js
//==========================================================
// The Extra Bytes VLR (LASF_Spec, record 4): descriptors built by the
// test helper's own byte code from the LAS 1.4 R15 layout, parsed;
// undocumented bytes; bad VLRs fall back to one raw field with the
// problem named; column names never clash; the writer's layout and
// its refusals; build -> parse round trip, byte-equal to the helper.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtraBytes, layoutExtraBytes, buildExtraBytes } from "../../src/format/ExtraBytes.js";
import * as lib from "../../src/index.js";
import { descriptorBytes, sizeOf } from "../helpers/extraBytes.js";

function vlrOf(list) {
	var all = new Uint8Array(192 * list.length);
	list.forEach(function (d, i) { all.set(d, 192 * i); });
	return { userId: "LASF_Spec", recordId: 4, bytes: all };
}
// format 6 (30 bytes) records holding exactly the described fields, plus `more` bytes
function parse(list, more, fmt) {
	var size = list.reduce(function (n, o) { return n + sizeOf(o.code, o.size); }, 0);
	var base = fmt === undefined ? 30 : { 0: 20, 3: 34, 6: 30 }[fmt];
	return parseExtraBytes([vlrOf(list.map(descriptorBytes))], { pointFormat: fmt === undefined ? 6 : fmt, recordLength: base + size + (more || 0) });
}
var TYPES = ["u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64"];

test("every type 1–10 parses at its size and place", function () {
	var r = parse(TYPES.map(function (t, i) { return { code: i + 1, name: "f" + t }; }));
	assert.equal(r.problem, null);
	assert.deepEqual(r.fields.map(function (f) { return f.type; }), TYPES);
	assert.deepEqual(r.fields.map(function (f) { return f.size; }), [1, 1, 2, 2, 4, 4, 8, 8, 4, 8]);
	assert.deepEqual(r.fields.map(function (f) { return f.at; }), [30, 31, 32, 34, 36, 40, 44, 52, 60, 64]);
	r.fields.forEach(function (f, i) {
		assert.equal(f.k, 1); assert.equal(f.code, i + 1); assert.equal(f.name, "f" + TYPES[i]); assert.equal(f.column, f.name);
		["scale", "offset", "noData", "min", "max"].forEach(function (p) { assert.equal(f[p], null, f.name + " " + p); });
		assert.equal(f.description, "");
	});
});

test("array types 11–30 give k 2 and 3", function () {
	var r = parse([{ code: 13, name: "pair" }, { code: 29, name: "dir", scale: [0.5, 0.25, 2], offset: [1, 2, 3] }]);
	assert.deepEqual([r.fields[0].type, r.fields[0].k, r.fields[0].size, r.fields[0].at], ["u16", 2, 4, 30]);
	assert.deepEqual([r.fields[1].type, r.fields[1].k, r.fields[1].size, r.fields[1].at], ["f32", 3, 12, 34]);
	assert.deepEqual(r.fields[1].scale, [0.5, 0.25, 2]);
	assert.deepEqual(r.fields[1].offset, [1, 2, 3]);
	assert.equal(r.fields[0].scale, null);
});

test("options bits and the raw upcast", function () {
	var r = parse([
		{ code: 1, name: "a", noData: 255, min: 3, max: 200, description: "eight bits" },
		{ code: 6, name: "b", scale: 0.01, offset: 100 },
		{ code: 7, name: "c", noData: 2n ** 60n },
		{ code: 8, name: "d", noData: -5 },
		{ code: 10, name: "e", noData: -9999.5 }
	]);
	var f = r.fields;
	assert.deepEqual([f[0].noData, f[0].min, f[0].max, f[0].description], [255, 3, 200, "eight bits"]);
	assert.deepEqual([f[1].scale, f[1].offset, f[1].noData], [0.01, 100, null]);
	assert.equal(f[2].noData, 2n ** 60n);
	assert.equal(f[3].noData, -5);
	assert.equal(f[4].noData, -9999.5);
	// a bit clear means the value is not used, even when bytes are there
	var off = parseExtraBytes([vlrOf([descriptorBytes({ code: 3, name: "x", noData: 7, options: 0 })])], { pointFormat: 6, recordLength: 32 });
	assert.equal(off.fields[0].noData, null);
});

test("undocumented bytes", function () {
	var r = parse([{ code: 0, name: "spare", size: 3 }]);
	assert.deepEqual(pick(r.fields[0]), { name: "spare", column: "spare", type: "raw", code: 0, k: 3, size: 3, at: 30 });
	r = parse([{ code: 3, name: "w" }], 4);
	assert.equal(r.fields.length, 2);
	assert.deepEqual(pick(r.fields[1]), { name: "", column: "extraBytes", type: "raw", code: 0, k: 4, size: 4, at: 32 });
	r = parseExtraBytes([], { pointFormat: 3, recordLength: 39 });
	assert.deepEqual(r.fields.map(pick), [{ name: "", column: "extraBytes", type: "raw", code: 0, k: 5, size: 5, at: 34 }]);
	assert.equal(r.problem, null);
	// a type-0 field with no name reads as extraBytes too
	r = parse([{ code: 0, name: "", size: 2 }], 0, 0);
	assert.equal(r.fields[0].column, "extraBytes");
});
function pick(f) { return { name: f.name, column: f.column, type: f.type, code: f.code, k: f.k, size: f.size, at: f.at }; }

test("a bad VLR is one raw field and a problem", function () {
	function raw(r, size) { assert.deepEqual(r.fields.map(pick), [{ name: "", column: "extraBytes", type: "raw", code: 0, k: size, size: size, at: 30 }]); }
	var two = [vlrOf([descriptorBytes({ code: 5, name: "a" }), descriptorBytes({ code: 5, name: "b" })])];
	var r = parseExtraBytes(two, { pointFormat: 6, recordLength: 34 });
	raw(r, 4); assert.match(r.problem, /describes 8 bytes but records have 4/);
	r = parseExtraBytes([vlrOf([descriptorBytes({ code: 31, name: "a" })])], { pointFormat: 6, recordLength: 34 });
	raw(r, 4); assert.match(r.problem, /type 31/);
	r = parseExtraBytes([{ userId: "LASF_Spec", recordId: 4, bytes: new Uint8Array(200) }], { pointFormat: 6, recordLength: 34 });
	raw(r, 4); assert.match(r.problem, /192/);
	var one = vlrOf([descriptorBytes({ code: 5, name: "a" })]);
	r = parseExtraBytes([one, one], { pointFormat: 6, recordLength: 34 });
	raw(r, 4); assert.match(r.problem, /two Extra Bytes/);
	// a described record with no extra bytes at all: the VLR is wrong, and there is nothing to read
	r = parseExtraBytes([one], { pointFormat: 6, recordLength: 30 });
	assert.deepEqual(r.fields, []); assert.match(r.problem, /describes 4 bytes but records have 0/);
});

test("column names never clash", function () {
	var r = parse([{ code: 3, name: "intensity" }, { code: 5, name: "facet" }, { code: 5, name: "facet" }, { code: 1, name: "extra" }, { code: 1, name: "count" }]);
	assert.deepEqual(r.fields.map(function (f) { return f.column; }), ["intensity_extra", "facet", "facet_2", "extra_extra", "count_extra"]);
	assert.deepEqual(r.fields.map(function (f) { return f.name; }), ["intensity", "facet", "facet", "extra", "count"]);
});

test("no extra bytes", function () {
	assert.deepEqual(parseExtraBytes([], { pointFormat: 3, recordLength: 34 }), { fields: [], problem: null });
});

test("layoutExtraBytes places the fields and sets the record length", function () {
	var l = layoutExtraBytes([{ name: "facet", type: "u32" }, { name: "w", type: 9, column: "width" }, { name: "", type: "raw", size: 300 }], 30);
	assert.deepEqual(l.fields.map(function (f) { return [f.name, f.column, f.code, f.size, f.at]; }), [["facet", "facet", 5, 4, 30], ["w", "width", 9, 4, 34], ["", "extraBytes", 0, 300, 38]]);
	assert.equal(l.recordLength, 338);
	assert.deepEqual(layoutExtraBytes([], 20), { fields: [], recordLength: 20 });
	// what a reader hands back is taken as it is: k, at, min, max are not the writer's
	l = layoutExtraBytes([{ name: "a", column: "a", type: "u16", code: 3, k: 1, size: 2, at: 99, min: 1, max: 2, scale: null, offset: null, noData: null, description: "" }], 30);
	assert.deepEqual([l.fields[0].at, l.fields[0].scaled], [30, false]);
});

test("layoutExtraBytes refuses, naming the field", function () {
	function no(list, re, size) { assert.throws(function () { layoutExtraBytes(list, size || 30); }, { code: "INVALID_ARGUMENT", message: re }); }
	no([{ name: "a", type: "u12" }], /"a".*type/);
	no([{ name: "a", type: 11 }], /"a".*type/);
	no([{ name: "r", type: "raw" }], /"r".*size/);
	no([{ name: "r", type: "raw", size: 0 }], /"r".*size/);
	no([{ name: "r", type: "raw", size: 70000 }], /"r".*size/);
	no([{ name: "a", type: "u8", size: 2 }], /"a".*size/);
	no([{ name: 5, type: "u8" }], /name/);
	no([{ name: "x".repeat(33), type: "u8" }], /32/);
	no([{ name: "€", type: "u8" }], /one byte a character/);
	no([{ name: "a", type: "u8", description: "d".repeat(33) }], /"a".*description/);
	no([{ name: "a", type: "u8" }, { name: "a", type: "u16" }], /column "a".*twice/);
	no([{ name: "a", type: "u8", column: "c" }, { name: "b", type: "u16", column: "c" }], /column "c".*twice/);
	no([{ name: "intensity", type: "u8" }], /intensity.*intensity_extra/);
	no([{ name: "a", type: "u8", column: "positions" }], /positions/);
	no([{ name: "a", type: "i16", scale: 0 }], /"a".*scale/);
	no([{ name: "a", type: "i16", scale: Infinity }], /"a".*scale/);
	no([{ name: "a", type: "i16", offset: NaN }], /"a".*offset/);
	no([{ name: "a", type: "u8", noData: 256 }], /"a".*noData/);
	no([{ name: "a", type: "u8", noData: 1.5 }], /"a".*noData/);
	no([{ name: "a", type: "u16", k: 3 }], /"a".*array type.*read, not written/);
	no([{ name: "big", type: "raw", size: 65535 }], /65,535/, 30);
});

test("layoutExtraBytes takes what a reader can hand back: repeated and empty names, Latin-1, NaN no-data", function () {
	var l = layoutExtraBytes([{ name: "facet", type: "u32" }, { name: "facet", column: "facet_2", type: "u32" }, { name: "", type: "u16" }, { name: "café", type: "u8" }, { name: "r", type: "f64", noData: NaN }], 30);
	assert.deepEqual(l.fields.map(function (x) { return x.column; }), ["facet", "facet_2", "extraBytes", "café", "r"]);
	assert.ok(Number.isNaN(l.fields[4].noData));
	// f32 no-data is held as f32 holds it; a BigInt no-data on a type up to 32 bits is a Number
	l = layoutExtraBytes([{ name: "w", type: "f32", noData: -9999.9 }, { name: "u", type: "u16", noData: 65535n }], 30);
	assert.equal(l.fields[0].noData, Math.fround(-9999.9));
	assert.equal(l.fields[1].noData, 65535);
	var b = buildExtraBytes(layoutExtraBytes([{ name: "café", type: "u8" }], 30), [null]);
	assert.equal(b[4 + 3], 0xe9);
});

test("a no-data value the type cannot hold is read as none", function () {
	var r = parse([{ code: 1, name: "a", noData: 300 }, { code: 2, name: "b", noData: -5 }]);
	assert.equal(r.fields[0].noData, null);
	assert.equal(r.fields[1].noData, -5);
	// per value for the array types
	assert.deepEqual(parse([{ code: 11, name: "p", noData: [300, 7] }]).fields[0].noData, [null, 7]);
});

test("a scale of 0 (every value the offset) is read as no scale", function () {
	var r = parse([{ code: 3, name: "a", scale: 0, offset: 2 }, { code: 13, name: "b", scale: [0, 0.5] }]);
	assert.equal(r.fields[0].scale, null);
	assert.equal(r.fields[0].offset, 2);
	assert.deepEqual(r.fields[1].scale, [null, 0.5]);
});

test("layoutExtraBytes needs an array", function () {
	assert.throws(function () { layoutExtraBytes({ name: "a" }, 30); }, { code: "INVALID_ARGUMENT", message: /extraBytes must be an array/ });
});

test("buildExtraBytes -> parseExtraBytes round trip, byte-equal to the helper", function () {
	var l = layoutExtraBytes([
		{ name: "facet", type: "u32" }, { name: "w", type: 9, column: "width" }, { name: "", type: "raw", size: 300 },
		{ name: "h", type: "i16", scale: 0.01, offset: 5, noData: -32768, description: "height" }
	], 30);
	var ranges = [{ min: 1, max: 900 }, null, null, { min: -300, max: 4000 }];
	var bytes = buildExtraBytes(l, ranges);
	assert.equal(bytes.length, 192 * 5);
	var r = parseExtraBytes([{ userId: "LASF_Spec", recordId: 4, bytes: bytes }], { pointFormat: 6, recordLength: l.recordLength });
	assert.equal(r.problem, null);
	assert.deepEqual(r.fields.map(function (f) { return [f.name, f.column, f.type, f.size, f.at]; }),
		[["facet", "facet", "u32", 4, 30], ["w", "w", "f32", 4, 34], ["", "extraBytes", "raw", 255, 38], ["", "extraBytes_2", "raw", 45, 293], ["h", "h", "i16", 2, 338]]);
	var h = r.fields[4];
	assert.deepEqual([h.scale, h.offset, h.noData, h.min, h.max, h.description], [0.01, 5, -32768, -300, 4000, "height"]);
	assert.deepEqual([r.fields[0].min, r.fields[0].max, r.fields[1].min, r.fields[1].noData], [1, 900, null, null]);
	var want = [
		descriptorBytes({ code: 5, name: "facet", min: 1, max: 900 }),
		descriptorBytes({ code: 9, name: "w" }),
		descriptorBytes({ code: 0, name: "", size: 255 }),
		descriptorBytes({ code: 0, name: "", size: 45 }),
		descriptorBytes({ code: 4, name: "h", scale: 0.01, offset: 5, noData: -32768, min: -300, max: 4000, description: "height" })
	];
	want.forEach(function (d, i) { assert.deepEqual(Array.from(bytes.subarray(192 * i, 192 * (i + 1))), Array.from(d), "descriptor " + i); });
	// BigInt and 64-bit ranges go in at the full width
	var big = buildExtraBytes(layoutExtraBytes([{ name: "n", type: "u64", noData: 2n ** 63n }], 30), [{ min: 0n, max: 2n ** 62n }]);
	assert.deepEqual(Array.from(big), Array.from(descriptorBytes({ code: 7, name: "n", noData: 2n ** 63n, min: 0, max: 2n ** 62n })));
});

test("the package exports parseExtraBytes", function () {
	assert.equal(lib.parseExtraBytes, parseExtraBytes);
});
