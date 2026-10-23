// test/memory.test.js
//==========================================================
// Peak memory of the whole-array paths. The oracle is arithmetic:
// readPoints must hold little more than the columns it returns, and
// writeLas little more than the file it returns. A doubling buffer
// plus a final copy (the old readPoints) peaks near 2-3x; records
// copied into a second whole-file buffer (the old writeLas) peaks at
// 2x. Bound: 1.5x the output. Measured in a child process
// (helpers/peakMemory.mjs) so other tests' memory is not counted.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildLas } from "./helpers/buildLas.js";

var PROBE = fileURLToPath(new URL("./helpers/peakMemory.mjs", import.meta.url));
var N = 3000000;

function probe(args) {
	return JSON.parse(execFileSync(process.execPath, [PROBE].concat(args), { encoding: "utf8" }).trim());
}

test("readPoints peaks at under 1.5x the columns it returns", { timeout: 120000 }, function () {
	var dir = mkdtempSync(join(tmpdir(), "las-mem-"));
	try {
		var pts = new Array(N);
		for (var i = 0; i < N; i++) pts[i] = { x: 1000 + i * 0.01, y: 2000 + (i % 977), z: i % 100 };
		var path = join(dir, "big.las");
		writeFileSync(path, buildLas({ version: "1.2", pointFormat: 0, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: pts }));
		pts = null;
		var r = probe(["read", path, String(4 * 1048576)]);      // 4 MiB windows: many chunks
		assert.equal(r.outBytes, N * 24);
		assert.ok(r.peakDelta < 1.5 * r.outBytes, "peak rose " + Math.round(r.peakDelta / 1048576) + " MB for " + Math.round(r.outBytes / 1048576) + " MB of columns");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeLas peaks at under 1.5x the file it returns", { timeout: 120000 }, function () {
	var r = probe(["write", String(N)]);
	assert.equal(r.outBytes, 227 + N * 20);
	assert.ok(r.peakDelta < 1.5 * r.outBytes, "peak rose " + Math.round(r.peakDelta / 1048576) + " MB for a " + Math.round(r.outBytes / 1048576) + " MB file");
});

test("a cropped read peaks below a full read", { timeout: 180000 }, function () {
	var dir = mkdtempSync(join(tmpdir(), "las-mem-"));
	try {
		var pts = new Array(N);
		for (var i = 0; i < N; i++) pts[i] = { x: 1000 + i * 0.01, y: 2000 + (i % 977), z: i % 100 };
		var path = join(dir, "big.las");
		writeFileSync(path, buildLas({ version: "1.2", pointFormat: 0, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: pts }));
		pts = null;
		var full = probe(["read", path, String(4 * 1048576)]);
		var cropped = probe(["read-polygon", path, String(4 * 1048576)]);
		// X rises with the index, so the first tenth of X holds a tenth of the points (the edge point
		// at the polygon's far side may add one): the columns returned are about a tenth of the full read's
		assert.equal(full.outBytes, N * 24);
		assert.ok(cropped.outBytes > full.outBytes / 11 && cropped.outBytes < full.outBytes / 9, "cropped columns are " + cropped.outBytes + " bytes of " + full.outBytes);
		// Measured 0.44 of the full peak (34 MB against 77 MB for 7 MB of columns): a fixed overhead (window
		// buffer, decoder, the columns' doubling growth) dominates the cropped peak and does not shrink with the
		// crop, so 0.75 leaves room for machine variation while still failing a crop that decodes everything.
		assert.ok(cropped.peakDelta < 0.75 * full.peakDelta, "cropped peak rose " + Math.round(cropped.peakDelta / 1048576) + " MB, a full read's " + Math.round(full.peakDelta / 1048576) + " MB");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// findFacets' own peak on one huge facet (a bench floor), normals made beforehand: measured 100 bytes a
// point before the per-point JS array of seeds, the members copy and the outline's per-point
// projections went; 39-40 after (the k-d tree build alone peaks at ~10, the facet column, flags,
// queue and seeds add ~15, V8 the rest) — 45 leaves room for machine variation
test("findFacets on one huge facet peaks under 45 bytes a point (normals made beforehand)", { timeout: 300000 }, function () {
	var r = probe(["facets", "2000000"]);
	var perPoint = r.peakDelta / r.outBytes;
	assert.ok(perPoint < 45, "findFacets peaked at " + perPoint.toFixed(1) + " bytes a point");
});
