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
