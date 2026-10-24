// test/tiles/edit.test.js
//==========================================================
// Edits on a store against the same edits on the source's columns:
// delete / keep by box and polygon, stale selections refused, combined
// selections, set a column (classify: only that byte changes), add and
// remove columns, transforms compose without rewriting tiles, an edit
// cut before its manifest leaves the store as it was, compressed
// stores edit as raw ones do. Points are matched by GPS time
// (unique per point in tileLas).
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { buildTiles } from "../../src/tiles/build.js";
import { openTiles } from "../../src/tiles/TileStore.js";
import { combineTileSelections } from "../../src/tiles/edit.js";
import { selectTiles } from "../../src/tiles/select.js";
import { selectBox, selectPolygon, unionSelections, intersectSelections, subtractSelections } from "../../src/ops/select.js";
import { makeTransform } from "../../src/ops/transform.js";
import { tileLas, sourceRecords, storeRecords } from "../helpers/tileFiles.js";
import { perspective, lookAt, multiply } from "../helpers/cameras.js";

var B7 = tileLas({ pointFormat: 7, n: 15000, seed: 51, flatZ: undefined });
var B3 = tileLas({ pointFormat: 3, n: 6000, seed: 52 });
var BOX = { minX: 478040, maxX: 478120, minY: 6772030, maxY: 6772150 };
var POLY = [478100, 6772100, 478180, 6772090, 478190, 6772180, 478090, 6772170];

async function build(bytes, extra) { return buildTiles(await openLas(bytes), Object.assign({ where: { memory: new Map() }, tilePoints: 600 }, extra || {})); }
async function source(bytes) { return (await openLas(bytes)).readPoints({ fields: ["x", "y", "z", "gpsTime", "classification"] }); }
function id(g) { return Math.round(g * 1000); }

async function ids(store) {
	var out = [];
	for (var key of Object.keys(store.manifest.nodes)) {
		var t = await store.readTile(key, { fields: ["gpsTime"] });
		for (var i = 0; i < t.count; i++) out.push(id(t.gpsTime[i]));
	}
	return out.sort(function (a, b) { return a - b; });
}

// the source's records for the points whose index passes keep, sorted as storeRecords sorts
function recordsWhere(bytes, keep) {
	var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), start = v.getUint32(96, true), len = v.getUint16(105, true);
	var all = sourceRecords(bytes), out = [];
	all.forEach(function (r) {
		var gps = new DataView(Uint8Array.from(r, function (c) { return c.charCodeAt(0); }).buffer).getFloat64(len === 36 ? 22 : 20, true);
		if (keep(id(gps))) out.push(r);
	});
	return out;
}

test("delete by box equals removePoints on the columns", async function () {
	var store = await build(B7), src = await source(B7);
	var gone = new Set(Array.from(selectBox(src, BOX)).map(function (i) { return id(src.gpsTime[i]); }));
	var sel = await store.selectBox(BOX);
	assert.equal(sel.count, gone.size);
	var r = await store.deletePoints(sel);
	assert.equal(r.removed, gone.size);
	assert.deepEqual(await ids(store), Array.from({ length: 15000 }, function (_, i) { return i; }).filter(function (i) { return !gone.has(i); }));
	assert.deepEqual(await storeRecords(store), recordsWhere(B7, function (i) { return !gone.has(i); }));
	assert.equal(store.manifest.deletes, 1);
	assert.equal(store.count, 15000 - gone.size);
});

test("keep by polygon equals keepPoints on the columns", async function () {
	var store = await build(B7), src = await source(B7);
	var kept = new Set(Array.from(selectPolygon(src, POLY)).map(function (i) { return id(src.gpsTime[i]); }));
	await store.keepPoints(await store.selectPolygon(POLY));
	assert.deepEqual(await ids(store), Array.from(kept).sort(function (a, b) { return a - b; }));
	var empty = Object.keys(store.manifest.nodes).filter(function (k) { return store.manifest.nodes[k].count === 0; });
	assert.ok(empty.length > 0, "nodes outside the polygon are left empty");
	empty.forEach(function (k) { assert.equal(store.manifest.nodes[k].box, null); });
	var view = { viewProjection: multiply(perspective(50, 1.6, 1, 5000), lookAt([478150, 6772130, 700], [478150, 6772135, 300])), width: 1600, height: 1000 };
	var got = selectTiles(store, view);
	assert.ok(got.length > 1 && got.every(function (n) { return isFinite(n.box.minX); }));
});

