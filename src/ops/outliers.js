// src/ops/outliers.js
//==========================================================
// Stray points by PDAL's statistical outlier rule (filters.outlier,
// method=statistical): each point's mean distance to its k nearest
// other points; the mean and sample standard deviation (n - 1,
// accumulated as PDAL does) of those means over the cloud; a point
// whose mean is above mean + multiplier · sd is an outlier. Returned
// as a selection for removePoints, as selectSparse.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { workingIndex, knnSearch, checkK, progress } from "../index/knn.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/**
 * The points whose mean distance to their k nearest other points is above the cloud's
 * mean of those means plus multiplier standard deviations.
 * @param {object} cols - point columns (x, y, z or a k = 3 positions column).
 * @param {{k?: number, multiplier?: number, onProgress?: function(number, number)}} [opts] - k 8, multiplier 2 (PDAL's defaults).
 * @returns {Uint32Array} ascending point numbers
 */
export function selectOutliers(cols, opts) {
	opts = opts || {};
	var k = opts.k === undefined ? 8 : opts.k, mult = opts.multiplier === undefined ? 2 : opts.multiplier;
	checkK(k, "k");
	if (!(typeof mult === "number" && isFinite(mult))) throw bad("multiplier must be a finite number, not " + String(mult));
	var tick = progress(opts.onProgress, cols.count);
	var index = workingIndex(cols, "selectOutliers", k), n = index.count;
	if (n <= k) { tick(n); return new Uint32Array(0); }
	var co = index.coords, X = co.x, Y = co.y, Z = co.z, st = co.stride;
	var P = new Uint32Array(k), D = new Float64Array(k), means = new Float64Array(n);
	var M1 = 0, M2 = 0;
	for (var i = 0, o = 0; i < n; i++, o += st) {
		knnSearch(index, X[o], Y[o], Z[o], k, Infinity, i, P, D);
		var s = 0;
		for (var j = 0; j < k; j++) s += Math.sqrt(D[j]);
		var mean = s / k;
		means[i] = mean;
		var delta = mean - M1, dn = delta / (i + 1);
		M1 += dn; M2 += delta * dn * i;
		tick(i + 1);
	}
	var threshold = M1 + mult * Math.sqrt(M2 / (n - 1)), hits = 0;
	for (i = 0; i < n; i++) if (means[i] > threshold) hits++;
	var out = new Uint32Array(hits);
	for (i = 0, j = 0; i < n; i++) if (means[i] > threshold) out[j++] = i;
	return out;
}
