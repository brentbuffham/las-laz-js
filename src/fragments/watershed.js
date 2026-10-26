// src/fragments/watershed.js
//==========================================================
// findFragments' watershed: the rocks of a muckpile seen from above, by
// a marker-controlled watershed on a height grid. The grid holds each
// cell's highest point (heights from the lowest point, so UTM-sized
// elevations keep their precision in Float32); holes take the mean of
// at least 3 of their 8 neighbours, up to 10 passes, and what is left
// is outside the cloud. Smoothed (a Gaussian of 1.5 cells), each cell's
// relief is its height above the box mean of radius reliefRadius: the
// pile's slope is out, rock tops stand up, gaps sink. Seeds are the
// extended maxima of relief (reconstruction by dilation of relief -
// seedHeight under relief, Vincent's hybrid algorithm, 8-connected): a
// peak standing seedHeight proud seeds a rock. The seeds flood down the
// relief (Meyer: a priority queue on -relief), and rock edges form where
// floods meet. Cells under the mean surface by more than -clipBelow are
// gaps (fines) and go to no fragment; without that clip each rock takes
// its fines and reads about 30 % large. Each point takes its cell's
// label; labels under minPoints points go back to none; each fragment is
// measured as findFragments' are (PCA spans, the normal facing up, the
// outline on its plane). Areas are plan: the cells holding points, so
// the cells the hole fill adds round a selection's edge count for
// nothing. 2.5D: a wall or a drawpoint seen side-on collapses in plan
// (sideOn). Internal: reached through findFragments({ method }).
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf } from "../index/grid.js";
import { fragmentAxes } from "./axes.js";
import { facetOutline } from "../facets/outline.js";

var MAX_CELLS = 6e7, SIGMA = 1.5, FILL_PASSES = 10, SIDE_ON = 0.6;

/**
 * Fragments by watershed on a height grid.
 * @param {object} cols - point columns (x / y / z or a k = 3 positions column), any frame.
 * @param {{cell: number, reliefRadius: number, seedHeight: number, clipBelow: number, minPoints: number,
 *   onProgress?: function(number, number), keepLabels?: boolean}} o - checked by findFragments; cell in the
 *   columns' units.
 * @param {number} spacing - pointSpacing of the points (for the side-on test).
 * @returns {{fragment: Uint32Array, fragments: object[], surfaceArea: number, unassignedArea: number, cell: number,
 *   sideOn: boolean, labels?: {lab: Int32Array, cellOf: Int32Array, W: number, N: number}}} labels (with keepLabels):
 *   each cell's label before the clip, each point's cell.
 * @throws {LasError} INVALID_ARGUMENT naming cell when the grid would be too large.
 */
