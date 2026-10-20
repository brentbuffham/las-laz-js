// test/LasReader.test.js
//==========================================================
// openLas / readPoints / chunks over files built from the ASPRS
// tables, through every kind of source, in windows that do not
// line up with records. Run with: node --test test/LasReader.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLas } from "../src/LasReader.js";
import { buildLas, geoKeyBytes } from "./helpers/buildLas.js";

// N points: x = i, y = 2i, z = i / 10, class 2 on every 4th, colour on format 2/3
function points(n) {
	var out = [];
	for (var i = 0; i < n; i++) out.push({ x: 1000 + i, y: 2000 + 2 * i, z: i / 10, classification: i % 4 === 0 ? 2 : 1, returnNumber: 1, numberOfReturns: 1, red: i, green: 2 * i, blue: 3 * i });
	return out;
}
function lasOf(n, extra) { return buildLas(Object.assign({ version: "1.2", pointFormat: 3, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: points(n) }, extra || {})); }

// A source that counts the bytes it hands out
function spy(bytes) {
	var s = { size: bytes.length, bytesRead: 0, reads: 0 };
	s.read = async function (a, b) { s.reads++; s.bytesRead += b - a; return bytes.subarray(a, b); };
	return s;
}

test("open reads only the header and VLRs", async function () {
	var b = lasOf(1000, { vlrs: [{ userId: "LASF_Projection", recordId: 34735, bytes: geoKeyBytes([[3072, 28350]]) }] });
	var src = spy(b);
	var las = await openLas(src);
	assert.equal(las.header.pointCount, 1000);
	assert.equal(las.crs.epsg, 28350);
	assert.equal(las.vlrs.length, 1);
	assert.equal(las.compressed, false);
	assert.ok(src.bytesRead <= las.header.offsetToPointData + 375, "read " + src.bytesRead + " bytes to open");
});

test("readPoints in 999-byte windows (not a record multiple) equals a whole read", async function () {
	var b = lasOf(1000);
	var whole = await (await openLas(b)).readPoints({ fields: ["x", "y", "z", "classification", "red"] });
	var windowed = await (await openLas(spy(b), { windowSize: 999 })).readPoints({ fields: ["x", "y", "z", "classification", "red"] });
	assert.equal(whole.count, 1000);
	assert.equal(windowed.count, 1000);
	["x", "y", "z", "classification", "red"].forEach(function (f) { assert.deepEqual(Array.from(windowed[f]), Array.from(whole[f]), f); });
	assert.equal(whole.x[999], 1999);
	assert.equal(whole.y[10], 2020);
});

test("chunks concatenate to the readPoints result", async function () {
	var b = lasOf(500);
	var las = await openLas(b, { windowSize: 34 * 64 });
	var xs = [];
	var n = 0;
	for await (var c of las.chunks({ fields: ["x"] })) { n++; for (var i = 0; i < c.count; i++) xs.push(c.x[i]); }
	assert.ok(n > 1, "more than one chunk");
	assert.deepEqual(xs, Array.from((await las.readPoints({ fields: ["x"] })).x));
});

test("filters and maxPoints through readPoints: hand counts", async function () {
	var las = await openLas(lasOf(1000), { windowSize: 2000 });
	assert.equal((await las.readPoints({ fields: ["x"], classes: [2] })).count, 250);
	var thin = await las.readPoints({ fields: ["x"], maxPoints: 300 });
	assert.equal(thin.count, 300);                // stride floor(1000 / 300) = 3 gives 334, capped at 300
	assert.equal(thin.x[1], 1003);
	assert.equal((await las.readPoints({ fields: ["x"], maxPoints: 0 })).count, 1000);
	var box = await las.readPoints({ fields: ["x"], bounds: { minX: 1100, maxX: 1109, minY: -1e9, maxY: 1e9, minZ: -1e9, maxZ: 1e9 } });
	assert.equal(box.count, 10);
});

test("dedupe through readPoints gives the hand count", async function () {
	var b = buildLas({ version: "1.2", pointFormat: 0, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: [{ x: 0, y: 0, z: 0 }, { x: 0.05, y: 0, z: 0 }, { x: 0.30, y: 0, z: 0 }] });
	assert.equal((await (await openLas(b)).readPoints({ dedupe: 0.1 })).count, 2);
});

