// test/tiles/space.test.js
//==========================================================
// Browser storage running out (a fake OPFS with a quota): buildTiles
// refuses up front when navigator.storage.estimate says it will not
// fit, and a write that hits the quota part-way is a NO_SPACE LasError
// naming what was being written, the partial store removed; the
// scratch writer too.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas, writeLas, buildTiles, listTiles, openScratchSyncWriter } from "../../src/index.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";

function cloud(n) { var c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) }; for (var i = 0; i < n; i++) { c.x[i] = 478000 + (i % 300) * 0.05; c.y[i] = 6771000 + Math.floor(i / 300) * 0.05; c.z[i] = 240; } return c; }
async function withEstimate(estimate, fn) {
	var had = Object.getOwnPropertyDescriptor(globalThis.navigator, "storage");
	Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: estimate }, configurable: true });
	try { return await fn(); } finally { if (had) Object.defineProperty(globalThis.navigator, "storage", had); else delete globalThis.navigator.storage; }
}

test("buildTiles into OPFS refuses up front when the storage will not hold it", async function () {
	var las = await openLas(await writeLas(cloud(30000)));
	await withEstimate(async function () { return { quota: 2e6, usage: 1.5e6 }; }, async function () {
		await assert.rejects(buildTiles(las, { where: { opfs: "s1", root: createFakeRoot("root") } }), function (e) {
			return e.code === "NO_SPACE" && /MB/.test(e.message) && /free/.test(e.message);
		});
	});
	// room enough: it builds
	await withEstimate(async function () { return { quota: 1e10, usage: 0 }; }, async function () {
		var s = await buildTiles(await openLas(await writeLas(cloud(30000))), { where: { opfs: "s2", root: createFakeRoot("root") } });
		assert.ok(Object.keys(s.manifest.nodes).length > 0);
	});
});

test("a write that hits the quota part-way is NO_SPACE, and the partial store goes", async function () {
	var root = createFakeRoot("root", { left: 400000 });
	await assert.rejects(buildTiles(await openLas(await writeLas(cloud(30000))), { where: { opfs: "s3", root: root }, tilePoints: 2000 }), function (e) {
		return e.code === "NO_SPACE" && /storage/.test(e.message);
	});
	assert.equal((await listTiles({ root: root })).length, 0, "no store left behind");
	var w = await openScratchSyncWriter("x.bin", { root: createFakeRoot("r", { left: 10 }) });
	assert.throws(function () { w.write(new Uint8Array(100)); }, function (e) { return e.code === "NO_SPACE" && /x\.bin/.test(e.message); });
});
