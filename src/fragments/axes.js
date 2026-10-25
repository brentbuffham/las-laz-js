// src/fragments/axes.js
//==========================================================
// A fragment's three axes: the eigenvectors of its points' 3 x 3
// covariance (register/eigen4.js's Jacobi), each measured as the
// 2nd-98th percentile span of the points' projections along it, so a
// few stray points do not stretch a rock. Spans longest first; the
// intermediate one is the sieve-size estimate. Offsets from the
// centroid in Float64, so UTM-sized coordinates lose nothing. Shared
// with the test oracle, so a fragment and its true box are measured
// the same way.
//==========================================================

import { symmetricEigen } from "../register/eigen4.js";

/**
 * The centroid and PCA axes of a set of points.
 * @param {ArrayLike<number>} X - x coordinates (point p's at p * stride); Y, Z likewise.
 * @param {ArrayLike<number>} Y
 * @param {ArrayLike<number>} Z
 * @param {number} stride - 1 for x / y / z columns, 3 for a positions column.
 * @param {Uint32Array} points - the point numbers.
 * @returns {{centroid: number[], axes: number[], vectors: number[][], smallest: number[]}} axes: spans
 *   longest first, vectors to match (unit); smallest: the smallest-eigenvalue vector (unit, unoriented).
 */
export function fragmentAxes(X, Y, Z, stride, points) {
	var m = points.length, k, o;
	if (!m) return { centroid: [0, 0, 0], axes: [0, 0, 0], vectors: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], smallest: [0, 0, 1] };
	var o0 = points[0] * stride, x0 = X[o0], y0 = Y[o0], z0 = Z[o0], sx = 0, sy = 0, sz = 0;
	for (k = 0; k < m; k++) { o = points[k] * stride; sx += X[o] - x0; sy += Y[o] - y0; sz += Z[o] - z0; }
	var mx = sx / m, my = sy / m, mz = sz / m, c = new Float64Array(9);
	for (k = 0; k < m; k++) {
		o = points[k] * stride;
		var dx = X[o] - x0 - mx, dy = Y[o] - y0 - my, dz = Z[o] - z0 - mz;
		c[0] += dx * dx; c[1] += dx * dy; c[2] += dx * dz; c[4] += dy * dy; c[5] += dy * dz; c[8] += dz * dz;
	}
	c[3] = c[1]; c[6] = c[2]; c[7] = c[5];
	var e = symmetricEigen(c, 3), V = e.vectors, lo = Math.floor(0.02 * (m - 1)), hi = Math.ceil(0.98 * (m - 1));
	var proj = new Float64Array(m), found = [];
	for (var j = 0; j < 3; j++) {
		var v = [V[j * 3], V[j * 3 + 1], V[j * 3 + 2]], l = Math.hypot(v[0], v[1], v[2]);   // Jacobi keeps the vectors unit; this only trims rounding
		v = [v[0] / l, v[1] / l, v[2] / l];
		for (k = 0; k < m; k++) { o = points[k] * stride; proj[k] = (X[o] - x0) * v[0] + (Y[o] - y0) * v[1] + (Z[o] - z0) * v[2]; }
		proj.sort();
		found.push({ span: proj[hi] - proj[lo], value: e.values[j], vector: v });
	}
	var smallest = found.reduce(function (a, b) { return b.value < a.value ? b : a; }).vector;
	found.sort(function (a, b) { return b.span - a.span || b.value - a.value; });
	return {
		centroid: [x0 + mx, y0 + my, z0 + mz],
		axes: found.map(function (f) { return f.span; }),
		vectors: found.map(function (f) { return f.vector; }),
		smallest: smallest,
	};
}