test("stats: count, world bounds, per-class counts", async function () {
	var r = await (await openLas(lasOf(8))).readPoints({ fields: ["x", "y", "z", "classification"], localOrigin: { x: 1000, y: 2000 }, float32: true });
	assert.equal(r.stats.count, 8);
	assert.deepEqual(r.bounds, { minX: 1000, maxX: 1007, minY: 2000, maxY: 2014, minZ: 0, maxZ: 0.7 });
	assert.deepEqual(r.stats.classCounts, { 1: 6, 2: 2 });
	assert.equal(r.x[7], 7);                       // stored relative to the origin
});

test("onProgress ends at 1; an aborted read rejects ABORTED", async function () {
	var las = await openLas(lasOf(1000), { windowSize: 3400 });
	var last = 0;
	await las.readPoints({ fields: ["x"], onProgress: function (f) { last = f; } });
	assert.equal(last, 1);
	var ac = new AbortController();
	var p = las.readPoints({ fields: ["x"], signal: ac.signal, onProgress: function (f) { if (f > 0.2) ac.abort(); } });
	await assert.rejects(p, { code: "ABORTED" });
});

test("a file cut 10 bytes short is TRUNCATED, naming where the data ran out", async function () {
	var b = lasOf(100);
	var cut = b.subarray(0, b.length - 10);
	var las = await openLas(cut);
	await assert.rejects(las.readPoints({ fields: ["x"] }), { code: "TRUNCATED", offset: cut.length });
});

test("a LAZ file opens (header) but readPoints is COMPRESSED_LAZ naming 0.2.0", async function () {
	var b = lasOf(10, { formatByte: 131 });
	var las = await openLas(b);
	assert.equal(las.compressed, true);
	await assert.rejects(las.readPoints({}), function (e) { return e.code === "COMPRESSED_LAZ" && /0\.2\.0/.test(e.message); });
});

test("sources: Uint8Array, ArrayBuffer, Blob and a Node file path read the same", async function () {
	var b = lasOf(50);
	var dir = mkdtempSync(join(tmpdir(), "las-laz-js-"));
	var path = join(dir, "t.las");
	writeFileSync(path, b);
	var a = await (await openLas(b)).readPoints({ fields: ["x"] });
	var c = await (await openLas(b.buffer.slice(0))).readPoints({ fields: ["x"] });
	var d = await (await openLas(new Blob([b]))).readPoints({ fields: ["x"] });
	var nf = await openLas(path);
	var e = await nf.readPoints({ fields: ["x"] });
	await nf.close();
	[c, d, e].forEach(function (r) { assert.deepEqual(Array.from(r.x), Array.from(a.x)); });
});

test("a bad source is INVALID_ARGUMENT; dedupe in chunks is INVALID_ARGUMENT", async function () {
	await assert.rejects(openLas(42), { code: "INVALID_ARGUMENT" });
	var las = await openLas(lasOf(10));
	await assert.rejects((async function () { for await (var c of las.chunks({ dedupe: 0.1 })) { c = null; } })(), { code: "INVALID_ARGUMENT" });
});

test("LAS 1.4 EVLR with WKT is read and gives the CRS", async function () {
	var wkt = "PROJCS[\"GDA2020 / MGA zone 50\"]";
	var bytes = Uint8Array.from(wkt.split("").map(function (ch) { return ch.charCodeAt(0); }).concat([0]));
	var b = buildLas({ version: "1.4", pointFormat: 6, points: points(3), evlrs: [{ userId: "LASF_Projection", recordId: 2112, bytes: bytes }] });
	var las = await openLas(b);
	assert.equal(las.evlrs.length, 1);
	assert.equal(las.crs.kind, "wkt");
	assert.equal(las.crs.wkt, wkt);
	assert.equal((await las.readPoints({ fields: ["x"] })).count, 3);
});

test("maxPoints picks the same points whether read whole or in windows (stride counts from the file start)", async function () {
	var b = lasOf(1000);
	var whole = await (await openLas(b)).readPoints({ fields: ["x"], maxPoints: 300 });
	var win = await (await openLas(b, { windowSize: 2000 })).readPoints({ fields: ["x"], maxPoints: 300 });
	assert.deepEqual(Array.from(win.x), Array.from(whole.x));
	assert.equal(whole.x[299], 1000 + 3 * 299); // every 3rd record from record 0
});