test("a selection made before a delete or keep is refused", async function () {
	var store = await build(B7);
	var a = await store.selectBox(BOX), b = await store.selectPolygon(POLY);
	await store.deletePoints(b);
	await assert.rejects(store.deletePoints(a), function (e) { return e.code === "INVALID_ARGUMENT" && /select again/.test(e.message); });
	await assert.rejects(store.setColumn(a, "classification", 2), /select again/);
	var bad = await store.selectBox(BOX);
	var k = Object.keys(bad.tiles)[0];
	bad.tiles[k] = Uint32Array.of(store.manifest.nodes[k].count);
	await assert.rejects(store.deletePoints(bad), function (e) { return e.code === "INVALID_ARGUMENT" && /index/.test(e.message); });
});

test("combineTileSelections works tile by tile", async function () {
	var store = await build(B7);
	var a = await store.selectBox(BOX), b = await store.selectPolygon([478050, 6772050, 478200, 6772050, 478200, 6772200, 478050, 6772200]);
	[["union", unionSelections], ["intersect", intersectSelections], ["subtract", subtractSelections]].forEach(function (op) {
		var c = combineTileSelections(a, b, op[0]), n = 0;
		var keys = new Set(Object.keys(a.tiles).concat(Object.keys(b.tiles)));
		keys.forEach(function (k) {
			var want = op[1](a.tiles[k] || new Uint32Array(0), b.tiles[k] || new Uint32Array(0));
			assert.deepEqual(c.tiles[k] || new Uint32Array(0), want, op[0] + " " + k);
			n += want.length;
		});
		assert.equal(c.count, n);
	});
	assert.throws(function () { combineTileSelections(a, { deletes: 1, count: 0, tiles: {} }, "union"); }, /different edits/);
	assert.throws(function () { combineTileSelections(a, b, "xor"); }, /union, intersect or subtract/);
});

test("setColumn classification changes that byte only", async function () {
	var store = await build(B7), src = await source(B7);
	var hit = new Set(Array.from(selectPolygon(src, POLY)).map(function (i) { return id(src.gpsTime[i]); }));
	await store.setColumn(await store.selectPolygon(POLY), "classification", 64);
	var srcById = new Map(sourceRecords(B7).map(function (r) { return [id(new DataView(Uint8Array.from(r, function (c) { return c.charCodeAt(0); }).buffer).getFloat64(22, true)), r]; }));
	(await storeRecords(store)).forEach(function (r) {
		var g = id(new DataView(Uint8Array.from(r, function (c) { return c.charCodeAt(0); }).buffer).getFloat64(22, true)), s = srcById.get(g);
		if (!hit.has(g)) { assert.equal(r, s); return; }
		assert.equal(r.charCodeAt(16), 64);
		assert.equal(r.slice(0, 16) + r.slice(17), s.slice(0, 16) + s.slice(17), "only the class byte of point " + g);
	});
	assert.equal(store.manifest.deletes, 0);
	assert.equal(store.manifest.edits, 1);
});

test("setColumn: per-tile values; refusals as the writer words them", async function () {
	var store = await build(B7);
	var sel = await store.selectBox(BOX), values = {};
	Object.keys(sel.tiles).forEach(function (k) { values[k] = new Uint16Array(sel.tiles[k].length).map(function (_, i) { return 1000 + i; }); });
	await store.setColumn(sel, "intensity", values);
	var k0 = Object.keys(sel.tiles)[0], t = await store.readTile(k0, { fields: ["intensity"] });
	assert.equal(t.intensity[sel.tiles[k0][0]], 1000);
	var s3 = await build(B3), sel3 = await s3.selectBox(BOX);
	await assert.rejects(s3.setColumn(sel3, "classification", 64), function (e) { return e.code === "INVALID_ARGUMENT" && /0-31/.test(e.message); });
	await assert.rejects(store.setColumn(await store.selectBox(BOX), "classification", 300), function (e) { return e.code === "INVALID_ARGUMENT" && /0 to 255/.test(e.message); });
	await assert.rejects(store.setColumn(await store.selectBox(BOX), "gpsTime", 1), function (e) { return e.code === "INVALID_ARGUMENT" && /cannot be set/.test(e.message); });
	await assert.rejects(store.setColumn(await store.selectBox(BOX), "x", 1), /cannot be set/);
});

