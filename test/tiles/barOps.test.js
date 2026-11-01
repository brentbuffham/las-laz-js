// test/tiles/barOps.test.js
//==========================================================
// The store runs that finish with an edit (merge, split, dedupe,
// smooth, roughness, fragments with a column) report one bar that
// climbs to its total, the edit included, and the worker's edit
// messages post progress and take the job's abort.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLas, writeLas, buildTiles, dedupeStore, mergeStores, splitStore, smoothStore, roughnessStore, findFragmentsParallel, findFacetsParallel } from "../../src/index.js";
import { createWorkerHandler } from "../../src/workers/workerProtocol.js";

var E = 478000, N = 6771000, H = 240;
function cloud() {
	var xs = [], ys = [], zs = [], k = 0, a = 5;
	for (var x = 0; x < 10; x += 0.06) for (var y = 0; y < 10; y += 0.06) {
		a = (a * 16807) % 2147483647;
		var z = 0.3 * Math.sin(x) * Math.cos(y) + (a / 2147483647 - 0.5) * 0.004;
		xs.push(E + x); ys.push(N + y); zs.push(H + z);
		if (k++ % 7 === 0) { xs.push(E + x + 0.004); ys.push(N + y); zs.push(H + z + 0.02); }
	}
	return { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) };
}
var dirs = [], CLOUD = cloud();
async function store() {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazbar-"));
	dirs.push(dir);
	return buildTiles(await openLas(await writeLas(CLOUD, { scale: { x: 0.001, y: 0.001, z: 0.001 } })), { where: { dir: dir }, tilePoints: 2500, replace: true });
}
test.after(function () { dirs.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); }); });

// the bar as a run reports it: starts at 0, never goes back, ends at its total; after is the first report past `from` of the total
function recorder() {
	var seen = [];
	return { seen: seen, on: function (d, t) { seen.push([d, t]); },
		climbs: function (label) {
			assert.ok(seen.length >= 3, label + ": " + seen.length + " reports");
			assert.deepEqual(seen[0], [0, 1000], label);
			assert.deepEqual(seen[seen.length - 1], [1000, 1000], label);
			seen.forEach(function (e, i) { assert.equal(e[1], 1000, label); if (i) assert.ok(e[0] > seen[i - 1][0], label + ": step back at " + i); });
		},
		reached: function (from) { return seen.some(function (e) { return e[0] > from * 1000 && e[0] < 1000; }); } };
}

test("mergeStores and splitStore: one bar that ends at its total, with and without compress", { timeout: 120000 }, async function () {
	for (var compress of [false, true]) {
		var a = await store(), b = await store(), rec = recorder();
		await mergeStores([a, b], { where: { memory: new Map() }, tilePoints: 2500, compress: compress, onProgress: rec.on });
		rec.climbs("merge compress " + compress);
		var sel = await a.selectBox({ minX: E + 2, maxX: E + 5, minY: N + 2, maxY: N + 5 }), sp = recorder(), before = a.manifest.deletes;
		await splitStore(a, sel, { where: { memory: new Map() }, tilePoints: 2500, compress: compress, onProgress: sp.on });
		sp.climbs("split compress " + compress);
		assert.ok(sp.reached(0.85), "the delete from the source is on the bar");
		assert.equal(a.manifest.deletes, before + 1);
		var kp = recorder();
		await splitStore(b, await b.selectBox({ minX: E + 1, maxX: E + 2, minY: N + 1, maxY: N + 2 }), { where: { memory: new Map() }, keep: true, compress: compress, onProgress: kp.on });
		kp.climbs("split keep compress " + compress);
	}
});

test("dedupeStore, smoothStore and roughnessStore: one bar with the edit on it, and the edit takes threads and signal", { timeout: 120000 }, async function () {
	var s = await store(), d = recorder();
	var res = await dedupeStore(s, 0.01, { threads: 2, tile: 3, onProgress: d.on });
	assert.ok(res.removed > 100);
	d.climbs("dedupe"); assert.ok(d.reached(0.6), "dedupe: the delete is on the bar");
	var again = recorder();
	await dedupeStore(s, 0.01, { threads: 2, tile: 3, apply: false, onProgress: again.on });
	again.climbs("dedupe apply false");
	var sm = recorder(), out = await smoothStore(s, { maxDistance: 0.2, threads: 2, tile: 3, batchPoints: 4000, onProgress: sm.on });
	assert.ok(out.batches > 1);
	sm.climbs("smooth"); assert.ok(sm.reached(0.6), "smooth: the writes are on the bar");
	var rg = recorder(), rr = await roughnessStore(s, { maxDistance: 0.2, threads: 2, tile: 3, column: "rough", onProgress: rg.on });
	assert.ok(Object.keys(rr.byTile).length > 1);
	rg.climbs("roughness"); assert.ok(rg.reached(0.85), "roughness: the column write is on the bar");
	// without a column roughness keeps the run's own (done, total)
	var plain = [];
	await roughnessStore(s, { maxDistance: 0.2, threads: 2, tile: 3, onProgress: function (d, t) { plain.push([d, t]); } });
	assert.ok(plain.length > 2 && plain[plain.length - 1][0] === plain[plain.length - 1][1] && plain[0][1] !== 1000);
	// a stop before the edit leaves the store as it was
	var n0 = s.manifest.edits, stop = new AbortController();
	await assert.rejects(dedupeStore(s, 0.05, { threads: 2, tile: 3, signal: stop.signal, onProgress: function (d) { if (d > 100) stop.abort(); } }), { code: "ABORTED" });
	assert.equal(s.manifest.edits, n0);
});

test("fragments and facets with a column: the label write is on the bar", { timeout: 120000 }, async function () {
	var s = await store(), f = recorder();
	await findFacetsParallel(s, { maxDistance: 0.3, threads: 2, tile: 3, column: "facet", onProgress: f.on });
	f.climbs("facets column");
	assert.ok(f.reached(0.85), "the column write is on the bar");
	var g = recorder();
	await findFragmentsParallel(s, { method: "watershed", threads: 2, tile: 3, overlap: 1.5, column: "rock", onProgress: g.on });
	g.climbs("fragments column");
});

test("the worker's edit messages post progress and stop with the job", { timeout: 60000 }, async function () {
	var msgs = [], handle = createWorkerHandler(function (m) { msgs.push(m); });
	await handle({ id: 1, type: "open", payload: { blob: new Blob([await writeLas(CLOUD, { scale: { x: 0.001, y: 0.001, z: 0.001 } })]) } });
	await handle({ id: 2, type: "buildTiles", payload: { where: { memory: new Map() }, tilePoints: 2500 } });
	await handle({ id: 3, type: "selectBox", payload: { box: { minX: E + 1, maxX: E + 6, minY: N + 1, maxY: N + 6 } } });
	var sel = msgs.filter(function (m) { return m.id === 3; }).pop().result.selection || msgs.filter(function (m) { return m.id === 3; }).pop().result;
	await handle({ id: 4, type: "deletePoints", payload: { selection: sel } });
	var done = msgs.filter(function (m) { return m.id === 4 && m.type === "progress"; });
	assert.ok(done.length >= 1 && done[0].label === "editing" && done[done.length - 1].fraction === 1, JSON.stringify(done.slice(-1)));
	assert.ok(msgs.filter(function (m) { return m.id === 4; }).pop().result.manifest);
});
