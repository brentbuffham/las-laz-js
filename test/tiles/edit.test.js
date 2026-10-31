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
import { mergeStores, splitStore } from "../../src/tiles/merge.js";
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

// A column-only edit (addColumn, removeColumn, setColumn of an added column) leaves each node's
// records as they are: on a compressed store they are copied packed, never decompressed and packed
// again (Kirra 2026-10-27: one column on an 11 M-point store took ~30 s, three full re-compressions).
// store._onPack(key) fires whenever a node's records are packed.
test("column-only edits keep the packed records; a records edit packs them", async function () {
	var store = await build(B3, { compress: true });
	var packs = 0;
	store._onPack = function () { packs++; };
	var keys = Object.keys(store.manifest.nodes);
	var before = {};
	for (var k of keys) before[k] = (await store.readTile(k, { fields: ["x", "y", "z", "classification"] }));
	await store.addColumn("fragment", "u32", 0);
	var sel = await store.selectBox(BOX);
	var values = {};
	Object.keys(sel.tiles).forEach(function (key) { values[key] = new Uint32Array(sel.tiles[key].length).fill(7); });
	await store.setColumn(sel, "fragment", values);
	await store.removeColumn("fragment");
	assert.equal(packs, 0, "column-only edits packed records");
	for (var k2 of keys) {
		var after = await store.readTile(k2, { fields: ["x", "y", "z", "classification"] });
		assert.deepEqual(Array.from(after.x), Array.from(before[k2].x));
		assert.deepEqual(Array.from(after.classification), Array.from(before[k2].classification));
	}
	var sel2 = await store.selectBox(BOX);
	await store.setColumn(sel2, "classification", 9);
	assert.ok(packs > 0, "a records edit packs the nodes it changes");
});

test("a column-only edit keeps each node's box", async function () {
	var store = await build(B3, { compress: true });
	var boxes = JSON.stringify(Object.keys(store.manifest.nodes).map(function (k) { return store.manifest.nodes[k].box; }));
	await store.addColumn("w", "f32", 1);
	assert.equal(JSON.stringify(Object.keys(store.manifest.nodes).map(function (k) { return store.manifest.nodes[k].box; })), boxes);
});

test("setPositions moves points in world coordinates, through the store transform", async function () {
	var { buildTiles: bt, openLas: ol, writeLas: wl } = await import("../../src/index.js");
	var n = 2000, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), intensity: new Uint16Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = 478000 + (i % 50) * 0.1; c.y[i] = 6771000 + Math.floor(i / 50) * 0.1; c.z[i] = 240; c.intensity[i] = i; }
	var store = await bt(await ol(await wl(c, { scale: { x: 0.001, y: 0.001, z: 0.001 } })), { where: { memory: true }, tilePoints: 300 });
	await store.transform({ m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [10, 20, 5] });   // turned 90 degrees and moved
	var key = Object.keys(store.manifest.nodes).filter(function (k) { return store.manifest.nodes[k].count > 3; })[0];
	var before = await store.readTile(key, { fields: ["x", "y", "z", "intensity"] });
	var idx = Uint32Array.from([0, 2]), x = Float64Array.from([before.x[0] + 0.25, before.x[2]]), y = Float64Array.from([before.y[0], before.y[2] - 0.5]), z = Float64Array.from([before.z[0] + 1, before.z[2]]);
	await store.setPositions({ [key]: { index: idx, x: x, y: y, z: z } });
	var after = await store.readTile(key, { fields: ["x", "y", "z", "intensity"] });
	assert.ok(Math.abs(after.x[0] - x[0]) < 0.0011 && Math.abs(after.z[0] - z[0]) < 0.0011, after.x[0] + " vs " + x[0]);
	assert.ok(Math.abs(after.y[2] - y[1]) < 0.0011);
	assert.ok(Math.abs(after.x[1] - before.x[1]) < 1e-9, "an untouched point stays");
	assert.deepEqual(Array.from(after.intensity), Array.from(before.intensity), "other fields stay");
	await assert.rejects(store.setPositions({ [key]: { index: Uint32Array.from([2, 0]), x: x, y: y, z: z } }), /ascending/);
	await assert.rejects(store.setPositions({ nope: { index: idx, x: x, y: y, z: z } }), /not in the store/);
});

function everyPoint(cols) { return Uint32Array.from({ length: cols.count }, function (_, i) { return i; }); }
function evenPoints(cols) { return Uint32Array.from({ length: cols.count >> 1 }, function (_, i) { return 2 * i; }); }

