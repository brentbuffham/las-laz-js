// test/workers/workerProtocol.test.js
//==========================================================
// The worker message protocol, driven directly (no Worker):
// open, readPoints (+ colour), chunks (streamed), colourize,
// abort, close, errors.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerHandler } from "../../src/workers/workerProtocol.js";
import { buildLas } from "../helpers/buildLas.js";

function file(n) {
	var pts = [];
	for (var i = 0; i < n; i++) pts.push({ x: 1000 + i, y: 2000 + i, z: i, classification: 2, red: 65535, green: 0, blue: 0 });
	return new Blob([buildLas({ version: "1.2", pointFormat: 3, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: pts })]);
}

function harness() {
	var msgs = [];
	var handle = createWorkerHandler(function (m, transfer) { msgs.push({ m: m, transfer: transfer || [] }); });
	return { msgs: msgs, handle: handle, of: function (id) { return msgs.filter(function (x) { return x.m.id === id; }); } };
}

test("open returns the header, CRS and compressed flag", async function () {
	var h = harness();
	await h.handle({ id: 1, type: "open", payload: { blob: file(10) } });
	var r = h.of(1).pop().m;
	assert.equal(r.type, "result");
	assert.equal(r.result.header.pointCount, 10);
	assert.equal(r.result.compressed, false);
	assert.equal(r.result.crs.kind, null);
});

test("readPoints returns columns with every buffer in the transfer list, and colours when asked", async function () {
	var h = harness();
	await h.handle({ id: 1, type: "open", payload: { blob: file(10) } });
	await h.handle({ id: 2, type: "readPoints", payload: { fields: ["x", "y", "z"], colour: { by: "elevation" } } });
	var last = h.of(2).pop();
	assert.equal(last.m.type, "result");
	assert.equal(last.m.result.count, 10);
	assert.equal(last.m.result.x[9], 1009);
	assert.equal(last.m.result.colours.length, 30);
	assert.ok(last.transfer.indexOf(last.m.result.x.buffer) >= 0);
	assert.ok(last.transfer.indexOf(last.m.result.colours.buffer) >= 0);
	assert.ok(h.of(2).some(function (x) { return x.m.type === "progress"; }));
});

test("chunks streams a chunk message per window, then a result with the total", async function () {
	var h = harness();
	await h.handle({ id: 1, type: "open", payload: { blob: file(100), windowSize: 34 * 25 } });
	await h.handle({ id: 3, type: "chunks", payload: { fields: ["x"], colour: { by: "rgb" } } });
	var chunks = h.of(3).filter(function (x) { return x.m.type === "chunk"; });
	assert.equal(chunks.length, 4);
	assert.equal(chunks[0].m.chunk.count, 25);
	assert.deepEqual(Array.from(chunks[0].m.chunk.colours.slice(0, 3)), [255, 0, 0]);
	assert.equal(h.of(3).pop().m.result.count, 100);
});

test("colourize colours points sent to it", async function () {
	var h = harness();
	await h.handle({ id: 4, type: "colourize", payload: { points: { count: 2, z: Float64Array.from([0, 10]) }, by: "elevation" } });
	assert.deepEqual(Array.from(h.of(4).pop().m.result.slice(0, 3)), [0, 0, 255]);
});

test("readPoints before open is INVALID_ARGUMENT; an unknown message is INVALID_ARGUMENT", async function () {
	var h = harness();
	await h.handle({ id: 5, type: "readPoints", payload: {} });
	assert.equal(h.of(5).pop().m.code, "INVALID_ARGUMENT");
	await h.handle({ id: 6, type: "nonsense" });
	assert.equal(h.of(6).pop().m.code, "INVALID_ARGUMENT");
});

test("abort cancels a running read with ABORTED", async function () {
	var h = harness();
	await h.handle({ id: 1, type: "open", payload: { blob: file(2000), windowSize: 340 } });
	var p = h.handle({ id: 7, type: "readPoints", payload: { fields: ["x"] } });
	await h.handle({ id: 8, type: "abort", payload: { id: 7 } });
	await p;
	assert.equal(h.of(7).pop().m.code, "ABORTED");
});

test("close closes the reader", async function () {
	var h = harness();
	await h.handle({ id: 1, type: "open", payload: { blob: file(5) } });
	await h.handle({ id: 9, type: "close" });
	assert.equal(h.of(9).pop().m.result.closed, true);
	await h.handle({ id: 10, type: "readPoints", payload: {} });
	assert.equal(h.of(10).pop().m.code, "INVALID_ARGUMENT");
});
