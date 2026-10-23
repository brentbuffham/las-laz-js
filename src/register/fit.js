// src/register/fit.js
//==========================================================
// Fit a transform to point pairs (control points, or features picked
// on two clouds), closed form, least squares. "rigid" (rotation +
// shift) and "scale" (rigid + one uniform scale, Helmert) by Horn's
// quaternion method (1987), the scale by Umeyama (1991, least squares
// in the "to" space). Sums run in Float64 on offsets from each set's
// weighted centroid, so UTM-sized coordinates lose nothing. The result
// is the 0.5.0 { m, t } (p' = m p + t), with each pair's residual and
// its horizontal and vertical parts.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { smallestEigen } from "../ops/normals.js";
import { largestEigen4 } from "./eigen4.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/** Minimum pairs per model. */
export var MIN_PAIRS = Object.freeze({ rigid: 3, scale: 3 });

function isNumberList(a) {
	return Array.isArray(a) || (ArrayBuffer.isView(a) && !(a instanceof DataView) && !(a instanceof BigInt64Array) && !(a instanceof BigUint64Array));
}

// Check from / to / weights; returns the weights (all 1 when none are given)
function checkPairs(from, to, weights) {
	if (!isNumberList(from)) throw bad("from must be an array of x, y, z numbers, three per pair");
	if (!isNumberList(to)) throw bad("to must be an array of x, y, z numbers, three per pair");
	if (from.length !== to.length) throw bad("from and to must be the same length (from has " + from.length + " numbers, to " + to.length + ")");
	if (from.length % 3 !== 0) throw bad("from and to must hold x, y, z for each pair (a multiple of 3 numbers, not " + from.length + ")");
	var n = from.length / 3;
	for (var i = 0; i < from.length; i++) {
		if (typeof from[i] !== "number" || !isFinite(from[i])) throw bad("pair " + Math.floor(i / 3) + ": from has a coordinate that is not a finite number");
		if (typeof to[i] !== "number" || !isFinite(to[i])) throw bad("pair " + Math.floor(i / 3) + ": to has a coordinate that is not a finite number");
	}
	var w = new Float64Array(n).fill(1);
	if (weights !== undefined) {
		if (!isNumberList(weights) || weights.length !== n) throw bad("weights must be " + n + " numbers, one per pair");
		var sum = 0;
		for (i = 0; i < n; i++) {
			if (typeof weights[i] !== "number" || !isFinite(weights[i]) || weights[i] < 0) throw bad("weights[" + i + "] = " + weights[i] + " is not a finite number >= 0");
			w[i] = weights[i]; sum += weights[i];
		}
		if (!(sum > 0)) throw bad("weights must not all be zero");
	}
	return w;
}

/**
 * The fit of one model to the pairs, leaving out pair skip (-1: none). Internal; not exported from
 * the package entry.
 * @param {ArrayLike<number>} from
 * @param {ArrayLike<number>} to
 * @param {Float64Array} w - one weight per pair.
 * @param {string} model - "rigid" | "scale".
 * @param {number} skip
 * @returns {{m: number[], t: number[], scale: number, rotateZ: (number|undefined)}|null} null when
 *   the pairs do not fix the model (degenerate)
 */
