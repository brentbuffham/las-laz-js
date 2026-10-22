// test/ops/sparsePdal.test.js
//==========================================================
// PDAL's radius outlier filter as the oracle for selectSparse
// (opt-in: LAS_PDAL=<path to pdal>; skipped, loudly, without it).
// PDAL does not count a point exactly `radius` away and ours does,
// so ours runs at radius − 1e-9: at 1 mm scale no squared distance
// lies between the two, and the rules then agree point for point
// (see test/helpers/pdalOutlier.js). PDAL flags nothing when every
// point would be flagged; those cases are skipped.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSparse } from "../../src/ops/sparse.js";
import { randomCloud } from "../helpers/clouds.js";
import { pdalRadiusOutlier } from "../helpers/pdalOutlier.js";

var PDAL = process.env.LAS_PDAL;

if (!PDAL) {
	test("PDAL's radius outlier agrees with selectSparse (LAS_PDAL not set — skipped)", { skip: "set LAS_PDAL=<path to pdal> to run" }, function () {});
}

if (PDAL) {
	test("PDAL's radius outlier flags the same points as selectSparse", { timeout: 300000 }, async function () {
		var compared = 0, flagged = 0;
		for (var kind of ["clustered", "uniform"]) {
			for (var R of [1, 2.5]) {
				for (var K of [1, 3]) {
					var res = await pdalRadiusOutlier(PDAL, randomCloud(5000, { seed: 31, kind: kind }), R, K);
					var ours = Array.from(selectSparse(res.cols, { radius: R - 1e-9, minNeighbours: K }));
					if (ours.length === res.cols.count) continue;   // PDAL flags none then
					assert.deepEqual(ours, res.flagged, kind + " R=" + R + " K=" + K);
					compared++; flagged += ours.length;
				}
			}
		}
		assert.ok(compared >= 6, compared + " cases compared");
		assert.ok(flagged > 100, flagged + " points flagged in all");
	});

	test("a pair exactly radius apart: PDAL flags it, ours keeps it", async function () {
		var res = await pdalRadiusOutlier(PDAL, { count: 4, x: [0, 1, 100, 102], y: [0, 0, 0, 0], z: [0, 0, 0, 0] }, 2, 1);
		assert.deepEqual(res.flagged, [2, 3]);
		assert.deepEqual(Array.from(selectSparse(res.cols, { radius: 2 })), []);
		assert.deepEqual(Array.from(selectSparse(res.cols, { radius: 2 - 1e-9 })), [2, 3]);
	});
}
