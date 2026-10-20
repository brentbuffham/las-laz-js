// test/readPointsToScratch.test.js
//==========================================================
// readPointsToScratch: the selected columns streamed to OPFS
// scratch files (one per field) instead of memory. Uses the
// in-memory fake OPFS root.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../src/LasReader.js";
import { openScratchReader, removeScratchFile, listScratchFiles } from "../src/io/ScratchBinaryFile.js";
import { createFakeRoot } from "./helpers/fakeOpfs.js";
import { buildLas } from "./helpers/buildLas.js";

function file(n) {
	var pts = [];
	for (var i = 0; i < n; i++) pts.push({ x: 500000 + i * 0.5, y: 7000000 + i, z: i % 50, classification: i % 7, intensity: i % 65536 });
	return buildLas({ version: "1.2", pointFormat: 1, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: pts });
}

function view(bytes, Type) { var copy = bytes.slice(); return new Type(copy.buffer, copy.byteOffset, copy.byteLength / Type.BYTES_PER_ELEMENT); }

test("5,000 points in 1 KiB windows: each scratch file equals the readPoints column", async function () {
	var root = createFakeRoot();
	var las = await openLas(file(5000), { windowSize: 1024 });
	var fields = ["x", "y", "z", "classification", "intensity"];
	var res = await las.readPointsToScratch({ fields: fields, root: root, prefix: "t" });
	var mem = await las.readPoints({ fields: fields });
	assert.equal(res.count, 5000);
	assert.deepEqual(res.bounds, mem.bounds);
	var types = { x: Float64Array, y: Float64Array, z: Float64Array, classification: Uint8Array, intensity: Uint16Array };
	for (var f of fields) {
		assert.equal(res.types[f], types[f].name);
		var r = await openScratchReader(res.fields[f], { root: root });
		var col = view(r.slice(0, r.length()), types[f]);
		r.close();
		assert.equal(col.length, 5000, f);
		assert.deepEqual(Array.from(col), Array.from(mem[f]), f);
	}
	for (var g of fields) await removeScratchFile(res.fields[g], { root: root });
	assert.equal((await listScratchFiles({ root: root })).length, 0);
});

test("filters apply on the way to scratch (classes [3] keeps every 7th point)", async function () {
	var root = createFakeRoot();
	var res = await (await openLas(file(700), { windowSize: 2048 })).readPointsToScratch({ fields: ["x"], classes: [3], root: root });
	assert.equal(res.count, 100);
});
