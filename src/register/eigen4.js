// src/register/eigen4.js
//==========================================================
// The largest eigenvalue of a symmetric 4 x 4 matrix and its unit
// eigenvector, by cyclic Jacobi rotations (the method of the 3 x 3
// solver in ops/normals.js): steady when eigenvalues are equal or
// close, which a near-symmetric set of control points gives. Horn's
// quaternion fit (fit.js) takes the rotation from it.
//==========================================================

var MAX_SWEEPS = 50;

/**
 * The largest eigenvalue of a symmetric 4 x 4 matrix, with its unit eigenvector in out (sign
 * fixed: the first non-zero component is positive). Internal; not exported from the package entry.
 * @param {Float64Array|number[]} N - 16 values, row-major, symmetric.
 * @param {Float64Array} out - out[0..3] the eigenvector.
 * @returns {number} the eigenvalue
 */
export function largestEigen4(N, out) {
	var A = Float64Array.from(N), V = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	var total = 0, i, j, k;
	for (i = 0; i < 16; i++) total += A[i] * A[i];
	for (var sweep = 0; sweep < MAX_SWEEPS; sweep++) {
		var off = 0;
		for (i = 0; i < 4; i++) for (j = i + 1; j < 4; j++) off += A[i * 4 + j] * A[i * 4 + j];
		if (off <= 1e-30 * total) break;
		for (var p = 0; p < 4; p++) {
			for (var q = p + 1; q < 4; q++) {
				var apq = A[p * 4 + q];
				if (apq === 0) continue;
				var tau = (A[q * 4 + q] - A[p * 4 + p]) / (2 * apq);
				var t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
				var c = 1 / Math.sqrt(1 + t * t), s = t * c;
				for (k = 0; k < 4; k++) {   // A <- A J (columns p, q)
					var akp = A[k * 4 + p], akq = A[k * 4 + q];
					A[k * 4 + p] = c * akp - s * akq;
					A[k * 4 + q] = s * akp + c * akq;
				}
				for (k = 0; k < 4; k++) {   // A <- J^T A (rows p, q)
					var apk = A[p * 4 + k], aqk = A[q * 4 + k];
					A[p * 4 + k] = c * apk - s * aqk;
					A[q * 4 + k] = s * apk + c * aqk;
				}
				for (k = 0; k < 4; k++) {   // V <- V J
					var vkp = V[k * 4 + p], vkq = V[k * 4 + q];
					V[k * 4 + p] = c * vkp - s * vkq;
					V[k * 4 + q] = s * vkp + c * vkq;
				}
			}
		}
	}
	var best = 0;
	for (i = 1; i < 4; i++) if (A[i * 4 + i] > A[best * 4 + best]) best = i;
	var n = 0;
	for (k = 0; k < 4; k++) { out[k] = V[k * 4 + best]; n += out[k] * out[k]; }
	n = Math.sqrt(n);
	var sign = 1;
	for (k = 0; k < 4; k++) if (out[k] !== 0) { sign = out[k] > 0 ? 1 : -1; break; }
	for (k = 0; k < 4; k++) out[k] = (sign * out[k]) / n + 0;
	return A[best * 4 + best];
}
