// src/ops/normals.js
//==========================================================
// Surface normals by a plane fit: the covariance of a point and its
// neighbours (the other points among its k nearest within
// maxDistance), whose smallest eigenvector is the normal, from a
// cyclic Jacobi solver on the 3 × 3 matrix (steady when eigenvalues
// are equal, as on a line of points). Sums are taken on offsets from
// the point, so UTM-sized coordinates lose nothing. Normals point up
// (z > 0; a horizontal one has x > 0, then y > 0). The residual, the
// RMS distance of the fitted points from the plane, measures the local
// noise; estimateNoise is its median over a spread sample. The fit is
// shared with denoisePoints, which weights it.
//==========================================================

import { workingIndex, knnSearch, checkK, checkMaxDistance, progress } from "../index/knn.js";
import { thinSelection } from "./select.js";

var NOISE_SAMPLE = 100000;

/**
 * Flip a unit vector so z > 0; if z is 0, x > 0; if x is also 0, y > 0.
 * @param {Float64Array|number[]} v - v[0..2], changed in place.
 */
export function orientNormal(v) {
	if (v[2] < 0 || (v[2] === 0 && (v[0] < 0 || (v[0] === 0 && v[1] < 0)))) { v[0] = -v[0]; v[1] = -v[1]; v[2] = -v[2]; }
	// no negative zeros
	v[0] += 0; v[1] += 0; v[2] += 0;
}

/**
 * The unit eigenvector of the smallest eigenvalue of a symmetric 3 × 3 matrix, oriented
 * (orientNormal), and that eigenvalue. The lowest axis wins a tie.
 * @param {Float64Array} m - [c00, c01, c02, c11, c12, c22].
 * @param {Float64Array} out - out[0..2] the vector, out[3] the eigenvalue.
 * @returns {boolean} false (out = 0, 0, 0, NaN) when the trace is 0
 */
export function smallestEigen(m, out) {
	if (!(m[0] + m[3] + m[5] > 0)) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = NaN; return false; }
	var A = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
	var V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	var PQ = [[0, 1], [0, 2], [1, 2]];
	for (var sweep = 0; sweep < 50; sweep++) {
		var off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2];
		var diag = A[0][0] * A[0][0] + A[1][1] * A[1][1] + A[2][2] * A[2][2];
		if (off <= 1e-30 * diag) break;
		for (var r = 0; r < 3; r++) {
			var p = PQ[r][0], q = PQ[r][1], apq = A[p][q];
			if (apq === 0) continue;
			// Numerical Recipes' rotation: t = tan of the angle that zeroes A[p][q]
			var theta = (A[q][q] - A[p][p]) / (2 * apq);
			var t = Math.abs(theta) > 1e150 ? 1 / (2 * theta) : (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
			var c = 1 / Math.sqrt(t * t + 1), s = t * c;
			for (var i = 0; i < 3; i++) {
				var aip = A[i][p], aiq = A[i][q];
				A[i][p] = c * aip - s * aiq; A[i][q] = s * aip + c * aiq;
			}
			for (i = 0; i < 3; i++) {
				var api = A[p][i], aqi = A[q][i];
				A[p][i] = c * api - s * aqi; A[q][i] = s * api + c * aqi;
			}
			A[p][q] = 0; A[q][p] = 0;
			for (i = 0; i < 3; i++) {
				var vip = V[i][p], viq = V[i][q];
				V[i][p] = c * vip - s * viq; V[i][q] = s * vip + c * viq;
			}
		}
	}
	var b = 0;
	if (A[1][1] < A[b][b]) b = 1;
	if (A[2][2] < A[b][b]) b = 2;
	out[0] = V[0][b]; out[1] = V[1][b]; out[2] = V[2][b];
	var len = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
	out[0] /= len; out[1] /= len; out[2] /= len;
	orientNormal(out);
	out[3] = A[b][b];
	return true;
}

var M6 = new Float64Array(6), E4 = new Float64Array(4);

/**
 * Fit a plane to point p and its m neighbours (weights w, p's own weight 1; null: all 1),
 * on offsets from p.
 * @param {ArrayLike<number>} X
 * @param {ArrayLike<number>} Y
 * @param {ArrayLike<number>} Z
 * @param {number} stride
 * @param {number} p - point number.
 * @param {Uint32Array} nbrs - neighbour point numbers (the first m).
 * @param {number} m
 * @param {Float64Array|null} w - w[j] the weight of nbrs[j].
 * @param {Float64Array} out - [nx, ny, nz, residual, cx, cy, cz]: the unit normal, the RMS distance
 *   from the plane, and the weighted centroid's offset from p.
 * @returns {boolean} false (normal 0, residual NaN) when the points do not span a plane's worth
 */
