// test/workers/doubleLayer.test.js
//==========================================================
// The double-layer messages through createWorkerHandler: findDoubleLayer
// keeps its result in the Worker, classifyDoubleLayer marks the found
// points, snapDoubleLayer moves them (and clears the result), and any
// other edit clears it.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerHandler } from "../../src/workers/workerProtocol.js";
import { writeLas } from "../../src/index.js";

var E = 478000, N = 6771000, H = 240;
function cloud() {
	var xs = [], ys = [], zs = [], k = 0;
	for (var x = 0; x < 16; x += 0.25) for (var y = 0; y < 16; y += 0.25) {
		var z = 0.1 * x;
		xs.push(E + x); ys.push(N + y); zs.push(H + z);
		if (k++ % 2 === 0) { xs.push(E + x + 0.01); ys.push(N + y); zs.push(H + z - 1.2); }
	}
	return { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) };
}
function harness() {
	var msgs = [], handle = createWorkerHandler(function (m) { msgs.push(m); });
	return { handle: handle, result: function (id) { var r = msgs.filter(function (m) { return m.id === id; }).pop(); if (r.type === "error") throw new Error(r.code + ": " + r.message); return r.result; },
		error: function (id) { return msgs.filter(function (m) { return m.id === id; }).pop().message; } };
}

test("worker: find, classify, snap the double layer", { timeout: 60000 }, async function () {
	var h = harness(), map = new Map();
	await h.handle({ id: 1, type: "open", payload: { blob: new Blob([await writeLas(cloud(), { scale: { x: 0.001, y: 0.001, z: 0.001 } })]) } });
	await h.handle({ id: 2, type: "buildTiles", payload: { where: { memory: map }, tilePoints: 2000 } });
	await h.handle({ id: 3, type: "snapDoubleLayer", payload: {} });
	assert.match(h.error(3), /findDoubleLayer/);
	await h.handle({ id: 4, type: "findDoubleLayer", payload: { cell: 1, minGap: 0.4, threads: 1, tile: 6 } });
	var f = h.result(4);
	assert.ok(f.count > 1000 && f.partner === false && Math.abs(f.stats.median - 1.2) < 0.05, JSON.stringify(f.stats));
	await h.handle({ id: 5, type: "classifyDoubleLayer", payload: { value: 7 } });
	assert.ok(h.result(5).manifest);
	await h.handle({ id: 6, type: "selectClasses", payload: { classes: [7] } });
	assert.equal(h.result(6).count, f.count);
	await h.handle({ id: 7, type: "snapDoubleLayer", payload: { mode: "offset" } });
	assert.equal(h.result(7).moved, f.count);
	await h.handle({ id: 8, type: "snapDoubleLayer", payload: {} });
	assert.match(h.error(8), /findDoubleLayer/);
	await h.handle({ id: 9, type: "findDoubleLayer", payload: { cell: 1, minGap: 0.4, threads: 1, tile: 6 } });
	assert.ok(h.result(9).count < f.count * 0.02);
});

test("worker: suggest the settings, draw the found points, fix", { timeout: 60000 }, async function () {
	var h = harness(), map = new Map();
	await h.handle({ id: 1, type: "open", payload: { blob: new Blob([await writeLas(cloud(), { scale: { x: 0.001, y: 0.001, z: 0.001 } })]) } });
	await h.handle({ id: 2, type: "buildTiles", payload: { where: { memory: map }, tilePoints: 2000 } });
	await h.handle({ id: 3, type: "doubleLayerPoints", payload: {} });
	assert.match(h.error(3), /findDoubleLayer/);
	await h.handle({ id: 4, type: "suggestDoubleLayer", payload: { threads: 1, tile: 6 } });
	var s = h.result(4);
	assert.ok(s.ok && s.cell === 1 && s.minPoints === 3, JSON.stringify(s));
	await h.handle({ id: 5, type: "findDoubleLayer", payload: { cell: s.cell, minGap: s.minGap, minPoints: s.minPoints, minArea: s.minArea, bridge: s.bridge, maxGap: 5, threads: 1, tile: 6 } });
	var f = h.result(5);
	assert.ok(f.count > 1000, "found " + f.count);
	await h.handle({ id: 6, type: "doubleLayerPoints", payload: { max: 400 } });
	var p = h.result(6);
	assert.equal(p.total, f.count);
	assert.ok(p.step > 1 && p.xyz.length % 3 === 0 && p.xyz.length / 3 <= 400, "step " + p.step + ", " + p.xyz.length / 3 + " points");
	for (var i = 0; i < p.xyz.length; i += 3) assert.ok(p.xyz[i] >= E - 1 && p.xyz[i] <= E + 17 && p.xyz[i + 2] < H + 0.1 * 16, "point " + i / 3 + " at " + p.xyz[i] + ", " + p.xyz[i + 2]);
	await h.handle({ id: 7, type: "fixDoubleLayer", payload: { threads: 1, tile: 6, settings: { maxGap: 5 } } });
	var r = h.result(7);
	assert.ok(r.ok && r.manifest && r.moved >= 0.98 * f.count, JSON.stringify(r.passes));
	await h.handle({ id: 8, type: "doubleLayerPoints", payload: {} });
	assert.match(h.error(8), /findDoubleLayer/);   // the edit cleared the held result
	await h.handle({ id: 9, type: "fixDoubleLayer", payload: { threads: 1, tile: 6, settings: { maxGap: 5 } } });
	assert.equal(h.result(9).moved, 0);
});