test("addColumn / removeColumn", async function () {
	var store = await build(B7);
	await store.addColumn("facet", "i32", -1);
	assert.deepEqual(store.manifest.columns, [{ name: "facet", type: "i32", fill: -1 }]);
	var sel = await store.selectBox(BOX);
	await store.setColumn(sel, "facet", 7);
	var seven = 0, minus = 0;
	for (var key of Object.keys(store.manifest.nodes)) {
		var t = await store.readTile(key, { fields: ["facet"] }), chosen = new Set(sel.tiles[key] || []);
		for (var i = 0; i < t.count; i++) { if (chosen.has(i)) { assert.equal(t.facet[i], 7); seven++; } else { assert.equal(t.facet[i], -1); minus++; } }
	}
	assert.equal(seven, sel.count);
	assert.equal(seven + minus, 15000);
	await assert.rejects(store.addColumn("facet", "i32", 0), /taken/);
	await assert.rejects(store.addColumn("classification", "u8", 0), /taken|reserved/);
	await assert.rejects(store.addColumn("set", "u7", 0), /type/);
	await assert.rejects(store.addColumn("big", "u8", 300), /0 to 255/);
	await store.removeColumn("facet");
	assert.deepEqual(store.manifest.columns, []);
	await assert.rejects(store.readTile(Object.keys(store.manifest.nodes)[0], { fields: ["facet"] }), /facet/);
	await assert.rejects(store.removeColumn("facet"), /no added column/);
});

test("transforms compose; no tile is rewritten", async function () {
	var store = await build(B3), src = await (await openLas(B3)).readPoints({ fields: ["x", "y", "z", "gpsTime"] });
	var before = new Map();
	for (var name of await store._backend.list()) if (/\.tile$/.test(name)) before.set(name, await store._backend.get(name));
	var T1 = makeTransform({ rotateZ: 30, about: [478100, 6772100, 0] }), T2 = makeTransform({ shift: [5, -7, 2], scale: 1.001 });
	await store.transform(T1);
	await store.transform(T2);
	assert.equal(store.manifest.edits, 2);
	var at = new Map();
	for (var i = 0; i < src.count; i++) at.set(id(src.gpsTime[i]), i);
	function apply(T, p) { var m = T.m, t = T.t; return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + t[0], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + t[1], m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + t[2]]; }
	for (var key of Object.keys(store.manifest.nodes)) {
		var t = await store.readTile(key, { fields: ["x", "y", "z", "gpsTime"] });
		for (var j = 0; j < t.count; j++) {
			var s = at.get(id(t.gpsTime[j])), want = apply(T2, apply(T1, [src.x[s], src.y[s], src.z[s]]));
			assert.ok(Math.abs(t.x[j] - want[0]) < 1e-6 && Math.abs(t.y[j] - want[1]) < 1e-6 && Math.abs(t.z[j] - want[2]) < 1e-6, "point " + id(t.gpsTime[j]));
		}
	}
	for (var entry of before) assert.deepEqual(await store._backend.get(entry[0]), entry[1]);
	await assert.rejects(store.transform({ m: [1], t: [0, 0, 0] }), function (e) { return e.code === "INVALID_ARGUMENT"; });
});

test("an edit cut before its manifest leaves the store as it was", async function () {
	var map = new Map(), store = await build(B7, { where: { memory: map } });
	var was = await ids(store), wasManifest = JSON.parse(JSON.stringify(store.manifest));
	var be = store._backend, put = be.put, failed = false;
	be.put = async function (name, bytes) {
		if (/^store-[ab]\.json$/.test(name) && !failed) { failed = true; throw new Error("disk full"); }
		return put.call(be, name, bytes);
	};
	await assert.rejects(store.deletePoints(await store.selectBox(BOX)), /disk full/);
	assert.deepEqual(store.manifest, wasManifest, "the in-memory manifest is unchanged");
	var again = await openTiles({ memory: map });
	assert.deepEqual(await ids(again), was);
	var names = await again._backend.list(), keep = new Set(["store-a.json", "store-b.json", "source.head", "source.evlrs"]);
	Object.keys(again.manifest.nodes).forEach(function (k) { keep.add(k + "." + again.manifest.nodes[k].gen + ".tile"); });
	assert.deepEqual(names.filter(function (n) { return !keep.has(n); }), [], "no orphan generations");
});

test("a compressed store edits as a raw one", async function () {
	var raw = await build(B7), laz = await build(B7, { compress: true });
	for (var s of [raw, laz]) {
		await s.deletePoints(await s.selectBox(BOX));
		await s.setColumn(await s.selectPolygon(POLY), "classification", 9);
		await s.addColumn("joint_set", "u8", 0);
	}
	assert.deepEqual(await storeRecords(laz), await storeRecords(raw));
	Object.keys(raw.manifest.nodes).forEach(function (k) { assert.equal(laz.manifest.nodes[k].count, raw.manifest.nodes[k].count); });
});