test("select reports the tiles it reads, and stops on a signal", async function () {
	var store = await build(B7), seen = [];
	var sel = await store.selectBox(BOX, { onProgress: function (p) { seen.push(p); } });
	var reads = seen[seen.length - 1].total;
	assert.ok(reads > 1);
	assert.ok(seen.every(function (p) { return p.phase === "select" && p.total === reads; }));
	assert.equal(seen[0].done, 0, "the first report comes before any tile is read");
	assert.equal(seen[seen.length - 1].done, reads, "ends at the total");
	assert.ok(seen.every(function (p, i) { return !i || p.done > seen[i - 1].done; }), "climbs");
	assert.deepEqual((await store.selectBox(BOX)).tiles, sel.tiles, "the same selection without a callback");
	var ac = new AbortController(), count = 0;
	await assert.rejects(store.select(function (cols) { count++; ac.abort(); return null; }, { signal: ac.signal }), function (e) { return e.code === "ABORTED"; });
	assert.equal(count, 1, "no tile is read after the signal");
	var done = new AbortController(); done.abort();
	await assert.rejects(store.selectClasses([2], { signal: done.signal }), function (e) { return e.code === "ABORTED"; });
});

test("select on a compressed store reads through the pool and gives the raw store's selection", async function () {
	var raw = await build(B7), laz = await build(B7, { compress: true });
	try {
		var a = await raw.selectBox(BOX), b = await laz.selectBox(BOX);
		assert.equal(b.count, a.count);
		assert.deepEqual(Object.keys(b.tiles).length, Object.keys(a.tiles).length);
		var one = await laz.selectBox(BOX, { threads: 1 });
		assert.deepEqual(one.tiles, b.tiles);
	} finally {
		await raw.close(); await laz.close();
	}
});

test("setColumn, deletePoints and keepPoints report by tile, and a signal leaves the store as it was", async function () {
	var map = new Map(), store = await build(B7, { where: { memory: map } });
	var was = await ids(store), wasManifest = JSON.parse(JSON.stringify(store.manifest));
	var seen = [];
	var sel = await store.select(everyPoint);
	var touched = Object.keys(sel.tiles).length;
	assert.ok(touched > 2);
	await store.setColumn(sel, "classification", 5, { onProgress: function (p) { seen.push(p); } });
	assert.ok(seen.every(function (p) { return p.phase === "edit" && p.total === touched; }));
	assert.equal(seen[seen.length - 1].done, touched);
	// stopped after the first tile: nothing changes, no orphan file stays
	for (var op of ["setColumn", "deletePoints", "keepPoints"]) {
		var again = await store.select(evenPoints), ac = new AbortController(), before = JSON.parse(JSON.stringify(store.manifest));
		var args = op === "setColumn" ? [again, "classification", 9] : [again];
		args.push({ signal: ac.signal, onProgress: function () { ac.abort(); } });
		await assert.rejects(store[op].apply(store, args), function (e) { return e.code === "ABORTED"; });
		assert.deepEqual(store.manifest, before, op + ": the manifest is unchanged");
	}
	assert.equal(store.manifest.deletes, wasManifest.deletes, "no delete counted");
	var reopened = await openTiles({ memory: map });
	assert.deepEqual(await ids(reopened), was, "every point is still there");
	var names = await reopened._backend.list(), keep = new Set(["store-a.json", "store-b.json", "source.head", "source.evlrs"]);
	Object.keys(reopened.manifest.nodes).forEach(function (k) { keep.add(k + "." + reopened.manifest.nodes[k].gen + ".tile"); });
	assert.deepEqual(names.filter(function (n) { return !keep.has(n); }), [], "no orphan generations");
	var cls = await reopened.readTile(Object.keys(reopened.manifest.nodes)[0], { fields: ["classification"] });
	assert.ok(Array.from(cls.classification).every(function (c) { return c === 5; }), "the finished setColumn stands; the stopped ones did not run");
});

// every tile file of a store held in a Map, by name
function tileFiles(map) {
	var out = {};
	Array.from(map.keys()).filter(function (n) { return /\.tile$/.test(n); }).forEach(function (n) { out[n] = Buffer.from(map.get(n)).toString("base64"); });
	return out;
}

