// test/io/ScratchBinaryFile.test.js
//==========================================================
// OPFS scratch: sync writer, windowed ScratchSource reader,
// remove and stale sweep, against an in-memory fake OPFS with a
// tiny window to force refills across window edges.
// Run with: node --test test/io/ScratchBinaryFile.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openScratchSyncWriter, openScratchReader, removeScratchFile, sweepStaleScratchFiles, listScratchFiles, getScratchFile, SCRATCH_DIR } from "../../src/io/ScratchBinaryFile.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";

function ramp(n) { return Uint8Array.from({ length: n }, function (_, i) { return i; }); }

async function fileWith(root, id, bytes) {
	var w = await openScratchSyncWriter(id, { root: root });
	w.write(bytes);
	w.close();
}

test("files live in the las-scratch directory", async function () {
	var root = createFakeRoot();
	await fileWith(root, "a", ramp(4));
	var dir = await root.getDirectoryHandle(SCRATCH_DIR);
	assert.equal(SCRATCH_DIR, "las-scratch");
	assert.deepEqual(Array.from(dir.fileBytes("a")), [0, 1, 2, 3]);
});

test("writer appends and writes at positions", async function () {
	var root = createFakeRoot();
	var w = await openScratchSyncWriter("a", { root: root });
	w.write(Uint8Array.from([1, 2, 3]));
	w.writeAt(Uint8Array.from([9]), 1);
	assert.equal(w.bytesWritten(), 3);
	w.write(Uint8Array.from([4]));
	assert.equal(w.bytesWritten(), 4);
	w.close();
	var r = await openScratchReader("a", { root: root });
	assert.deepEqual(Array.from(r.slice(0, 4)), [1, 9, 3, 4]);
	r.close();
});

test("writer truncate shrinks the file", async function () {
	var root = createFakeRoot();
	var w = await openScratchSyncWriter("a", { root: root });
	w.write(ramp(10));
	w.truncate(4);
	assert.equal(w.bytesWritten(), 4);
	w.close();
	assert.equal((await openScratchReader("a", { root: root })).length(), 4);
});

test("reopening a writer starts an empty file", async function () {
	var root = createFakeRoot();
	await fileWith(root, "a", ramp(10));
	await fileWith(root, "a", ramp(2));
	assert.equal((await openScratchReader("a", { root: root })).length(), 2);
});

test("reader getters across a window refill", async function () {
	var root = createFakeRoot();
	await fileWith(root, "a", ramp(64));
	var r = await openScratchReader("a", { root: root, windowSize: 8 });
	assert.equal(r.getUint8(0), 0);
	assert.equal(r.getUint32(6, false), 0x06070809);
	assert.equal(r.getUint16(62, true), 0x3F3E);
	assert.equal(r.getUint8(1), 1);
	assert.equal(r.getInt32(60, false), 0x3C3D3E3F);
});

test("slice spanning several windows", async function () {
	var root = createFakeRoot();
	await fileWith(root, "a", ramp(64));
	var r = await openScratchReader("a", { root: root, windowSize: 8 });
	assert.deepEqual(Array.from(r.slice(5, 30)), Array.from(ramp(64).subarray(5, 30)));
});

test("byteLength caps length and reads past it throw TRUNCATED", async function () {
	var root = createFakeRoot();
	await fileWith(root, "a", ramp(100));
	var r = await openScratchReader("a", { root: root, byteLength: 60, windowSize: 16 });
	assert.equal(r.length(), 60);
	assert.equal(r.getUint8(59), 59);
	assert.throws(function () { r.getUint8(60); }, { code: "TRUNCATED", offset: 60 });
	assert.throws(function () { r.slice(50, 61); }, { code: "TRUNCATED", offset: 61 });
});

test("getFloat64 little-endian through the reader", async function () {
	var root = createFakeRoot();
	var b = new Uint8Array(24);
	new DataView(b.buffer).setFloat64(13, -0.15, true);
	await fileWith(root, "a", b);
	var r = await openScratchReader("a", { root: root, windowSize: 8 });
	assert.equal(r.getUint8(0), 0);
	assert.equal(r.getFloat64(13, true), -0.15);
});

