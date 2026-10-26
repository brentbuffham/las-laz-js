// src/fragments/spacing.js
//==========================================================
// The point spacing of a scanned surface: 1 / sqrt(points a unit of
// area), from the distance to each sampled point's K-th nearest (K = 32). A
// surface of that spacing holds K points within r_K, so spacing =
// r_K x sqrt(pi / K); the median over up to 10,000 points shrugs off
// edges and stray points. K is 32, not 8: on a regular grid the 8th
// nearest is the diagonal one and reads the spacing 11 % low, the 32nd
// within 1 %, as for random points. The sample steps through the points
// by the golden ratio, so it cannot fall in step with a scan's rows. Orientation-free:
// a wall or a drawpoint reads as a floor does. Used for findFragments'
// floor, resolution and default maxDistance.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf } from "../index/grid.js";
import { buildKdTree, kdNearest } from "../index/kdtree.js";

var K = 32, GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * The point spacing of a surface: the side of the square each point stands for.
 * @param {object} cols - point columns (x / y / z or a k = 3 positions column), any frame.
 * @param {{sample?: number}} [options] - sample: how many points to measure at (default 10,000; at least 9).
 * @returns {number} in the columns' units; NaN for fewer than 9 points.
 * @throws {LasError} INVALID_ARGUMENT naming sample.
 */
export function pointSpacing(cols, opts) {
	var sample = opts && opts.sample !== undefined ? opts.sample : 10000;
	if (!Number.isInteger(sample) || sample < 9) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "sample must be a whole number >= 9, not " + JSON.stringify(sample));
	var n = cols.count;
	if (!(n >= 9)) return NaN;
	var co = coordsOf(cols, "pointSpacing"), X = co.x, Y = co.y, Z = co.z, st = co.stride;
	var tree = buildKdTree(cols, "pointSpacing"), m0 = Math.min(n, sample), P = new Uint32Array(K), D2 = new Float64Array(K), r = [];
	for (var j = 0; j < m0; j++) {
		var i = m0 === n ? j : Math.floor(((j * GOLDEN) % 1) * n), o = i * st, m = kdNearest(tree, X[o], Y[o], Z[o], K, Infinity, i, P, D2);
		if (m) r.push(D2[m - 1] * K / m);   // fewer than K in all (a small cloud): the m-th, scaled to K
	}
	if (!r.length) return NaN;
	r.sort(function (a, b) { return a - b; });
	return Math.sqrt(r[Math.floor((r.length - 1) / 2)]) * Math.sqrt(Math.PI / K);
}
