// test/helpers/pdalOutlier.js
//==========================================================
// PDAL's outlier filter as an oracle: method=radius for selectSparse,
// method=statistical for selectOutliers (dev machine only:
// LAS_PDAL=<path to pdal>). The points are
// written to a temporary LAS (format 0, 1 mm scale), read back so
// both sides see the same rounded coordinates, and run through
//   pdal translate in out outlier --filters.outlier.method=radius
// PDAL marks noise as class 7. Its rules, probed with PDAL 2.10.0
// (2026-10-22): min_k counts OTHER points, so it equals our
// minNeighbours; a point exactly `radius` away is not counted (ours
// counts it); when every point would be flagged it flags none.
// Statistical (PDAL 2.10.0, 2026-10-22): mean_k nearest excluding the
// point itself, sample standard deviation (n - 1), noise when the
// mean distance is above mean + multiplier · sd — selectOutliers' rule.
// Test-only.
//==========================================================

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLas } from "../../src/LasReader.js";
import { writeLas } from "../../src/write/writeLas.js";

/**
 * @param {string} pdal - path to the pdal executable.
 * @param {object} cols - { count, x, y, z } (any numeric arrays).
 * @param {number} radius
 * @param {number} minK
 * @returns {Promise<{cols: object, flagged: number[]}>} the re-read points and PDAL's class-7 indices
 */
export function pdalRadiusOutlier(pdal, cols, radius, minK) {
	return pdalOutlier(pdal, cols, ["--filters.outlier.method=radius", "--filters.outlier.radius=" + radius, "--filters.outlier.min_k=" + minK]);
}

/**
 * @param {string} pdal - path to the pdal executable.
 * @param {object} cols - { count, x, y, z } (any numeric arrays).
 * @param {number} meanK
 * @param {number} multiplier
 * @returns {Promise<{cols: object, flagged: number[]}>} the re-read points and PDAL's class-7 indices
 */
export function pdalStatisticalOutlier(pdal, cols, meanK, multiplier) {
	return pdalOutlier(pdal, cols, ["--filters.outlier.method=statistical", "--filters.outlier.mean_k=" + meanK, "--filters.outlier.multiplier=" + multiplier]);
}

async function pdalOutlier(pdal, cols, args) {
	var dir = mkdtempSync(join(tmpdir(), "las-pdal-outlier-"));
	try {
		var input = join(dir, "in.las"), output = join(dir, "out.las");
		var n = cols.count;
		var pts = { count: n, x: Float64Array.from(cols.x), y: Float64Array.from(cols.y), z: Float64Array.from(cols.z) };
		writeFileSync(input, await writeLas(pts, { pointFormat: 0, scale: { x: 0.001, y: 0.001, z: 0.001 } }));
		var a = await openLas(input), back = await a.readPoints({ fields: ["x", "y", "z"] });
		await a.close();
		execFileSync(pdal, ["translate", input, output, "outlier"].concat(args), { stdio: "pipe" });
		var b = await openLas(output), res = await b.readPoints({ fields: ["classification"] });
		await b.close();
		var flagged = [];
		for (var i = 0; i < res.count; i++) if (res.classification[i] === 7) flagged.push(i);
		return { cols: back, flagged: flagged };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
