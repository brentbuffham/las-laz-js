// src/index/kdtree.js
//==========================================================
// A k-d tree for k-nearest searches over clouds whose density changes
// a thousand-fold (a handheld scan: dense beside the walk path,
// sparse far from it), where one grid cell size cannot suit every
// point. Implicit and balanced: point numbers are permuted so each
// node's points are perm[lo, hi), split at mid = floor((lo + hi) / 2)
// on the axis of the node's largest extent, with every left point at
// most the split value and every right point at least it. A node
// stores its axis (a byte) and split value (a Float64), in heap order.
// Leaves hold up to 16 points. About 4.6 bytes a point. A node whose
// points all coincide (zero extent) is not split: its point numbers are
// sorted (axis UNIFORM) and a search offers only the lowest ones, so a
// cluster of exact duplicates costs k, not its size, per search. Distances are checked in Float64 and pruning compares the
// same rounded differences, so results are exact; ties go to the
// lowest point number.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf, checkPointCount } from "./grid.js";

var LEAF = 16, UNIFORM = 3;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/**
 * Build a k-d tree over point columns.
 * @param {object} cols - point columns (x, y, z or a k = 3 positions column).
 * @param {string} fn - the calling function's name, for messages.
 * @returns {{count: number, perm: Uint32Array, axis: Uint8Array, split: Float64Array, leafSize: number, coords: object}}
 */
export function buildKdTree(cols, fn) {
	var coords = coordsOf(cols, fn), n = cols.count;
	checkPointCount(n);
	var A = [coords.x, coords.y, coords.z], st = coords.stride, i, o;
	for (i = 0, o = 0; i < n; i++, o += st) {
		var a = A[0][o], b = A[1][o], c = A[2][o];
		if (a - a !== 0 || b - b !== 0 || c - c !== 0) throw bad("point " + i + " has a non-finite " + (a - a !== 0 ? "x" : b - b !== 0 ? "y" : "z") + " coordinate");
	}
	var perm = new Uint32Array(n);
	for (i = 0; i < n; i++) perm[i] = i;
	// Internal nodes sit at depths 0 .. d - 1, where ceil(n / 2^d) <= LEAF
	var d = 0;
	while (Math.ceil(n / Math.pow(2, d)) > LEAF) d++;
	var nodes = Math.max(1, Math.pow(2, d) - 1), axis = new Uint8Array(nodes), split = new Float64Array(nodes);

	// The point at position kth of perm[lo, hi) on axis ax, smaller ones before it,
	// larger after (Hoare's selection, median-of-three pivot)
	function select(lo, hi, kth, V) {
		var l = lo, r = hi - 1;
		while (r > l) {
			var m = Math.floor((l + r) / 2), va = V[perm[l] * st], vb = V[perm[m] * st], vc = V[perm[r] * st];
			var pv = va < vb ? (vb < vc ? vb : (va < vc ? vc : va)) : (va < vc ? va : (vb < vc ? vc : vb));
			var x = l, y = r;
			do {
				while (V[perm[x] * st] < pv) x++;
				while (V[perm[y] * st] > pv) y--;
				if (x <= y) { var t = perm[x]; perm[x] = perm[y]; perm[y] = t; x++; y--; }
			} while (x <= y);
			if (kth <= y) r = y;
			else if (kth >= x) l = x;
			else return;
		}
	}

	var stack = [0, 0, n];
	while (stack.length) {
		var hi = stack.pop(), lo = stack.pop(), node = stack.pop();
		if (hi - lo <= LEAF) continue;
		var best = 0, ext = -1;
		for (var ax = 0; ax < 3; ax++) {
			var V = A[ax], mn = Infinity, mx = -Infinity;
			for (var j = lo; j < hi; j++) { var v = V[perm[j] * st]; if (v < mn) mn = v; if (v > mx) mx = v; }
			if (mx - mn > ext) { ext = mx - mn; best = ax; }
		}
		if (ext === 0) {
			// every point here is the same point: sort by number and stop
			perm.subarray(lo, hi).sort();
			axis[node] = UNIFORM;
			continue;
		}
		axis[node] = best;
		var mid = Math.floor((lo + hi) / 2);
		select(lo, hi, mid, A[best]);
		// the children reorder their ranges, so perm[mid] does not keep this value
		split[node] = A[best][perm[mid] * st];
		stack.push(2 * node + 1, lo, mid, 2 * node + 2, mid, hi);
	}
	return { count: n, perm: perm, axis: axis, split: split, leafSize: LEAF, coords: coords };
}

