// src/register/align.js
//==========================================================
// Align one cloud onto another: fit from picked pairs (fitTransform),
// then optionally refine by point-to-plane ICP. ICP thins the moving
// cloud to an even sample; each iteration maps the sample by the current
// transform, takes each point's nearest fixed point within maxDistance
// (the 0.7.0 k-d tree, built once) and that point's plane normal (from
// its k nearest however far, fitted on demand and cached: never for the
// whole fixed cloud), and solves the
// small-angle linear system for an increment, applied as an exact
// rotation about the matched points' centroid plus a shift. The increment
// is rigid (about Z only for "level") and applied on the left, so the
// picks' scale is kept. Coordinates: both clouds' columns are local to
// their origins; sums run in the fixed cloud's local frame, near 0;
// the transform is world to world.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { fitTransform, MIN_PAIRS } from "./fit.js";
import { buildKdTree, kdNearest } from "../index/kdtree.js";
import { coordsOf } from "../index/grid.js";
import { checkK, checkMaxDistance } from "../index/knn.js";
import { fitAt } from "../ops/normals.js";
import { thinSelection } from "../ops/select.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

function origin(v, name) {
	if (v === undefined) return [0, 0, 0];
	if (!(Array.isArray(v) || ArrayBuffer.isView(v)) || v.length !== 3) throw bad(name + " must be [x, y, z], three finite numbers");
	for (var i = 0; i < 3; i++) if (typeof v[i] !== "number" || !isFinite(v[i])) throw bad(name + " must be [x, y, z], three finite numbers");
	return [v[0], v[1], v[2]];
}

function whole(v, name, min) {
	if (!Number.isInteger(v) || v < min) throw bad(name + " must be a whole number >= " + min + ", not " + String(v));
	return v;
}

