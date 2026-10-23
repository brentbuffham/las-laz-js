// test/write/extraBytes.test.js
//==========================================================
// Writing extra-bytes fields: a read -> save gives the source's records
// byte for byte (LAS and LAZ, 1.2 and 1.4, PDAL's f3x / f7x); the
// streaming writer in batches equals writeLas; the VLR's raw min / max
// cover every batch; scaled NaN is no-data or refused; every value
// refusal; a refused batch leaves the writer as it was; array types
// are read, not written; no extraBytes writes the 0.9.1 bytes.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { writeLas, createLasWriter } from "../../src/write/writeLas.js";
import { descriptorBytes, lasWithExtra } from "../helpers/extraBytes.js";
import { EVERY_FIELD } from "../helpers/fieldDigests.js";
import { fixtureBytes, decompressAll } from "../helpers/lazFixtureFiles.js";

var DATE = new Date(Date.UTC(2026, 9, 24));
var UTM = { scale: { x: 0.001, y: 0.001, z: 0.001 }, offset: { x: 477000, y: 6770000, z: 300 } };
function points(n) {
	var out = [];
	for (var i = 0; i < n; i++) out.push({ x: 477000 + i * 0.5, y: 6770000 + (i % 7), z: 300 + i * 0.01, intensity: i, returnNumber: 1 + (i % 2), numberOfReturns: 2, classification: 2 + (i % 3), red: i, green: 2 * i, blue: 3 * i, gpsTime: 1000 + i });
	return out;
}
// 1.4 format 6: u8, i16 scaled with no-data, u32, f32, f64, u64, 3 raw bytes
function sourceA(n) {
	return lasWithExtra(Object.assign({ version: "1.4", pointFormat: 6, points: points(n), extraSize: 30,
		descriptors: [descriptorBytes({ code: 1, name: "a8", description: "eight" }), descriptorBytes({ code: 4, name: "h", scale: 0.01, offset: 5, noData: -32768 }),
			descriptorBytes({ code: 5, name: "facet" }), descriptorBytes({ code: 9, name: "w" }), descriptorBytes({ code: 10, name: "r" }), descriptorBytes({ code: 7, name: "big" }),
			descriptorBytes({ code: 0, name: "spare", size: 3 })],
		fill: function (i, v, rec, b) {
			v.setUint8(rec + b, (i * 13) % 256); v.setInt16(rec + b + 1, i % 5 === 0 ? -32768 : i * 37 - 2000, true); v.setUint32(rec + b + 3, i * 100003, true);
			v.setFloat32(rec + b + 7, i / 3, true); v.setFloat64(rec + b + 11, i * 1e7 + 0.25, true); v.setBigUint64(rec + b + 19, BigInt(i) * 2n ** 40n + 7n, true);
			for (var j = 0; j < 3; j++) v.setUint8(rec + b + 27 + j, (i + j * 50) % 256);
		} }, UTM));
}
// 1.2 format 3: u16 then 2 undocumented bytes
function sourceB(n) {
	return lasWithExtra(Object.assign({ version: "1.2", pointFormat: 3, points: points(n), extraSize: 4, descriptors: [descriptorBytes({ code: 3, name: "w" })],
		fill: function (i, v, rec, b) { v.setUint16(rec + b, i * 211, true); v.setUint8(rec + b + 2, i % 256); v.setUint8(rec + b + 3, 255 - (i % 256)); } }, UTM));
}
async function recordsOf(bytes) {
	var h = (await openLas(bytes)).header;
	if (h.compressed) return (await decompressAll(bytes)).records;
	return bytes.subarray(h.offsetToPointData, h.offsetToPointData + h.pointCount * h.recordLength);
}
function fieldsOf(list) { return list.map(function (e) { return { name: e.name, type: e.type, k: e.k, size: e.size, scale: e.scale, offset: e.offset, noData: e.noData, description: e.description }; }); }
// columns a..b, k values a point
function slice(c, a, b) {
	var out = { count: b - a };
	Object.keys(c).forEach(function (k) { var v = c[k]; if (ArrayBuffer.isView(v) && c.count) { var w = v.length / c.count; if (Number.isInteger(w)) out[k] = v.subarray(a * w, b * w); } });
	return out;
}
function memorySink() {
	var sink = { buf: new Uint8Array(1 << 16), end: 0 };
	sink.write = function (bytes, at) {
		if (at + bytes.length > sink.buf.length) { var g = new Uint8Array(2 * (at + bytes.length)); g.set(sink.buf); sink.buf = g; }
		sink.buf.set(bytes, at); sink.end = Math.max(sink.end, at + bytes.length);
	};
	sink.bytes = function () { return sink.buf.slice(0, sink.end); };
	return sink;
}

