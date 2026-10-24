// test/tiles/manifest.test.js
//==========================================================
// The A/B manifest: slots alternate, the valid one with the higher
// seq is read, a torn slot leaves the previous body.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openBackend } from "../../src/tiles/backends.js";
import { writeManifest, readManifest, fnv1a, MANIFEST_NAMES } from "../../src/tiles/manifest.js";

test("fnv1a is the 32-bit FNV-1a", function () {
	assert.equal(fnv1a(new Uint8Array(0)), 0x811c9dc5);
	assert.equal(fnv1a(new TextEncoder().encode("a")), 0xe40c292c);
	assert.equal(fnv1a(new TextEncoder().encode("foobar")), 0xbf9cf968);
});

test("alternates slots and reads the higher seq", async function () {
	var be = await openBackend({ memory: new Map() });
	assert.equal(await readManifest(be), null);
	assert.equal(await writeManifest(be, { n: 1 }), 1);
	assert.equal(await writeManifest(be, { n: 2 }), 2);
	assert.equal(await writeManifest(be, { n: 3 }), 3);
	assert.deepEqual(await readManifest(be), { seq: 3, body: { n: 3 } });
	assert.deepEqual(MANIFEST_NAMES, ["store-a.json", "store-b.json"]);
	var names = await be.list();
	assert.ok(names.indexOf("store-a.json") >= 0 && names.indexOf("store-b.json") >= 0);
});

test("a torn slot leaves the previous body", async function () {
	var be = await openBackend({ memory: new Map() });
	await writeManifest(be, { n: 1 });
	await writeManifest(be, { n: 2 });   // seq 2 in store-b.json
	var newer = await be.get("store-b.json");
	await be.put("store-b.json", newer.subarray(0, newer.length >> 1));
	assert.deepEqual(await readManifest(be), { seq: 1, body: { n: 1 } });
	var tampered = await be.get("store-a.json");
	var text = new TextDecoder().decode(tampered).replace("\"n\":1", "\"n\":7");
	await be.put("store-a.json", new TextEncoder().encode(text));
	assert.equal(await readManifest(be), null);   // checksum fails, the other torn
	assert.equal(await writeManifest(be, { n: 9 }), 1);   // nothing valid: starts again
});
