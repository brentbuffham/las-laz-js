// test/samples.test.js
//==========================================================
// Real files, as a black box (private samples, see
// test/helpers/samples.js). The oracle is each file's OWN header,
// written by the software that made it — independent of this code:
//  - the decoded point count equals the header count
//  - the decoded bounds sit within one scale step of the header bounds
//  - reading in 1 MiB windows gives the same points as 64 MiB windows
//    (files under 200 MB; the big ones are read once)
//  - a .laz opens and reports COMPRESSED_LAZ for its points (0.1.0)
// Skipped, loudly, when there are no samples.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../src/LasReader.js";
import { findSamples } from "./helpers/samples.js";

var samples = findSamples();

if (!samples.length) {
	test("real-file checks (no private samples in samples/ — skipped)", { skip: "add .las / .laz files to samples/ or list paths in samples/paths.txt" }, function () {});
}

function checksum(cols) {
	var s = 0;
	for (var i = 0; i < cols.count; i += Math.max(1, Math.floor(cols.count / 100000))) s += cols.x[i] * 1e-3 + cols.y[i] * 1e-6 + cols.z[i];
	return s;
}

samples.forEach(function (s) {
	if (s.laz) {
		test(s.id + " (LAZ): opens, reports compressed, points are COMPRESSED_LAZ", async function () {
			var las = await openLas(s.path);
			assert.equal(las.compressed, true);
			assert.ok(las.header.pointCount > 0);
			await assert.rejects(las.readPoints({ fields: ["x"] }), { code: "COMPRESSED_LAZ" });
			await las.close();
		});
		return;
	}
	test(s.id + " (LAS " + Math.round(s.size / 1048576) + " MB): count and bounds match the file's own header", { timeout: 900000 }, async function () {
		var las = await openLas(s.path);
		var h = las.header;
		var r = await las.readPoints({ fields: ["x", "y", "z"] });
		assert.equal(r.count, h.pointCount);
		var tol = Math.max(h.scale.x, h.scale.y, h.scale.z) * 1.0001 + 1e-9;
		["minX", "maxX", "minY", "maxY", "minZ", "maxZ"].forEach(function (k) {
			assert.ok(Math.abs(r.bounds[k] - h.bounds[k]) <= tol, s.id + " " + k + ": decoded " + r.bounds[k] + " vs header " + h.bounds[k]);
		});
		if (s.size < 200 * 1048576) {
			var small = await (await openLas(s.path, { windowSize: 1048576 })).readPoints({ fields: ["x", "y", "z"] });
			assert.equal(small.count, r.count);
			assert.equal(checksum(small), checksum(r));
			assert.equal(small.x[small.count - 1], r.x[r.count - 1]);
		}
		await las.close();
	});
});