export function solve(from, to, w, model, skip) {
	var n = w.length, W = 0, ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, i;
	for (i = 0; i < n; i++) {
		if (i === skip || !w[i]) continue;
		var wi = w[i];
		W += wi;
		ax += wi * from[3 * i]; ay += wi * from[3 * i + 1]; az += wi * from[3 * i + 2];
		bx += wi * to[3 * i]; by += wi * to[3 * i + 1]; bz += wi * to[3 * i + 2];
	}
	if (!(W > 0)) return null;
	ax /= W; ay /= W; az /= W; bx /= W; by /= W; bz /= W;
	// S = sum w a' b'^T and the from set's covariance, on centred offsets
	var Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0, aa = 0;
	var C = new Float64Array(6);
	for (i = 0; i < n; i++) {
		if (i === skip || !w[i]) continue;
		var v = w[i];
		var px = from[3 * i] - ax, py = from[3 * i + 1] - ay, pz = from[3 * i + 2] - az;
		var qx = to[3 * i] - bx, qy = to[3 * i + 1] - by, qz = to[3 * i + 2] - bz;
		Sxx += v * px * qx; Sxy += v * px * qy; Sxz += v * px * qz;
		Syx += v * py * qx; Syy += v * py * qy; Syz += v * py * qz;
		Szx += v * pz * qx; Szy += v * pz * qy; Szz += v * pz * qz;
		C[0] += v * px * px; C[1] += v * px * py; C[2] += v * px * pz; C[3] += v * py * py; C[4] += v * py * pz; C[5] += v * pz * pz;
		aa += v * (px * px + py * py + pz * pz);
	}
	// one line (or one point): the middle eigenvalue of the covariance is ~0
	var e = new Float64Array(5), trace = C[0] + C[3] + C[5];
	if (!smallestEigen(C, e) || !(e[4] > 1e-12 * trace)) return null;
	var N = [
		Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
		Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
		Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
		Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz
	];
	var q = new Float64Array(4);
	largestEigen4(N, q);
	var q0 = q[0], q1 = q[1], q2 = q[2], q3 = q[3];
	var R = [
		1 - 2 * (q2 * q2 + q3 * q3), 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2),
		2 * (q1 * q2 + q0 * q3), 1 - 2 * (q1 * q1 + q3 * q3), 2 * (q2 * q3 - q0 * q1),
		2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), 1 - 2 * (q1 * q1 + q2 * q2)
	];
	var s = 1;
	if (model === "scale") {
		// sum w b' . (R a') = sum over r, c of R[r][c] * S[c][r]
		var S = [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz], num = 0;
		for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) num += R[r * 3 + c] * S[c * 3 + r];
		s = num / aa;
	}
	var m = R.map(function (x) { return s * x + 0; });
	var t = [
		bx - (m[0] * ax + m[1] * ay + m[2] * az) + 0,
		by - (m[3] * ax + m[4] * ay + m[5] * az) + 0,
		bz - (m[6] * ax + m[7] * ay + m[8] * az) + 0
	];
	return { m: m, t: t, scale: s, rotateZ: undefined };
}

/**
 * Fit a transform taking the from points onto the to points, least squares.
 * @param {ArrayLike<number>} from - x, y, z per pair (flat; Array, Float64Array or Float32Array).
 * @param {ArrayLike<number>} to - the same length.
 * @param {{model?: string, weights?: ArrayLike<number>}} [options] - model "rigid" (default;
 *   rotation + shift, at least 3 pairs not on one line) or "scale" (rigid + one uniform scale, at
 *   least 3 pairs not on one line). weights: one per pair, >= 0, not all 0; a weight of 0 leaves a
 *   pair out of the fit but its residuals are still reported.
 * @returns {{transform: {m: number[], t: number[]}, model: string, scale: number, rotateZ: (number|undefined),
 *   residuals: Float64Array, dH: Float64Array, dZ: Float64Array, looResiduals: Float64Array, rms: number, worst: number}}
 * @throws {LasError} INVALID_ARGUMENT naming the bad argument or pair, or saying why the pairs do
 *   not fix the model.
 */
export function fitTransform(from, to, options) {
	var o = options === undefined ? {} : options;
	if (o === null || typeof o !== "object") throw bad("options must be an object");
	var model = o.model === undefined ? "rigid" : o.model;
	if (!Object.prototype.hasOwnProperty.call(MIN_PAIRS, model)) throw bad("model must be \"rigid\" or \"scale\" (got " + JSON.stringify(model) + ")");
	var w = checkPairs(from, to, o.weights), n = w.length;
	if (n < MIN_PAIRS[model]) throw bad("model " + model + " needs at least " + MIN_PAIRS[model] + " pairs (got " + n + ")");
	var f = solve(from, to, w, model, -1);
	if (!f) throw bad("the pairs do not fix a " + model + " transform: their from points lie on one line (or coincide), so the rotation about it is undetermined");
	var m = f.m, t = f.t;
	var residuals = new Float64Array(n), dH = new Float64Array(n), dZ = new Float64Array(n), sum = 0, worst = 0;
	for (var i = 0; i < n; i++) {
		var x = from[3 * i], y = from[3 * i + 1], z = from[3 * i + 2];
		var rx = m[0] * x + m[1] * y + m[2] * z + t[0] - to[3 * i];
		var ry = m[3] * x + m[4] * y + m[5] * z + t[1] - to[3 * i + 1];
		var rz = m[6] * x + m[7] * y + m[8] * z + t[2] - to[3 * i + 2];
		dH[i] = Math.hypot(rx, ry); dZ[i] = rz; residuals[i] = Math.hypot(dH[i], rz);
		sum += residuals[i] * residuals[i];
		if (residuals[i] > residuals[worst]) worst = i;
	}
	return {
		transform: { m: m, t: t }, model: model, scale: f.scale, rotateZ: f.rotateZ,
		residuals: residuals, dH: dH, dZ: dZ, looResiduals: new Float64Array(n).fill(NaN),
		rms: Math.sqrt(sum / n), worst: worst
	};
}