test("read -> save keeps the records byte for byte", async function () {
	var sources = [["A", sourceA(60)], ["B", sourceB(40)], ["f3x", fixtureBytes("f3x")], ["f7x", fixtureBytes("f7x")]];
	for (var s of sources) {
		var las = await openLas(s[1], { threads: 1 }), h = las.header;
		var p = await las.readPoints({ fields: EVERY_FIELD.concat(["extra"]) });
		var want = await recordsOf(s[1]);
		for (var compress of [false, true]) {
			var label = s[0] + (compress ? " LAZ" : " LAS");
			var out = await writeLas(p, { version: "1." + h.versionMinor, pointFormat: h.pointFormat, scale: h.scale, offset: h.offset, extraBytes: las.extraBytes, compress: compress, chunkSize: 7, threads: 1 });
			var back = await openLas(out, { threads: 1 });
			assert.equal(back.header.recordLength, h.recordLength, label);
			assert.equal(back.extraBytesProblem, null, label);
			assert.deepEqual(fieldsOf(back.extraBytes), fieldsOf(las.extraBytes), label);
			assert.deepEqual(await recordsOf(out), want, label + " records");
		}
	}
});

test("createLasWriter in batches equals writeLas, LAS and LAZ", async function () {
	var las = await openLas(sourceA(50)), p = await las.readPoints({ fields: EVERY_FIELD.concat(["extra"]) });
	for (var compress of [false, true]) {
		var opts = { version: "1.4", pointFormat: 6, scale: UTM.scale, offset: UTM.offset, extraBytes: las.extraBytes, compress: compress, chunkSize: 16, threads: 1, date: DATE };
		var whole = await writeLas(p, opts);
		var sink = memorySink(), w = await createLasWriter(sink, opts);
		for (var a of [[0, 11], [11, 30], [30, 50]]) await w.writePoints(slice(p, a[0], a[1]));
		await w.close();
		assert.deepEqual(sink.bytes(), whole, compress ? "LAZ" : "LAS");
	}
});

test("min and max are the raw range of what was written, no-data and NaN left out", async function () {
	var opts = { version: "1.4", pointFormat: 6, scale: UTM.scale, offset: UTM.offset, extraBytes: [{ name: "m", type: "u16", noData: 65535 }, { name: "g", type: "f32" }, { name: "z0", type: "i8", noData: -128 }, { name: "s", type: "i16", scale: 0.5 }] };
	function batch(m, g, s) { var n = m.length; return { count: n, x: new Float64Array(n).fill(477001), y: new Float64Array(n).fill(6770001), z: new Float64Array(n).fill(301), m: Uint16Array.from(m), g: Float32Array.from(g), z0: new Int8Array(n).fill(-128), s: Float64Array.from(s) }; }
	var sink = memorySink(), w = await createLasWriter(sink, opts);
	await w.writePoints(batch([5, 65535, 70], [NaN, 2.5, 1], [1, 2, 3]));
	await w.writePoints(batch([300, 65535], [-4, NaN], [-10, 0]));
	await w.writePoints(batch([60000, 6], [3, 0], [7.5, 2]));
	await w.close();
	var eb = (await openLas(sink.bytes())).extraBytes;
	assert.deepEqual([eb[0].min, eb[0].max], [5, 60000]);
	assert.deepEqual([eb[1].min, eb[1].max], [-4, 3]);
	assert.deepEqual([eb[2].min, eb[2].max], [null, null]);
	assert.deepEqual([eb[3].min, eb[3].max], [-20, 15]);   // raw: value / 0.5
});

test("scaled NaN is written as no-data and read back NaN; without no-data it is refused", async function () {
	var c = { count: 5, x: new Float64Array([1, 2, 3, 4, 5]), y: new Float64Array(5), z: new Float64Array(5), h: Float64Array.from([1, 2.5, -3, 4, NaN]) };
	var out = await writeLas(c, { extraBytes: [{ name: "h", type: "i16", scale: 0.1, noData: -32768 }] });
	var back = await (await openLas(out)).readPoints({ fields: ["h"] });
	assert.deepEqual(Array.from(back.h).slice(0, 4), [1, 2.5, -3, 4]);
	assert.ok(Number.isNaN(back.h[4]));
	await assert.rejects(writeLas(c, { extraBytes: [{ name: "h", type: "i16", scale: 0.1 }] }), { code: "INVALID_ARGUMENT", message: /"h".*point 4.*NaN/ });
});