// Solve the symmetric positive (semi)definite n x n system A x = b in place by Cholesky, with a
// ridge of 1e-12 x trace on the diagonal; false when it is not positive definite even so
function cholesky(A, b, n, x) {
	var tr = 0, i, j, k;
	for (i = 0; i < n; i++) tr += A[i * n + i];
	for (i = 0; i < n; i++) A[i * n + i] += 1e-12 * tr;   // a zero trace fails the pivot test below
	for (j = 0; j < n; j++) {
		var d = A[j * n + j];
		for (k = 0; k < j; k++) d -= A[j * n + k] * A[j * n + k];
		if (!(d > 0)) return false;
		d = Math.sqrt(d);
		A[j * n + j] = d;
		for (i = j + 1; i < n; i++) {
			var s = A[i * n + j];
			for (k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
			A[i * n + j] = s / d;
		}
	}
	for (i = 0; i < n; i++) {   // L y = b
		var y = b[i];
		for (k = 0; k < i; k++) y -= A[i * n + k] * x[k];
		x[i] = y / A[i * n + i];
	}
	for (i = n - 1; i >= 0; i--) {   // L^T x = y
		var z = x[i];
		for (k = i + 1; k < n; k++) z -= A[k * n + i] * x[k];
		x[i] = z / A[i * n + i];
	}
	return true;
}

// The rotation by the vector w (axis w / |w|, angle |w|), row-major
function rodrigues(wx, wy, wz) {
	var a = Math.hypot(wx, wy, wz);
	if (a === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
	var kx = wx / a, ky = wy / a, kz = wz / a, c = Math.cos(a), s = Math.sin(a), v = 1 - c;
	return [
		c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
		ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
		kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v
	];
}

/**
 * Align the moving cloud onto the fixed one: a fit from picked pairs, then (with icp) point-to-plane
 * ICP on an even sample of the moving cloud.
 * @param {object} moving - point columns (x / y / z or a k = 3 positions column), local to movingOrigin.
 * @param {object} fixed - the same, local to fixedOrigin.
 * @param {{pairs: {from: ArrayLike<number>, to: ArrayLike<number>}, model?: string, movingOrigin?: number[],
 *   fixedOrigin?: number[], icp?: false|{maxDistance: number, iterations?: number, sample?: number, k?: number},
 *   onProgress?: function(number, number)}} options - pairs in world coordinates (from on the moving
 *   cloud, to on the fixed); model "rigid" (default), "level" or "scale"; origins default [0, 0, 0];
 *   icp: maxDistance required, iterations 30, sample 50,000, k 16 (neighbours per fixed normal).
 * @returns {{transform: {m: number[], t: number[]}, fit: object, icp?: {iterations: number, converged: boolean,
 *   rmsBefore: number, rmsAfter: number, used: number, sampled: number}}} world to world
 * @throws {LasError} INVALID_ARGUMENT naming the bad option (fitTransform's errors for the pairs).
 */
export function alignCloud(moving, fixed, options) {
	var o = options === undefined ? {} : options;
	if (o === null || typeof o !== "object") throw bad("options must be an object");
	if (!o.pairs || typeof o.pairs !== "object") throw bad("alignCloud needs pairs: { from, to }, the picked points in world coordinates");
	var model = o.model === undefined ? "rigid" : o.model;
	var mo = origin(o.movingOrigin, "movingOrigin"), fo = origin(o.fixedOrigin, "fixedOrigin");
	if (o.onProgress !== undefined && typeof o.onProgress !== "function") throw bad("onProgress must be a function");
	var icp = o.icp;
	var maxD, iterations, sample, k;
	if (icp) {
		if (typeof icp !== "object") throw bad("icp must be false or { maxDistance, iterations, sample, k }");
		checkMaxDistance(icp.maxDistance);
		maxD = icp.maxDistance;
		iterations = whole(icp.iterations === undefined ? 30 : icp.iterations, "icp.iterations", 1);
		sample = whole(icp.sample === undefined ? 50000 : icp.sample, "icp.sample", 1);
		k = icp.k === undefined ? 16 : icp.k;
		checkK(k, "icp.k");
		if (k < 3) throw bad("icp.k must be at least 3 (a plane needs 3 points), not " + k);
	}
	var fit = fitTransform(o.pairs.from, o.pairs.to, { model: model });
	if (!icp) return { transform: fit.transform, fit: fit };

	var mc = coordsOf(moving, "alignCloud"), tree = buildKdTree(fixed, "alignCloud"), fc = tree.coords;
	var sel = thinSelection(moving.count, Math.min(sample, moving.count)), S = sel.length;
	var sx = new Float64Array(S), sy = new Float64Array(S), sz = new Float64Array(S);
	for (var j = 0; j < S; j++) {
		var q = sel[j] * mc.stride;
		sx[j] = mc.x[q] + mo[0]; sy[j] = mc.y[q] + mo[1]; sz[j] = mc.z[q] + mo[2];
	}
	var maxD2 = maxD * maxD, need = MIN_PAIRS[model], level = model === "level";
	var normals = new Map(), P = new Uint32Array(k), D = new Float64Array(k), P1 = new Uint32Array(1), D1 = new Float64Array(1), plane = new Float64Array(7);
	// a fixed point's normal from its k nearest, however far: maxDistance is the pairing distance,
	// not the plane's neighbourhood (a cloud sparser than it would otherwise have no normals)
	var fitOpts = { k: k, maxD2: Infinity };
	// matched pairs, in the fixed cloud's local frame: p (the mapped sample), q (its nearest), n (q's normal)
	var px = new Float64Array(S), py = new Float64Array(S), pz = new Float64Array(S);
	var qx = new Float64Array(S), qy = new Float64Array(S), qz = new Float64Array(S);
	var nx = new Float64Array(S), ny = new Float64Array(S), nz = new Float64Array(S);

	function normalOf(f) {
		var hit = normals.get(f);
		if (hit !== undefined) return hit;
		var n = fitAt(tree, f, fitOpts, P, D, plane) ? [plane[0], plane[1], plane[2]] : null;
		normals.set(f, n);
		return n;
	}
	// Match the sample under T; returns { used, rms } (point-to-plane)
	function match(T) {
		var m = T.m, t = T.t, used = 0, ss = 0;
		for (var i = 0; i < S; i++) {
			var x = sx[i], y = sy[i], z = sz[i];
			var wx = m[0] * x + m[1] * y + m[2] * z + t[0] - fo[0];
			var wy = m[3] * x + m[4] * y + m[5] * z + t[1] - fo[1];
			var wz = m[6] * x + m[7] * y + m[8] * z + t[2] - fo[2];
			if (!kdNearest(tree, wx, wy, wz, 1, maxD2, -1, P1, D1)) continue;
			var f = P1[0], n = normalOf(f);
			if (!n) continue;
			var g = f * fc.stride;
			px[used] = wx; py[used] = wy; pz[used] = wz;
			qx[used] = fc.x[g]; qy[used] = fc.y[g]; qz[used] = fc.z[g];
			nx[used] = n[0]; ny[used] = n[1]; nz[used] = n[2];
			var e = (wx - qx[used]) * n[0] + (wy - qy[used]) * n[1] + (wz - qz[used]) * n[2];
			ss += e * e;
			used++;
		}
		return { used: used, rms: used ? Math.sqrt(ss / used) : NaN };
	}
	// The increment from the matched pairs: { R, c, d } (x -> R (x - c) + c + d, fixed-local frame), or null
	function increment(used) {
		var cx = 0, cy = 0, cz = 0, i;
		for (i = 0; i < used; i++) { cx += px[i]; cy += py[i]; cz += pz[i]; }
		cx /= used; cy /= used; cz /= used;
		var u = level ? 4 : 6, A = new Float64Array(u * u), b = new Float64Array(u), x = new Float64Array(u), a = new Float64Array(6);
		for (i = 0; i < used; i++) {
			var ox = px[i] - cx, oy = py[i] - cy, oz = pz[i] - cz, n0 = nx[i], n1 = ny[i], n2 = nz[i];
			var r = (qx[i] - px[i]) * n0 + (qy[i] - py[i]) * n1 + (qz[i] - pz[i]) * n2;
			if (level) { a[0] = ox * n1 - oy * n0; a[1] = n0; a[2] = n1; a[3] = n2; }
			else { a[0] = oy * n2 - oz * n1; a[1] = oz * n0 - ox * n2; a[2] = ox * n1 - oy * n0; a[3] = n0; a[4] = n1; a[5] = n2; }
			for (var p = 0; p < u; p++) {
				b[p] += a[p] * r;
				for (var s = 0; s <= p; s++) A[p * u + s] += a[p] * a[s];
			}
		}
		for (var p2 = 0; p2 < u; p2++) for (var s2 = 0; s2 < p2; s2++) A[s2 * u + p2] = A[p2 * u + s2];
		if (!cholesky(A, b, u, x)) return null;
		var R = level ? rodrigues(0, 0, x[0]) : rodrigues(x[0], x[1], x[2]);
		var d = level ? [x[1], x[2], x[3]] : [x[3], x[4], x[5]];
		var angle = level ? Math.abs(x[0]) : Math.hypot(x[0], x[1], x[2]);
		return { R: R, c: [cx, cy, cz], d: d, angle: angle, shift: Math.hypot(d[0], d[1], d[2]) };
	}
	// T <- (the increment, in world) o T: m' = R m, t' = R t + (fo + c + d) - R (fo + c)
	function compose(inc, T) {
		var R = inc.R, m = T.m, t = T.t, m2 = new Array(9), t2 = new Array(3);
		var e = [fo[0] + inc.c[0], fo[1] + inc.c[1], fo[2] + inc.c[2]];
		for (var r = 0; r < 3; r++) {
			for (var c = 0; c < 3; c++) m2[r * 3 + c] = R[r * 3] * m[c] + R[r * 3 + 1] * m[3 + c] + R[r * 3 + 2] * m[6 + c] + 0;
			// (I - R) e first: e is UTM-sized, the rotation tiny
			var re = e[r] - (R[r * 3] * e[0] + R[r * 3 + 1] * e[1] + R[r * 3 + 2] * e[2]);
			t2[r] = R[r * 3] * t[0] + R[r * 3 + 1] * t[1] + R[r * 3 + 2] * t[2] + re + inc.d[r] + 0;
		}
		return { m: m2, t: t2 };
	}

	var T = fit.transform, cur = match(T), rmsBefore = cur.rms, converged = false, it = 0;
	if (cur.used >= need) {
		while (it < iterations) {
			var inc = increment(cur.used);
			if (!inc) break;
			var next = compose(inc, T), m2 = match(next);
			it++;
			if (o.onProgress) o.onProgress(it, iterations);
			if (m2.used < need) { cur = m2; T = next; break; }
			T = next; cur = m2;
			if (inc.angle < 1e-7 && inc.shift < 1e-6 * maxD) { converged = true; break; }
		}
	}
	if (o.onProgress) o.onProgress(it, it);
	return {
		transform: T, fit: fit,
		icp: { iterations: it, converged: converged, rmsBefore: rmsBefore, rmsAfter: cur.rms, used: cur.used, sampled: S }
	};
}
