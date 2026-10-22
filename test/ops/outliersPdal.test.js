// test/ops/outliersPdal.test.js
//==========================================================
// PDAL's statistical outlier filter as the oracle for selectOutliers
// (opt-in: LAS_PDAL=<path to pdal>; skipped, loudly, without it).
// Both sides read the same 1 mm-rounded coordinates (see
// test/helpers/pdalOutlier.js). Points whose mean distance lies
// within 1e-9 of the threshold are left out: summation order.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOutliers } from "../../src/ops/outliers.js";
import { workingIndex, knnSearch } from "../../src/index/knn.js";
import { randomCloud } from "../helpers/clouds.js";
import { pdalStatisticalOutlier } from "../helpers/pdalOutlier.js";

var PDAL = process.env.LAS_PDAL;

// Points whose mean distance to their k nearest is within 1e-9 of the threshold
function onEdge(cols, k, mult) {
	var ix = workingIndex(cols, "t", k), n = cols.count, P = new Uint32Array(k), D = new Float64Array(k), means = [], M1 = 0, M2 = 0;
	for (var i = 0; i < n; i++) {
		knnSearch(ix, cols.x[i], cols.y[i], cols.z[i], k, Infinity, i, P, D);
		var s = 0;
		for (var j = 0; j < k; j++) s += Math.sqrt(D[j]);
		means.push(s / k);
		var d = s / k - M1, dn = d / (i + 1); M1 += dn; M2 += d * dn * i;
	}
	var thr = M1 + mult * Math.sqrt(M2 / (n - 1)), edge = new Set();
	means.forEach(function (m, i) { if (Math.abs(m - thr) <= 1e-9 * Math.max(1, thr)) edge.add(i); });
	return edge;
}

if (!PDAL) {
	test("PDAL's statistical outlier agrees with selectOutliers (LAS_PDAL not set — skipped)", { skip: "set LAS_PDAL=<path to pdal> to run" }, function () {});
}

if (PDAL) {
	test("PDAL's statistical outlier flags the same points as selectOutliers", { timeout: 300000 }, async function () {
		var flagged = 0;
		for (var kind of ["clustered", "plane", "uniform"]) {
			for (var km of [[8, 2], [4, 1], [16, 3]]) {
				var res = await pdalStatisticalOutlier(PDAL, randomCloud(5000, { seed: 41, kind: kind }), km[0], km[1]);
				var edge = onEdge(res.cols, km[0], km[1]);
				var ours = Array.from(selectOutliers(res.cols, { k: km[0], multiplier: km[1] })).filter(function (i) { return !edge.has(i); });
				assert.deepEqual(ours, res.flagged.filter(function (i) { return !edge.has(i); }), kind + " k=" + km[0] + " m=" + km[1]);
				flagged += ours.length;
			}
		}
		assert.ok(flagged > 100, flagged + " points flagged in all");
	});
}