export function fitPlane(X, Y, Z, stride, p, nbrs, m, w, out) {
	var o = p * stride, px = X[o], py = Y[o], pz = Z[o];
	var W = 1, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
	for (var j = 0; j < m; j++) {
		var q = nbrs[j] * stride, wj = w ? w[j] : 1;
		var dx = X[q] - px, dy = Y[q] - py, dz = Z[q] - pz;
		W += wj; sx += wj * dx; sy += wj * dy; sz += wj * dz;
		sxx += wj * dx * dx; sxy += wj * dx * dy; sxz += wj * dx * dz;
		syy += wj * dy * dy; syz += wj * dy * dz; szz += wj * dz * dz;
	}
	var cx = sx / W, cy = sy / W, cz = sz / W;
	M6[0] = sxx - sx * cx; M6[1] = sxy - sx * cy; M6[2] = sxz - sx * cz;
	M6[3] = syy - sy * cy; M6[4] = syz - sy * cz; M6[5] = szz - sz * cz;
	out[4] = cx; out[5] = cy; out[6] = cz;
	if (!smallestEigen(M6, E4)) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = NaN; return false; }
	out[0] = E4[0]; out[1] = E4[1]; out[2] = E4[2];
	out[3] = Math.sqrt(Math.max(0, E4[3]) / W);
	return true;
}

function options(opts, fn) {
	opts = opts || {};
	var k = opts.k === undefined ? 16 : opts.k;
	checkK(k, "k");
	checkMaxDistance(opts.maxDistance);
	return { k: k, maxD2: opts.maxDistance * opts.maxDistance, maxDistance: opts.maxDistance, onProgress: opts.onProgress, fn: fn };
}

// Fit point p's plane into fit; false with fewer than 3 neighbours or no plane
function fitAt(index, p, o, P, D, fit) {
	var co = index.coords, X = co.x, Y = co.y, Z = co.z, st = co.stride, i = p * st;
	var m = knnSearch(index, X[i], Y[i], Z[i], o.k, o.maxD2, p, P, D);
	if (m < 3) { fit[0] = 0; fit[1] = 0; fit[2] = 0; fit[3] = NaN; return false; }
	return fitPlane(X, Y, Z, st, p, P, m, null, fit);
}

/**
 * Each point's surface normal and residual, from a plane fitted to it and its neighbours.
 * @param {object} cols - point columns (x, y, z or a k = 3 positions column).
 * @param {{k?: number, maxDistance: number, onProgress?: function(number, number)}} opts - k 16.
 * @returns {{normal: Float32Array, residual: Float32Array}} normal 3 values a point (0, 0, 0 with
 *   fewer than 3 neighbours); residual NaN there
 */
export function pointNormals(cols, opts) {
	var o = options(opts, "pointNormals");
	var tick = progress(o.onProgress, cols.count);
	var index = workingIndex(cols, "pointNormals", o.k, o.maxDistance), n = index.count;
	var normal = new Float32Array(3 * n), residual = new Float32Array(n);
	var P = new Uint32Array(o.k), D = new Float64Array(o.k), fit = new Float64Array(7);
	for (var p = 0; p < n; p++) {
		fitAt(index, p, o, P, D, fit);
		normal[3 * p] = fit[0]; normal[3 * p + 1] = fit[1]; normal[3 * p + 2] = fit[2];
		residual[p] = fit[3];
		tick(p + 1);
	}
	return { normal: normal, residual: residual };
}

/**
 * The cloud's noise level: the median residual (lower median, finite ones) over up to
 * 100,000 points spread evenly through it.
 * @param {object} cols - point columns (x, y, z or a k = 3 positions column).
 * @param {{k?: number, maxDistance: number}} opts - k 16.
 * @returns {number} NaN when no sampled point has a plane
 */
export function estimateNoise(cols, opts) {
	var o = options(opts, "estimateNoise");
	var index = workingIndex(cols, "estimateNoise", o.k, o.maxDistance);
	var sample = thinSelection(index.count, NOISE_SAMPLE), res = new Float64Array(sample.length), m = 0;
	var P = new Uint32Array(o.k), D = new Float64Array(o.k), fit = new Float64Array(7);
	for (var i = 0; i < sample.length; i++) {
		// Float32, as pointNormals reports it
		if (fitAt(index, sample[i], o, P, D, fit)) res[m++] = Math.fround(fit[3]);
	}
	if (m === 0) return NaN;
	var s = res.subarray(0, m).sort();
	return s[Math.floor((m - 1) / 2)];
}
