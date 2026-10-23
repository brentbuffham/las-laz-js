// test/dev/fileParts.test.js
//==========================================================
// The demo's in-memory Save sink (no File System Access): the LAS and
// LAZ streaming writers' bytes kept as ordered parts, the header write
// patched in place, so the file is held once (never a second full
// copy); the parts joined equal writeLas's output byte for byte.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPartsSink } from "../../examples/browser/fileParts.js";
import { writeLas, createLasWriter } from "../../src/write/writeLas.js";

function cloud(n) {
	var c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), classification: new Uint8Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = 477000 + i * 0.01; c.y[i] = 6770000 + (i % 977) * 0.02; c.z[i] = 300 + (i % 31) * 0.1; c.classification[i] = 2; }
	return c;
}
function slice(c, a, b) { return { count: b - a, x: c.x.subarray(a, b), y: c.y.subarray(a, b), z: c.z.subarray(a, b), classification: c.classification.subarray(a, b) }; }
function join(parts) {
	var n = parts.reduce(function (s, p) { return s + p.length; }, 0), out = new Uint8Array(n), at = 0;
	parts.forEach(function (p) { out.set(p, at); at += p.length; });
	return out;
}
var OPTS = { version: "1.2", pointFormat: 1, scale: { x: 0.001, y: 0.001, z: 0.001 }, offset: { x: 477000, y: 6770000, z: 0 }, date: new Date(Date.UTC(2026, 9, 23)) };

for (var compress of [false, true]) {
	test("the parts equal writeLas byte for byte, the file held once (" + (compress ? "LAZ" : "LAS") + ")", async function () {
		var all = cloud(23456), opts = Object.assign({ compress: compress, chunkSize: 5000, threads: 1 }, OPTS);
		var oneShot = await writeLas(all, opts);
		var ps = createPartsSink(), w = await createLasWriter(ps.sink, opts);
		for (var a = 0; a < all.count; a += 7000) await w.writePoints(slice(all, a, Math.min(all.count, a + 7000)));
		await w.close();
		var parts = ps.parts();
		assert.deepEqual(Array.from(join(parts)), Array.from(oneShot));
		assert.equal(parts.reduce(function (s, p) { return s + p.length; }, 0), oneShot.length, "no byte held twice");
		assert.equal(ps.size(), oneShot.length);
	});
}

test("a write pattern it cannot patch falls back to one contiguous copy, still exact", function () {
	var ps = createPartsSink();
	ps.sink.write(Uint8Array.from([1, 2, 3, 4]), 0);
	ps.sink.write(Uint8Array.from([9, 9]), 6);          // a gap
	ps.sink.write(Uint8Array.from([5, 6, 7]), 3);       // overlaps the first part's end and fills the gap
	assert.deepEqual(Array.from(join(ps.parts())), [1, 2, 3, 5, 6, 7, 9, 9]);
	var q = createPartsSink();
	q.sink.write(Uint8Array.from([1, 2, 3, 4]), 0);
	q.sink.write(Uint8Array.from([8, 8]), 1);           // inside the first part: patched
	q.sink.write(Uint8Array.from([5]), 4);
	assert.deepEqual(Array.from(join(q.parts())), [1, 8, 8, 4, 5]);
});

test("a write is copied (the writer may reuse its buffer)", function () {
	var ps = createPartsSink(), b = Uint8Array.from([1, 2, 3]);
	ps.sink.write(b, 0);
	b[0] = 7;
	assert.deepEqual(Array.from(join(ps.parts())), [1, 2, 3]);
});
