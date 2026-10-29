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
