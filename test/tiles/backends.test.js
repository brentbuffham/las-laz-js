// test/tiles/backends.test.js
//==========================================================
// The three tile-store backends hold named blobs the same way:
// put / get / list / remove / removeAll, appenders, a bad where, and
// the OPFS lock that keeps a second writer out.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openBackend } from "../../src/tiles/backends.js";
import { eachBackend } from "../helpers/tileStores.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";

function bytes(n, seed) { var b = new Uint8Array(n); for (var i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; }   // bits-ok

eachBackend("put / get / list / remove / removeAll", async function (where, kind) {
	var be = await openBackend(where);
	assert.equal(be.kind, kind);
	var a = bytes(1000, 1), b = bytes(3, 2);
	await be.put("b.tile", b);
	await be.put("a.tile", a);
	assert.deepEqual(await be.get("a.tile"), a);
	assert.deepEqual(await be.get("b.tile"), b);
	assert.equal(await be.get("missing"), null);
	assert.deepEqual(await be.list(), ["a.tile", "b.tile"]);
	await be.put("a.tile", b);   // replaced, not appended
	assert.deepEqual(await be.get("a.tile"), b);
	await be.remove("b.tile");
	await be.remove("never");
	assert.deepEqual(await be.list(), ["a.tile"]);
	await be.removeAll();
	assert.deepEqual(await (await openBackend(where)).list(), []);
});

eachBackend("an appender appends across writes", async function (where) {
	var be = await openBackend(where);
	var ap = await be.appender("build/0-0-0-0.rec");
	var parts = [bytes(10, 1), bytes(0, 0), bytes(70000, 3), bytes(5, 4)];
	for (var p of parts) ap.write(p);
	await ap.close();
	var all = new Uint8Array(70015), o = 0;
	parts.forEach(function (p) { all.set(p, o); o += p.length; });
	assert.deepEqual(await be.get("build/0-0-0-0.rec"), all);
	assert.ok((await be.list()).indexOf("build/0-0-0-0.rec") >= 0);
});

test("a bad where is refused", async function () {
	for (var w of [null, {}, { opfs: "" }, { dir: 3 }, { memory: 5 }, "x"]) {
		await assert.rejects(openBackend(w), function (e) { return e.code === "INVALID_ARGUMENT" && /where must be/.test(e.message); });
	}
});

test("an OPFS lock held elsewhere is BAD_STORE", async function () {
	var root = createFakeRoot("root");
	var a = await openBackend({ opfs: "scan-1", root: root }), b = await openBackend({ opfs: "scan-1", root: root });
	await a.lock();
	await assert.rejects(b.lock(), function (e) { return e.code === "BAD_STORE" && /scan-1/.test(e.message); });
	a.unlock();
	await b.lock();
	b.unlock();
});