export function watershedFragments(cols, o, spacing) {
	var n = cols.count, i, k, d, px = o.cell, h = o.seedHeight, tick = o.onProgress || function () {}, STEPS = 7;
	var none = { fragment: new Uint32Array(n), fragments: [], surfaceArea: 0, unassignedArea: 0, cell: px, sideOn: false };
	if (n < 9) return none;
	var co = coordsOf(cols, "findFragments"), X = co.x, Y = co.y, Z = co.z, st = co.stride, x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (i = 0; i < n; i++) { var oi = i * st; if (X[oi] < x0) x0 = X[oi]; if (X[oi] > x1) x1 = X[oi]; if (Y[oi] < y0) y0 = Y[oi]; if (Y[oi] > y1) y1 = Y[oi]; if (Z[oi] < z0) z0 = Z[oi]; }
	if (!(x1 > x0) || !(y1 > y0)) return none;
	var W = Math.floor((x1 - x0) / px) + 1, H = Math.floor((y1 - y0) / px) + 1, N = W * H;
	if (!(N <= MAX_CELLS)) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "cell " + px + " makes the grid " + W + " x " + H + " cells, over " + MAX_CELLS + ": give a larger cell or crop the cloud");
	tick(1, STEPS);

	// each cell's highest point; each point's cell
	var cellOf = new Int32Array(n), hgt = new Float32Array(N).fill(NaN), hit = new Uint8Array(N), hits = 0;
	for (i = 0; i < n; i++) {
		var oj = i * st;
		k = Math.floor((Y[oj] - y0) / px) * W + Math.floor((X[oj] - x0) / px);
		cellOf[i] = k;
		if (!hit[k]) { hit[k] = 1; hits++; }
		var zz = Z[oj] - z0;
		if (!(hgt[k] >= zz)) hgt[k] = zz;
	}
	// side-on: the plan spacing from buckets of whole cells at least two point spacings wide, so a working cell
	// under the spacing (most points alone in their cell) does not read as a collapsed plan
	var sideOn = false;
	if (spacing > 0) {
		var f = Math.max(1, Math.ceil(2 * spacing / px)), BW = Math.ceil(W / f), bucket = new Uint8Array(BW * Math.ceil(H / f)), occ = 0;
		for (k = 0; k < N; k++) if (hit[k]) { var bk = Math.floor(Math.floor(k / W) / f) * BW + Math.floor((k % W) / f); if (!bucket[bk]) { bucket[bk] = 1; occ++; } }
		sideOn = Math.sqrt(occ * (f * px) * (f * px) / n) < SIDE_ON * spacing;
	}
	var D8 = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1], DX = [-1, 0, 1, -1, 1, -1, 0, 1], mask = new Uint8Array(N);
	function inGrid(c, e) { var x2 = c % W + DX[e], q = c + D8[e]; return x2 >= 0 && x2 < W && q >= 0 && q < N; }
	for (var pass = 0; pass < FILL_PASSES; pass++) {
		var add = [];
		for (k = 0; k < N; k++) {
			if (hgt[k] === hgt[k]) continue;
			var s = 0, m = 0;
			for (d = 0; d < 8; d++) if (inGrid(k, d) && hgt[k + D8[d]] === hgt[k + D8[d]]) { s += hgt[k + D8[d]]; m++; }
			if (m >= 3) add.push(k, s / m);
		}
		if (!add.length) break;
		for (var j = 0; j < add.length; j += 2) hgt[add[j]] = add[j + 1];
	}
	for (k = 0; k < N; k++) mask[k] = hgt[k] === hgt[k] ? 1 : 0;
	function ok(c, e) { return inGrid(c, e) && mask[c + D8[e]]; }
	tick(2, STEPS);

	// relief: the smoothed height above its box mean
	var fs = gauss(hgt, SIGMA), mean = boxMean(fs, Math.max(1, Math.round(o.reliefRadius / px))), relief = new Float32Array(N);
	for (k = 0; k < N; k++) relief[k] = mask[k] ? fs[k] - mean[k] : -Infinity;
	tick(3, STEPS);

	// seeds: the extended maxima of relief
	var J = new Float32Array(N);
	for (k = 0; k < N; k++) J[k] = mask[k] ? relief[k] - h : -Infinity;
	reconstruct(J, relief);
	var lab = new Int32Array(N), nl = 0, stack = new Int32Array(N), tol = 0.98 * h;   // Float32 rounding
	for (k = 0; k < N; k++) {
		if (!mask[k] || lab[k] || relief[k] - J[k] < tol) continue;
		nl++; var sp = 0; stack[sp++] = k; lab[k] = nl;
		while (sp) {
			var p = stack[--sp];
			for (d = 0; d < 8; d++) { if (!ok(p, d)) continue; var q = p + D8[d]; if (!lab[q] && relief[q] - J[q] >= tol) { lab[q] = nl; stack[sp++] = q; } }
		}
	}
	tick(4, STEPS);

	// flood down the relief: each cell takes the label of its labelled neighbour of highest relief
	var heap = new Heap(N), inq = new Uint8Array(N);
	for (k = 0; k < N; k++) if (lab[k]) for (d = 0; d < 8; d++) { if (!ok(k, d)) continue; q = k + D8[d]; if (!lab[q] && !inq[q]) { inq[q] = 1; heap.push(-relief[q], q); } }
	while (heap.n) {
		p = heap.pop(); var best = 0, bl = Infinity;
		for (d = 0; d < 8; d++) { if (!ok(p, d)) continue; q = p + D8[d]; if (lab[q] && -relief[q] < bl) { bl = -relief[q]; best = lab[q]; } }
		lab[p] = best;
		for (d = 0; d < 8; d++) { if (!ok(p, d)) continue; q = p + D8[d]; if (!lab[q] && !inq[q]) { inq[q] = 1; heap.push(-relief[q], q); } }
	}
	var labels = o.keepLabels ? { lab: Int32Array.from(lab), cellOf: cellOf, W: W, N: N } : undefined;
	// the gaps: under the mean surface by more than -clipBelow; areas over the cells holding points
	var cells = 0, unassignedCells = 0;
	for (k = 0; k < N; k++) { if (!mask[k]) continue; if (relief[k] < o.clipBelow) lab[k] = 0; if (!hit[k]) continue; cells++; if (!lab[k]) unassignedCells++; }
	tick(5, STEPS);

	// fragments: the points of each label, minPoints and up; ids by size, largest first
	var count = new Uint32Array(nl + 1), l;
	for (i = 0; i < n; i++) count[lab[cellOf[i]]]++;
	var start = new Uint32Array(nl + 2);
	for (l = 1; l <= nl; l++) start[l + 1] = start[l] + count[l];
	var members = new Uint32Array(start[nl + 1]), at = Uint32Array.from(start);
	for (i = 0; i < n; i++) { l = lab[cellOf[i]]; if (l) members[at[l]++] = i; }
	var frags = [], dropped = 0;
	for (l = 1; l <= nl; l++) {
		if (count[l] < o.minPoints) { dropped += count[l]; continue; }
		var pts = members.subarray(start[l], start[l + 1]), ax = fragmentAxes(X, Y, Z, st, pts), nv = ax.smallest;
		if (nv[2] < 0) nv = [-nv[0], -nv[1], -nv[2]];
		var shape = facetOutline(X, Y, Z, st, pts, ax.centroid, nv, 2 * px);
		frags.push({ label: l, count: pts.length, centroid: ax.centroid, normal: nv, axes: ax.axes, size: ax.axes[1], area: shape.area, outline: shape.outline, facets: [] });
	}
	frags.sort(function (a, b) { return b.size - a.size || b.count - a.count || a.label - b.label; });
	var idOf = new Uint32Array(nl + 1);
	frags.forEach(function (f, w) { f.id = w + 1; idOf[f.label] = f.id; delete f.label; });
	var fragment = new Uint32Array(n);
	for (i = 0; i < n; i++) fragment[i] = idOf[lab[cellOf[i]]];
	tick(6, STEPS);
	var surfaceArea = cells * px * px, unassignedArea = unassignedCells * px * px + dropped / n * surfaceArea;
	tick(STEPS, STEPS);
	var out = { fragment: fragment, fragments: frags, surfaceArea: surfaceArea, unassignedArea: unassignedArea, cell: px, sideOn: sideOn };
	if (labels) out.labels = labels;
	return out;

	// NaN-aware separable Gaussian, inside the cloud only
	function gauss(g, sigma) {
		var r = Math.ceil(3 * sigma), w = [], t, x, y, sum, ws, v, tmp = new Float32Array(N), res = new Float32Array(N);
		for (t = -r; t <= r; t++) w.push(Math.exp(-t * t / (2 * sigma * sigma)));
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			sum = 0; ws = 0;
			for (t = Math.max(-r, -x); t <= Math.min(r, W - 1 - x); t++) { v = g[y * W + x + t]; if (v === v) { sum += w[t + r] * v; ws += w[t + r]; } }
			tmp[y * W + x] = ws ? sum / ws : NaN;
		}
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			sum = 0; ws = 0;
			for (t = Math.max(-r, -y); t <= Math.min(r, H - 1 - y); t++) { v = tmp[(y + t) * W + x]; if (v === v) { sum += w[t + r] * v; ws += w[t + r]; } }
			res[y * W + x] = ws && mask[y * W + x] ? sum / ws : NaN;
		}
		return res;
	}
	// box mean of radius rr cells (a summed-area table), NaN-aware
	function boxMean(g, rr) {
		var S = new Float64Array((W + 1) * (H + 1)), C = new Float64Array((W + 1) * (H + 1)), res = new Float32Array(N), x, y;
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			var v = g[y * W + x], has = v === v, a = (y + 1) * (W + 1) + x + 1;
			S[a] = (has ? v : 0) + S[a - 1] + S[a - W - 1] - S[a - W - 2];
			C[a] = (has ? 1 : 0) + C[a - 1] + C[a - W - 1] - C[a - W - 2];
		}
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			var xa = Math.max(0, x - rr), xb = Math.min(W, x + rr + 1), ya = Math.max(0, y - rr), yb = Math.min(H, y + rr + 1);
			var p1 = yb * (W + 1) + xb, p2 = ya * (W + 1) + xb, p3 = yb * (W + 1) + xa, p4 = ya * (W + 1) + xa, c = C[p1] - C[p2] - C[p3] + C[p4];
			res[y * W + x] = c ? (S[p1] - S[p2] - S[p3] + S[p4]) / c : NaN;
		}
		return res;
	}
	// reconstruction by dilation of A under B, in place (Vincent's hybrid), 8-connected
	function reconstruct(A, B) {
		var x, y, c, e, q2, mx;
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			c = y * W + x; if (!mask[c]) continue;
			mx = A[c]; for (e = 0; e < 4; e++) if (ok(c, e) && A[c + D8[e]] > mx) mx = A[c + D8[e]];
			A[c] = Math.min(mx, B[c]);
		}
		var queue = new Int32Array(N), head = 0, tail = 0, size = 0, queued = new Uint8Array(N);
		for (y = H - 1; y >= 0; y--) for (x = W - 1; x >= 0; x--) {
			c = y * W + x; if (!mask[c]) continue;
			mx = A[c]; for (e = 4; e < 8; e++) if (ok(c, e) && A[c + D8[e]] > mx) mx = A[c + D8[e]];
			A[c] = Math.min(mx, B[c]);
			for (e = 4; e < 8; e++) { if (!ok(c, e)) continue; q2 = c + D8[e]; if (A[q2] < A[c] && A[q2] < B[q2]) { queued[c] = 1; queue[tail] = c; tail = (tail + 1) % N; size++; break; } }
		}
		while (size) {
			var pp = queue[head]; head = (head + 1) % N; size--; queued[pp] = 0;
			for (e = 0; e < 8; e++) {
				if (!ok(pp, e)) continue; q2 = pp + D8[e];
				if (A[q2] < A[pp] && B[q2] !== A[q2]) { A[q2] = Math.min(A[pp], B[q2]); if (!queued[q2]) { queued[q2] = 1; queue[tail] = q2; tail = (tail + 1) % N; size++; } }
			}
		}
	}
}

// a binary min-heap of cell numbers by a Float32 key
function Heap(cap) { this.k = new Float32Array(cap); this.v = new Int32Array(cap); this.n = 0; }
Heap.prototype.push = function (key, val) {
	var i = this.n++, K = this.k, V = this.v;
	while (i > 0) { var p = Math.floor((i - 1) / 2); if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
	K[i] = key; V[i] = val;
};
Heap.prototype.pop = function () {
	var K = this.k, V = this.v, top = V[0], last = --this.n, key = K[last], val = V[last], i = 0;
	for (;;) { var l = 2 * i + 1; if (l >= last) break; var r = l + 1, m = r < last && K[r] < K[l] ? r : l; if (K[m] >= key) break; K[i] = K[m]; V[i] = V[m]; i = m; }
	K[i] = key; V[i] = val;
	return top;
};