test("a compressed store's edits on the pool write the same files as on one thread", async function () {
	var edits = [
		function (s, sel, o) { return s.setColumn(sel, "classification", 6, o); },
		function (s, sel, o) { return s.deletePoints(sel, o); },
		function (s, sel, o) { return s.keepPoints(sel, o); }
	];
	for (var e of edits) {
		var mapA = new Map(), mapB = new Map();
		var a = await build(B7, { compress: true, where: { memory: mapA } }), b = await build(B7, { compress: true, where: { memory: mapB } });
		try {
			await e(a, await a.select(evenPoints), undefined);
			assert.ok(a._pool, "the pool decoded and packed");
			await e(b, await b.select(evenPoints, { threads: 1 }), { threads: 1 });
			assert.ok(!b._pool, "threads: 1 starts no pool");
			assert.deepEqual(tileFiles(mapA), tileFiles(mapB));
		} finally {
			await a.close(); await b.close();
		}
	}
});

test("a pool that fails mid-edit hands its tiles to this thread, with the same files", async function () {
	var mapA = new Map(), mapB = new Map();
	var a = await build(B7, { compress: true, where: { memory: mapA } }), b = await build(B7, { compress: true, where: { memory: mapB } });
	try {
		var sel = await a.select(evenPoints);   // starts the pool
		a._pool.compress = function () { return Promise.reject(new Error("worker lost")); };
		await a.setColumn(sel, "classification", 6);
		await b.setColumn(await b.select(evenPoints, { threads: 1 }), "classification", 6, { threads: 1 });
		assert.deepEqual(tileFiles(mapA), tileFiles(mapB));
	} finally {
		await a.close(); await b.close();
	}
});

test("a tile that loses every point is written empty without being decoded", async function () {
	var mapA = new Map(), mapB = new Map();
	var a = await build(B7, { compress: true, where: { memory: mapA } }), b = await build(B7, { compress: true, where: { memory: mapB } });
	try {
		var sel = await a.selectBox(BOX);   // starts the pool
		var partial = Object.keys(sel.tiles).filter(function (k) { return sel.tiles[k].length < a.manifest.nodes[k].count; }).length;
		var decodes = 0, decode = a._pool.decode;
		a._pool.decode = function () { decodes++; return decode.apply(a._pool, arguments); };
		var seen = [];
		await a.keepPoints(sel, { onProgress: function (p) { seen.push(p); } });
		var all = Object.keys(a.manifest.nodes).filter(function (k) { return a.manifest.nodes[k].count > 0 || true; }).length;
		assert.ok(partial > 0 && partial < all, "some tiles are cut, many are emptied or kept");
		assert.equal(decodes, partial, "only the tiles that keep some points and lose some are decoded");
		assert.ok(seen.length > 2 && seen[0].done === 0 && seen[seen.length - 1].done === seen[seen.length - 1].total, "progress runs from 0 to the total");
		await b.keepPoints(await b.selectBox(BOX, { threads: 1 }), { threads: 1 });
		assert.deepEqual(tileFiles(mapA), tileFiles(mapB));
		assert.equal(a.count, sel.count);
	} finally {
		await a.close(); await b.close();
	}
});

test("deletePoints: a tile deleted whole is not decoded either", async function () {
	var store = await build(B7, { compress: true });
	try {
		var sel = await store.select(everyPoint);   // every tile whole
		var decodes = 0, decode = store._pool.decode;
		store._pool.decode = function () { decodes++; return decode.apply(store._pool, arguments); };
		await store.deletePoints(sel);
		assert.equal(decodes, 0);
		assert.equal(store.count, 0);
	} finally {
		await store.close();
	}
});

test("setPositions: on the pool the files are the single thread's; progress, and a signal that leaves the store as it was", async function () {
	var mapA = new Map(), mapB = new Map();
	var a = await build(B7, { compress: true, where: { memory: mapA } }), b = await build(B7, { compress: true, where: { memory: mapB } });
	try {
		var wasManifest = JSON.parse(JSON.stringify(a.manifest));
		var value = {};
		var keys = Object.keys(a.manifest.nodes).filter(function (k) { return a.manifest.nodes[k].count > 1; });
		keys.forEach(function (k) {
			var c = a.manifest.nodes[k].count, index = Uint32Array.from([0, c - 1]);
			value[k] = { index: index, x: Float64Array.from([478000.5, 478001.25]), y: Float64Array.from([6772000.5, 6772001.25]), z: Float64Array.from([100.5, 101.25]) };
		});
		await a.select(everyPoint);   // starts the pool
		var ac = new AbortController(), ticks = 0;
		await assert.rejects(a.setPositions(value, { threads: 1, signal: ac.signal, onProgress: function () { if (++ticks === 2) ac.abort(); } }), function (e) { return e.code === "ABORTED"; });
		assert.deepEqual(a.manifest, wasManifest, "stopped: the manifest is as it was");
		var seen = [];
		await a.setPositions(value, { onProgress: function (p) { seen.push(p); } });
		await b.setPositions(value, { threads: 1 });
		assert.deepEqual(tileFiles(mapA), tileFiles(mapB));
		assert.ok(seen[0].done === 0 && seen[seen.length - 1].done === keys.length);
	} finally {
		await a.close(); await b.close();
	}
});