test("values are checked, naming the field and the point", async function () {
	function c(col) { var n = col.length; return { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), v: col }; }
	async function no(col, d, re) { await assert.rejects(writeLas(c(col), { extraBytes: [Object.assign({ name: "v" }, d)] }), { code: "INVALID_ARGUMENT", message: re }); }
	await no([1, 2, 256], { type: "u8" }, /"v".*point 2.*u8/);
	await no(Float64Array.from([1.5]), { type: "i32" }, /"v".*point 0.*whole number/);
	await no(Float64Array.from([1, 700]), { type: "u16", scale: 0.01 }, /"v".*point 1.*range/);
	await no([2 ** 53 + 2], { type: "u64" }, /"v".*point 0.*2\^53/);
	await no(Float64Array.from([1e39]), { type: "f32" }, /"v".*point 0.*range/);
	await assert.rejects(writeLas({ count: 2, x: new Float64Array(2), y: new Float64Array(2) }, { extraBytes: [{ name: "facet", type: "u32" }] }), { code: "INVALID_ARGUMENT", message: /column "facet"/ });
	await assert.rejects(writeLas({ count: 2, x: new Float64Array(2), y: new Float64Array(2), v: new Uint32Array(3) }, { extraBytes: [{ name: "v", type: "u32" }] }), { code: "INVALID_ARGUMENT", message: /"v".*length/ });
	await assert.rejects(writeLas({ count: 2, x: new Float64Array(2), y: new Float64Array(2), v: new Uint8Array(5) }, { extraBytes: [{ name: "v", type: "raw", size: 3 }] }), { code: "INVALID_ARGUMENT", message: /"v".*length/ });
	// BigInt and big Numbers that are exact pass; floats store NaN and Infinity unscaled
	var ok = await writeLas(c(BigUint64Array.from([2n ** 64n - 1n, 0n])), { extraBytes: [{ name: "v", type: "u64" }] });
	assert.deepEqual(Array.from((await (await openLas(ok)).readPoints({ fields: ["v"] })).v), [2n ** 64n - 1n, 0n]);
	ok = await writeLas(c(Float32Array.from([NaN, Infinity])), { extraBytes: [{ name: "v", type: "f32" }] });
	var f = (await (await openLas(ok)).readPoints({ fields: ["v"] })).v;
	assert.ok(Number.isNaN(f[0])); assert.equal(f[1], Infinity);
});

test("a refused streaming batch leaves the writer as it was", async function () {
	var opts = { version: "1.4", pointFormat: 6, scale: UTM.scale, offset: UTM.offset, extraBytes: [{ name: "v", type: "u8" }] };
	function batch(v, x0) { var n = v.length; return { count: n, x: Float64Array.from(v, function (_, i) { return 477000 + x0 + i; }), y: new Float64Array(n).fill(6770000), z: new Float64Array(n).fill(300), v: Uint16Array.from(v) }; }
	var sink = memorySink(), w = await createLasWriter(sink, opts);
	await w.writePoints(batch([10, 20, 30], 0));
	await assert.rejects(w.writePoints(batch([1, 300], 10)), { code: "INVALID_ARGUMENT", message: /"v".*point 1/ });
	await w.writePoints(batch([40, 5], 20));
	assert.equal((await w.close()).count, 5);
	var las = await openLas(sink.bytes()), p = await las.readPoints({ fields: ["x", "v"] });
	assert.deepEqual(Array.from(p.v), [10, 20, 30, 40, 5]);
	assert.deepEqual(Array.from(p.x), [477000, 477001, 477002, 477020, 477021]);
	assert.deepEqual([las.extraBytes[0].min, las.extraBytes[0].max], [5, 40]);
});

test("a reader's array field is refused: read, not written", async function () {
	var bytes = lasWithExtra(Object.assign({ pointFormat: 6, points: points(3), extraSize: 6, descriptors: [descriptorBytes({ code: 23, name: "dir" })] }, UTM));
	var las = await openLas(bytes), p = await las.readPoints({ fields: ["x", "y", "z", "extra"] });
	await assert.rejects(writeLas(p, { version: "1.4", pointFormat: 6, extraBytes: las.extraBytes }), { code: "INVALID_ARGUMENT", message: /"dir".*array type.*read, not written/ });
});

test("writes without extraBytes are unchanged", async function () {
	var p = await (await openLas(sourceA(20))).readPoints({ fields: EVERY_FIELD });
	var opts = { version: "1.4", pointFormat: 6, date: DATE };
	var a = await writeLas(p, opts), b = await writeLas(p, Object.assign({ extraBytes: [] }, opts));
	assert.deepEqual(a, b);
	var las = await openLas(a);
	assert.equal(las.header.recordLength, 30);
	assert.equal(las.vlrs.filter(function (v) { return v.userId === "LASF_Spec" && v.recordId === 4; }).length, 0);
});