// The search's state, module-wide: a search is synchronous and does not nest
var T, X, Y, Z, ST, Q = [0, 0, 0], K, MAXD2, SKIP, P, D, M;

function worse(i, j) { return D[i] > D[j] || (D[i] === D[j] && P[i] > P[j]); }
function swap(i, j) { var tp = P[i]; P[i] = P[j]; P[j] = tp; var td = D[i]; D[i] = D[j]; D[j] = td; }
function down(i, len) {
	for (;;) {
		var l = 2 * i + 1, r = l + 1, w = i;
		if (l < len && worse(l, w)) w = l;
		if (r < len && worse(r, w)) w = r;
		if (w === i) return;
		swap(i, w); i = w;
	}
}
function offer(p, d) {
	if (M < K) {
		P[M] = p; D[M] = d;
		for (var i = M++; i > 0;) { var up = Math.floor((i - 1) / 2); if (!worse(i, up)) break; swap(i, up); i = up; }
	} else if (d < D[0] || (d === D[0] && p < P[0])) {
		P[0] = p; D[0] = d; down(0, M);
	}
}
function limit() { return M === K && D[0] < MAXD2 ? D[0] : MAXD2; }

function search(node, lo, hi) {
	var perm = T.perm;
	if (hi - lo <= LEAF) {
		for (var j = lo; j < hi; j++) {
			var p = perm[j];
			if (p === SKIP) continue;
			var o = p * ST, dx = X[o] - Q[0], dy = Y[o] - Q[1], dz = Z[o] - Q[2];
			var d = dx * dx + dy * dy + dz * dz;
			if (d <= MAXD2) offer(p, d);
		}
		return;
	}
	var a = T.axis[node];
	if (a === UNIFORM) {
		// one distance for all, numbers ascending: once the heap is full, the rest lose
		var u = perm[lo] * ST, ux = X[u] - Q[0], uy = Y[u] - Q[1], uz = Z[u] - Q[2], du = ux * ux + uy * uy + uz * uz;
		if (du > MAXD2) return;
		for (var i = lo; i < hi; i++) {
			var q = perm[i];
			if (q === SKIP) continue;
			if (M === K && (du > D[0] || (du === D[0] && q > P[0]))) return;
			offer(q, du);
		}
		return;
	}
	var mid = Math.floor((lo + hi) / 2);
	var diff = Q[a] - T.split[node];
	// The far side's points are at least |diff| away on this axis
	if (diff < 0) {
		search(2 * node + 1, lo, mid);
		if (diff * diff <= limit()) search(2 * node + 2, mid, hi);
	} else {
		search(2 * node + 2, mid, hi);
		if (diff * diff <= limit()) search(2 * node + 1, lo, mid);
	}
}

/**
 * The k nearest points to (qx, qy, qz), nearest first by (distance², point number).
 * Fills outP / outD2 (squared distances) and returns how many it found (<= k).
 * @param {object} tree - from buildKdTree.
 * @param {number} qx
 * @param {number} qy
 * @param {number} qz
 * @param {number} k - >= 1; outP and outD2 hold at least k.
 * @param {number} maxD2 - squared distance limit (Infinity: none).
 * @param {number} skip - a point number to leave out (-1: none).
 * @param {Uint32Array} outP
 * @param {Float64Array} outD2
 * @returns {number}
 */
export function kdNearest(tree, qx, qy, qz, k, maxD2, skip, outP, outD2) {
	if (tree.count === 0) return 0;
	T = tree; X = tree.coords.x; Y = tree.coords.y; Z = tree.coords.z; ST = tree.coords.stride;
	Q[0] = qx; Q[1] = qy; Q[2] = qz; K = k; MAXD2 = maxD2; SKIP = skip; P = outP; D = outD2; M = 0;
	search(0, 0, tree.count);
	for (var end = M - 1; end > 0; end--) { swap(0, end); down(0, end); }
	var m = M;
	T = X = Y = Z = P = D = null;
	return m;
}
