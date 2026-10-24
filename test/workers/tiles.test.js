// test/workers/tiles.test.js
//==========================================================
// The tile messages, driven through createWorkerHandler directly:
// buildTiles from the open file, selectTiles on this side from the
// posted manifest, readTiles streamed, selectBox → deletePoints (the
// manifest posted back), writeTiles to an OPFS scratch file (the fake
// root) that reads back with the right count; openTiles, closeTiles.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerHandler } from "../../src/workers/workerProtocol.js";
import { selectTiles } from "../../src/tiles/select.js";
import { getScratchFile } from "../../src/io/ScratchBinaryFile.js";
import { openLas } from "../../src/LasReader.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";
import { tileLas } from "../helpers/tileFiles.js";
import { perspective, lookAt, multiply } from "../helpers/cameras.js";

function harness() {
	var msgs = [];
	var handle = createWorkerHandler(function (m, transfer) { msgs.push({ m: m, transfer: transfer || [] }); });
	return { msgs: msgs, handle: handle, of: function (id) { return msgs.filter(function (x) { return x.m.id === id; }); }, result: function (id) { var r = msgs.filter(function (x) { return x.m.id === id; }).pop().m; if (r.type === "error") throw new Error(r.code + ": " + r.message); return r.result; } };
}

test("worker: build, select, read, edit, write", { timeout: 60000 }, async function () {
	var h = harness(), root = createFakeRoot("root"), map = new Map();
	await h.handle({ id: 1, type: "open", payload: { blob: new Blob([tileLas({ pointFormat: 3, n: 8000, seed: 101, flatZ: 300 })]) } });
	await h.handle({ id: 2, type: "buildTiles", payload: { where: { memory: map }, tilePoints: 500 } });
	var progress = h.of(2).filter(function (x) { return x.m.type === "progress"; });
	assert.ok(progress.length > 3 && progress.some(function (p) { return p.m.phase === "tiles"; }));
	var built = h.result(2), manifest = built.manifest;
	assert.equal(built.count, 8000);
	var view = { viewProjection: multiply(perspective(50, 1.6, 1, 5000), lookAt([478100, 6772100, 700], [478100, 6772105, 300])), width: 1600, height: 1000, pointBudget: 1e6 };
	var keys = selectTiles(manifest, view).map(function (n) { return n.key; });
	assert.ok(keys.length > 1);
	await h.handle({ id: 3, type: "readTiles", payload: { keys: keys, fields: ["x", "y", "z"] } });
	var tiles = h.of(3).filter(function (x) { return x.m.type === "tile"; });
	assert.deepEqual(tiles.map(function (t) { return t.m.key; }), keys);
	tiles.forEach(function (t) { assert.ok(t.transfer.indexOf(t.m.points.x.buffer) >= 0, "buffers transferred"); });
	assert.equal(h.result(3).count, tiles.reduce(function (s, t) { return s + t.m.points.count; }, 0));
	await h.handle({ id: 4, type: "selectBox", payload: { box: { minX: 478000, maxX: 478050 } } });
	var sel = h.result(4);
	assert.ok(sel.count > 0);
	await h.handle({ id: 5, type: "deletePoints", payload: { selection: sel } });
	var after = h.result(5);
	assert.equal(after.removed, sel.count);
	assert.equal(Object.keys(after.manifest.nodes).reduce(function (s, k) { return s + after.manifest.nodes[k].count; }, 0), 8000 - sel.count);
	await h.handle({ id: 6, type: "addColumn", payload: { name: "facet", type: "i32", fill: -1 } });
	assert.deepEqual(h.result(6).manifest.columns, [{ name: "facet", type: "i32", fill: -1 }]);
	await h.handle({ id: 7, type: "writeTiles", payload: { scratchId: "out.laz", root: root, compress: true } });
	var w = h.result(7);
	assert.equal(w.count, 8000 - sel.count);
	var back = await openLas(await getScratchFile("out.laz", { root: root }));
	assert.equal(back.header.pointCount, 8000 - sel.count);
	assert.ok(back.extraBytes.some(function (f) { return f.name === "facet"; }));
	await h.handle({ id: 8, type: "closeTiles" });
	await h.handle({ id: 9, type: "readTiles", payload: { keys: keys } });
	assert.match(h.of(9).pop().m.message, /no tile store is open/);
	await h.handle({ id: 10, type: "openTiles", payload: { where: { memory: map } } });
	assert.equal(h.result(10).count, 8000 - sel.count);
});

test("worker: the other edits and selections", { timeout: 60000 }, async function () {
	var h = harness(), map = new Map();
	await h.handle({ id: 1, type: "open", payload: { blob: new Blob([tileLas({ pointFormat: 7, n: 3000, seed: 102 })]) } });
	await h.handle({ id: 2, type: "buildTiles", payload: { where: { memory: map }, tilePoints: 400 } });
	await h.handle({ id: 3, type: "selectPolygon", payload: { polygon: [478000, 6772000, 478100, 6772000, 478100, 6772100] } });
	await h.handle({ id: 4, type: "setColumn", payload: { selection: h.result(3), name: "classification", value: 40 } });
	await h.handle({ id: 5, type: "selectClasses", payload: { classes: [40] } });
	assert.equal(h.result(5).count, h.result(3).count);
	await h.handle({ id: 6, type: "keepPoints", payload: { selection: h.result(5) } });
	assert.equal(h.result(6).removed, 3000 - h.result(3).count);
	await h.handle({ id: 7, type: "transform", payload: { transform: { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [10, 0, 0] } } });
	assert.deepEqual(h.result(7).manifest.transform.t, [10, 0, 0]);
	await h.handle({ id: 8, type: "addColumn", payload: { name: "s", type: "u8", fill: 1 } });
	await h.handle({ id: 9, type: "removeColumn", payload: { name: "s" } });
	assert.deepEqual(h.result(9).manifest.columns, []);
});

test("worker: a second store replaces the first; readTiles with no keys; an empty file's progress", async function () {
	var h = harness(), a = new Map(), b = new Map();
	await h.handle({ id: 1, type: "open", payload: { blob: new Blob([tileLas({ n: 0 })]) } });
	await h.handle({ id: 2, type: "buildTiles", payload: { where: { memory: a } } });
	var prog = h.of(2).filter(function (x) { return x.m.type === "progress"; });
	assert.ok(prog.length && prog.every(function (p) { return p.m.fraction === 1; }), "a total of 0 reports fraction 1");
	await h.handle({ id: 3, type: "open", payload: { blob: new Blob([tileLas({ n: 300, seed: 103 })]) } });
	await h.handle({ id: 4, type: "buildTiles", payload: { where: { memory: b } } });
	assert.equal(h.result(4).count, 300);
	await h.handle({ id: 5, type: "openTiles", payload: { where: { memory: a } } });
	assert.equal(h.result(5).count, 0);
	await h.handle({ id: 6, type: "readTiles", payload: {} });
	assert.equal(h.result(6).count, 0);
	await h.handle({ id: 7, type: "selectPolygon", payload: { polygon: [478000, 6772000, 478100, 6772000, 478100, 6772100] } });
	assert.equal(h.result(7).count, 0);
});