test("transformPoints moves the selected points by m * p + t, atomically, and a translation by the scale's multiple undoes exactly", async function () {
	var map = new Map(), store = await build(B7, { compress: true, where: { memory: map } });
	try {
		var sel = await store.selectBox(BOX), key = Object.keys(sel.tiles)[0], idx = sel.tiles[key];
		var before = await store.readTile(key, { fields: ["x", "y", "z", "gpsTime"] });
		var T = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [10, -20, 5] };
		var r = await store.transformPoints(sel, T);
		assert.equal(r.moved, sel.count);
		var after = await store.readTile(key, { fields: ["x", "y", "z", "gpsTime"] });
		var picked = new Set(Array.from(idx));
		for (var i = 0; i < before.count; i++) {
			var dx = picked.has(i) ? 10 : 0, dy = picked.has(i) ? -20 : 0, dz = picked.has(i) ? 5 : 0;
			assert.ok(Math.abs(after.x[i] - before.x[i] - dx) < 1e-6 && Math.abs(after.y[i] - before.y[i] - dy) < 1e-6 && Math.abs(after.z[i] - before.z[i] - dz) < 1e-6, "point " + i);
			assert.equal(after.gpsTime[i], before.gpsTime[i], "other fields stay");
		}
		assert.equal(store.manifest.deletes, 0);
		await store.transformPoints(sel, { m: T.m, t: [-10, 20, -5] });   // the same selection is still valid
		var back = await store.readTile(key, { fields: ["x", "y", "z"] });
		for (i = 0; i < before.count; i++) assert.ok(Math.abs(back.x[i] - before.x[i]) < 1e-9 && Math.abs(back.y[i] - before.y[i]) < 1e-9 && Math.abs(back.z[i] - before.z[i]) < 1e-9);
		// a stopped move leaves the store as it was (threads: 1: the signal is checked tile by tile)
		var ac = new AbortController(), was = JSON.parse(JSON.stringify(store.manifest)), n = 0;
		await assert.rejects(store.transformPoints(await store.select(everyPoint), T, { threads: 1, signal: ac.signal, onProgress: function () { if (++n === 2) ac.abort(); } }), function (e) { return e.code === "ABORTED"; });
		assert.deepEqual(store.manifest, was);
		await assert.rejects(store.transformPoints(sel, { m: [1, 2, 3], t: [0, 0, 0] }), /3×3/);
	} finally {
		await store.close();
	}
});

test("transformPoints goes through the store transform", async function () {
	var store = await build(B7);
	var move = makeTransform({ translate: [100, 0, 0] });
	await store.transform(move);
	var sel = await store.selectBox({ minX: 478040 + 100, maxX: 478120 + 100, minY: 6772030, maxY: 6772150 });
	assert.ok(sel.count > 0);
	var key = Object.keys(sel.tiles)[0], before = await store.readTile(key, { fields: ["x"] });
	await store.transformPoints(sel, { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 7, 0] });
	var after = await store.readTile(key, { fields: ["x"] });
	assert.ok(Math.abs(after.x[sel.tiles[key][0]] - before.x[sel.tiles[key][0]]) < 1e-9, "x is where the store transform puts it");
});

test("mergeStores and splitStore read the source's tiles on its pool, and give the same points as one thread", async function () {
	var a = await build(B7, { compress: true }), b = await build(B3, { compress: true });
	try {
		var one = await mergeStores([a, b], { where: { memory: new Map() }, threads: 1, tilePoints: 600 });
		assert.ok(!a._pool && !b._pool, "threads: 1 starts no pool");
		var pooled = await mergeStores([a, b], { where: { memory: new Map() }, tilePoints: 600 });
		assert.ok(a._pool && b._pool, "the copy decoded on the source stores' pools");
		assert.equal(pooled.count, a.count + b.count);
		assert.deepEqual(await storeRecords(pooled), await storeRecords(one));
		var sel = await a.selectBox(BOX), before = a.count;
		var part = await splitStore(a, sel, { where: { memory: new Map() }, tilePoints: 600 });
		assert.equal(part.count, sel.count);
		assert.equal(a.count, before - sel.count);
	} finally {
		await a.close(); await b.close();
	}
});
