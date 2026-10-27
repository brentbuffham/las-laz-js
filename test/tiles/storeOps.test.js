// test/tiles/storeOps.test.js
//==========================================================
// Whole-cloud edits on a tile store at UTM scale: dedupeStore removes
// what dedupe removes on the same points (the same count, XY and 3D,
// across the work tiles' seams), apply false only finds them, workers
// and this thread agree, bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLas, writeLas, buildTiles, dedupeStore, dedupe } from "../../src/index.js";

var E = 478000, N = 6771000, H = 240;
// a 12 x 12 m grid at 5 cm, every 7th point given a twin 4 mm away (and 2 cm up), at UTM scale
function cloud() {
	var xs = [], ys = [], zs = [], k = 0;
	for (var x = 0; x < 12; x += 0.05) for (var y = 0; y < 12; y += 0.05) {
		var z = 0.3 * Math.sin(x) * Math.cos(y);
		xs.push(E + x); ys.push(N + y); zs.push(H + z);
		if (k++ % 7 === 0) { xs.push(E + x + 0.004); ys.push(N + y); zs.push(H + z + 0.02); }
	}
	return { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) };
}
var dirs = [], CLOUD = cloud();
async function store() {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "lazops-"));
	dirs.push(dir);
	return buildTiles(await openLas(await writeLas(CLOUD, { scale: { x: 0.001, y: 0.001, z: 0.001 } })), { where: { dir: dir }, tilePoints: 3000, replace: true });
}
function count(s) { var n = 0; Object.keys(s.manifest.nodes).forEach(function (k) { n += s.manifest.nodes[k].count; }); return n; }
test.after(function () { dirs.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); }); });

test("dedupeStore removes what dedupe removes, across the tiles' seams", async function () {
	var want = CLOUD.count - dedupe(CLOUD, 0.01).count, want3 = CLOUD.count - dedupe(CLOUD, 0.01, { z: true }).count;
	assert.ok(want > 1000 && want3 < want, want + " / " + want3);
	var s = await store(), found = await dedupeStore(s, 0.01, { apply: false, threads: 2, tile: 3 });
	assert.ok(found.tiles >= 16 && found.threads === 2, found.tiles + " tiles");
	assert.equal(found.removed, want);
	assert.equal(count(s), CLOUD.count, "apply false: nothing deleted");
	var here = await dedupeStore(s, 0.01, { apply: false, threads: 1, tile: 3 });
	assert.deepEqual(Object.keys(here.selection.tiles).sort(), Object.keys(found.selection.tiles).sort());
	var z3 = await dedupeStore(s, 0.01, { apply: false, threads: 2, tile: 3, z: true });
	assert.equal(z3.removed, want3);
	var done = await dedupeStore(s, 0.01, { threads: 2, tile: 3 });
	assert.equal(count(s), CLOUD.count - want);
	assert.equal((await dedupeStore(s, 0.01, { apply: false, threads: 2, tile: 3 })).removed, 0, "nothing left to drop");
	assert.equal(done.removed, want);
	await assert.rejects(dedupeStore(s, 0), /tolerance/);
});
