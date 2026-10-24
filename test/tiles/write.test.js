// test/tiles/write.test.js
//==========================================================
// TileStore.writeLas: an unedited store gives back every source
// record byte for byte (as a multiset; LAS and LAZ out, formats 0, 3,
// 6 with extra bytes, 7 and 8); an edited LAZ store equals writeLas of
// the same edits made on the source's columns; a transformed store's
// coordinates move; an empty store writes a valid empty LAS.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { writeLas } from "../../src/write/writeLas.js";
import { buildTiles } from "../../src/tiles/build.js";
import { recordFields } from "../../src/read/decodeRecords.js";
import { selectBox, selectPolygon } from "../../src/ops/select.js";
import { removePoints } from "../../src/ops/apply.js";
import { makeTransform, applyTransform } from "../../src/ops/transform.js";
import { tileLas } from "../helpers/tileFiles.js";
import { memorySink } from "../helpers/sinks.js";

var BOX = { minX: 478040, maxX: 478120, minY: 6772030, maxY: 6772150 };
var POLY = [478100, 6772100, 478180, 6772090, 478190, 6772180, 478090, 6772170];

async function records(bytes) {
	var las = await openLas(bytes, { threads: 1 }), len = las.header.recordLength, out = [];
	for await (var w of las._rawWindows()) for (var p = 0; p < w.bytes.length; p += len) { var s = ""; for (var i = p; i < p + len; i++) s += String.fromCharCode(w.bytes[i]); out.push(s); }
	return out.sort();
}

async function written(store, opts) { var sink = memorySink(); var r = await store.writeLas(sink, opts); return { count: r.count, bytes: sink.bytes() }; }

test("unedited: every source record back, LAS and LAZ out", { timeout: 120000 }, async function () {
	for (var fmt of [0, 3, 6, 7, 8]) {
		var src = tileLas({ pointFormat: fmt, n: 8000, seed: 60 + fmt, extraBytes: fmt === 6 ? 2 : 0 });
		var store = await buildTiles(await openLas(src), { where: { memory: true }, tilePoints: 500 });
		for (var compress of [false, true]) {
			var out = await written(store, { compress: compress });
			assert.equal(out.count, 8000);
			assert.deepEqual(await records(out.bytes), await records(src), "format " + fmt + (compress ? " LAZ" : " LAS"));
			var a = (await openLas(out.bytes)).header, b = (await openLas(src)).header;
			assert.equal(a.pointCount, b.pointCount);
			// buildLas writes header bounds from the unquantised points; the stored points' own bounds are the oracle
			var pb = (await (await openLas(src)).readPoints({ fields: ["x", "y", "z"] })).bounds;
			["minX", "minY", "minZ", "maxX", "maxY", "maxZ"].forEach(function (k) { assert.ok(Math.abs(a.bounds[k] - pb[k]) < 1e-9, k + ": " + a.bounds[k] + " vs " + pb[k]); });
			assert.deepEqual(a.pointsByReturn, b.pointsByReturn);
			assert.equal(a.pointFormat, fmt);
			assert.equal(a.compressed, compress);
		}
	}
});

test("edited LAZ with extra bytes equals the same edits on columns", { timeout: 120000 }, async function () {
	// a LAZ format 7 source with two named extra fields at UTM coordinates
	var base = await (await openLas(tileLas({ pointFormat: 7, n: 12000, seed: 71 }))).readPoints({ fields: recordFields(7) });
	base.echo = new Uint16Array(base.count).map(function (_, i) { return (i * 37) % 65536; });
	base.dev = new Float64Array(base.count).map(function (_, i) { return Math.round((i % 900) - 450) / 100; });
	var EXTRA = [{ name: "echo", type: "u16" }, { name: "dev", type: "i32", scale: 0.01 }];
	var laz = await writeLas(base, { version: "1.4", pointFormat: 7, scale: { x: 0.001, y: 0.001, z: 0.001 }, offset: { x: 478000, y: 6772000, z: 0 }, extraBytes: EXTRA, compress: true });
	var las = await openLas(laz);
	var store = await buildTiles(las, { where: { memory: true }, tilePoints: 700, compress: true });
	await store.deletePoints(await store.selectBox(BOX));
	await store.setColumn(await store.selectPolygon(POLY), "classification", 6);
	await store.addColumn("facet", "i32", -1);
	await store.setColumn(await store.selectBox({ minX: 478000, maxX: 478050 }), "facet", 3);
	var out = await written(store, { compress: true });
	// the oracle: the same edits on the source's columns, written by writeLas
	var cols = await las.readPoints({ fields: recordFields(7).concat(["extra"]) });
	cols = removePoints(cols, selectBox(cols, BOX));
	selectPolygon(cols, POLY).forEach(function (i) { cols.classification[i] = 6; });
	cols.facet = new Int32Array(cols.count).fill(-1);
	selectBox(cols, { minX: 478000, maxX: 478050 }).forEach(function (i) { cols.facet[i] = 3; });
	var want = await writeLas(cols, { version: "1.4", pointFormat: 7, scale: las.header.scale, offset: las.header.offset, extraBytes: las.extraBytes.concat([{ name: "facet", type: "i32" }]), compress: true });
	assert.deepEqual(await records(out.bytes), await records(want));
	var back = await openLas(out.bytes);
	assert.deepEqual(back.extraBytes.map(function (f) { return [f.name, f.type, f.scale]; }), [["echo", "u16", null], ["dev", "i32", 0.01], ["facet", "i32", null]]);
});

test("a transformed store writes moved coordinates", async function () {
	var src = tileLas({ pointFormat: 3, n: 5000, seed: 81 });
	var store = await buildTiles(await openLas(src), { where: { memory: true }, tilePoints: 500 });
	var T = makeTransform({ rotateZ: 20, shift: [250, -40, 10], about: [478100, 6772100, 0] });
	await store.transform(T);
	var out = await written(store, {});
	var a = await (await openLas(out.bytes)).readPoints({ fields: ["x", "y", "z", "gpsTime"] }), s = await (await openLas(src)).readPoints({ fields: ["x", "y", "z", "gpsTime"] });
	var at = new Map(), p = [0, 0, 0];
	for (var i = 0; i < s.count; i++) at.set(Math.round(s.gpsTime[i] * 1000), i);
	for (var j = 0; j < a.count; j++) {
		var k = at.get(Math.round(a.gpsTime[j] * 1000));
		applyTransform(T, s.x[k], s.y[k], s.z[k], p);
		assert.ok(Math.abs(a.x[j] - p[0]) <= 0.0006 && Math.abs(a.y[j] - p[1]) <= 0.0006 && Math.abs(a.z[j] - p[2]) <= 0.0006, "point " + j);
	}
	assert.deepEqual((await openLas(out.bytes)).header.scale, (await openLas(src)).header.scale);
});

test("an empty store writes a valid empty LAS", async function () {
	var store = await buildTiles(await openLas(tileLas({ n: 0 })), { where: { memory: true } });
	var out = await written(store, {});
	assert.equal(out.count, 0);
	var back = await openLas(out.bytes);
	assert.equal(back.header.pointCount, 0);
	assert.equal((await back.readPoints()).count, 0);
});