test("opening a reader on a missing file rejects", async function () {
	await assert.rejects(openScratchReader("nope", { root: createFakeRoot() }));
});

test("removeScratchFile deletes and tolerates missing files", async function () {
	var root = createFakeRoot();
	await fileWith(root, "a", ramp(4));
	await removeScratchFile("a", { root: root });
	await removeScratchFile("a", { root: root });
	await assert.rejects(openScratchReader("a", { root: root }));
});

test("sweep removes only files older than maxAgeMs", async function () {
	var root = createFakeRoot();
	await fileWith(root, "old", ramp(4));
	await fileWith(root, "new", ramp(4));
	var now = 1000000000000;
	var dir = await root.getDirectoryHandle(SCRATCH_DIR);
	dir.setLastModified("old", now - 25 * 3600 * 1000);
	dir.setLastModified("new", now - 1 * 3600 * 1000);
	assert.equal(await sweepStaleScratchFiles({ root: root, now: now }), 1);
	assert.equal(dir.fileBytes("old"), null);
	assert.ok(dir.fileBytes("new"));
});

test("a reader cannot open while the writer still holds the file", async function () {
	var root = createFakeRoot();
	var w = await openScratchSyncWriter("a", { root: root });
	w.write(ramp(4));
	await assert.rejects(openScratchReader("a", { root: root }), { name: "NoModificationAllowedError" });
	w.close();
	assert.equal((await openScratchReader("a", { root: root })).length(), 4);
});

test("sweep skips a locked stale file and still removes the others", async function () {
	var root = createFakeRoot();
	await fileWith(root, "stale1", ramp(4));
	await fileWith(root, "stale2", ramp(4));
	var now = 1000000000000;
	var dir = await root.getDirectoryHandle(SCRATCH_DIR);
	dir.setLastModified("stale1", now - 25 * 3600 * 1000);
	dir.setLastModified("stale2", now - 25 * 3600 * 1000);
	var held = await openScratchReader("stale1", { root: root });
	assert.equal(await sweepStaleScratchFiles({ root: root, now: now }), 1);
	assert.ok(dir.fileBytes("stale1"));
	assert.equal(dir.fileBytes("stale2"), null);
	held.close();
});

test("dir option keeps files in a separate directory", async function () {
	var root = createFakeRoot();
	var w = await openScratchSyncWriter("kept.las", { root: root, dir: "las-kept" });
	w.write(ramp(5));
	w.close();
	var kept = await root.getDirectoryHandle("las-kept");
	assert.equal(kept.fileBytes("kept.las").length, 5);
	await assert.rejects(openScratchReader("kept.las", { root: root }));
	assert.equal((await openScratchReader("kept.las", { root: root, dir: "las-kept" })).length(), 5);
});

test("sweep only touches its own directory", async function () {
	var root = createFakeRoot();
	await fileWith(root, "s", ramp(2));
	var w = await openScratchSyncWriter("k", { root: root, dir: "las-kept" });
	w.write(ramp(2));
	w.close();
	var now = Date.now() + 48 * 3600 * 1000;
	assert.equal(await sweepStaleScratchFiles({ root: root, now: now }), 1);
	assert.equal((await listScratchFiles({ root: root, dir: "las-kept" })).length, 1);
});

test("listScratchFiles reports name, size and lastModified, sorted by name", async function () {
	var root = createFakeRoot();
	await fileWith(root, "b", ramp(3));
	await fileWith(root, "a", ramp(7));
	var list = await listScratchFiles({ root: root });
	assert.deepEqual(list.map(function (f) { return [f.name, f.size]; }), [["a", 7], ["b", 3]]);
	assert.equal(typeof list[0].lastModified, "number");
	assert.deepEqual(await listScratchFiles({ root: createFakeRoot() }), []);
});

test("getScratchFile returns a File readable by slice", async function () {
	var root = createFakeRoot();
	await fileWith(root, "a", ramp(10));
	var file = await getScratchFile("a", { root: root });
	assert.equal(file.size, 10);
	assert.deepEqual(Array.from(new Uint8Array(await file.slice(2, 5).arrayBuffer())), [2, 3, 4]);
	await assert.rejects(getScratchFile("missing", { root: root }));
});
