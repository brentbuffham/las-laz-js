// examples/browser/watershed.js
//==========================================================
// Experimental: fragments of a muckpile seen from above by a
// marker-controlled watershed on a height grid, for the Fragments tab
// beside findFragments (not in the library yet). The grid holds the
// highest point of each cell (holes filled from their neighbours),
// lightly smoothed; relief is the height above the local mean surface
// (a box of reliefRadius), so the pile's slope is out. Seeds are the
// relief peaks standing at least seedHeight above their surroundings
// (extended maxima, by reconstruction); they flood down the relief, and
// rock edges form where floods meet. Cells under the mean surface (the
// gaps and fines between rocks) are left in no fragment. 2.5D: for a
// drawpoint, a steep face or an overhang use the facet method. Scored
// against hand-drawn rocks on an ODM ultra cloud (1.36 cm), it matched
// about a third more rocks than facet merging, mostly by splitting fewer.
// Returns findFragments' shape, so the tab's colours, outlines, hover,
// selection and size curve work unchanged. Results in the columns' frame.
//==========================================================

import { fragmentAxes } from "../../src/fragments/axes.js";
import { facetOutline } from "../../src/facets/outline.js";
import { findFragments } from "../../src/index.js";

var SHEET_CB = 0.15;   // c / b under this: a flat patch of surface, not a rock (the 0.12.0 sheet cut)

/**
 * Fragments by watershed on a height grid.
 * @param {{count: number, x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>}} cols
 * @param {{cell?: number, reliefRadius?: number, seedHeight?: number, minPoints?: number,
 *   onProgress?: function(number, number)}} opts - cell: the grid's cell (default 1.5 x the point spacing);
 *   reliefRadius 0.5; seedHeight 0.01; minPoints 50.
 * @returns {{fragment: Uint32Array, fragments: object[], surfaceArea: number, unassignedArea: number,
 *   facets: {facets: Array}, planeDistance: number, cell: number, spacing: number}}
 */
export function watershedFragments(cols, opts) {
	var o = opts || {}, n = cols.count, X = cols.x, Y = cols.y, Z = cols.z, i, k, d;
	var R = o.reliefRadius || 0.5, h = o.seedHeight || 0.01, minPoints = o.minPoints || 50;
	var tick = o.onProgress || function () {}, STEPS = 7;
	var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (i = 0; i < n; i++) { if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i]; if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i]; }
	var empty = { fragment: new Uint32Array(n), fragments: [], surfaceArea: 0, unassignedArea: 0, facets: { facets: [] }, planeDistance: NaN, cell: 0, spacing: NaN };
	if (n < 9 || !(x1 > x0) || !(y1 > y0)) return empty;

	// the point spacing from the occupied plan area at a coarse cell, then the grid's cell
	var g0 = 2 * Math.sqrt((x1 - x0) * (y1 - y0) / n), occ = new Set();
	for (i = 0; i < n; i++) occ.add(Math.floor((X[i] - x0) / g0) * 1e7 + Math.floor((Y[i] - y0) / g0));
	var spacing = Math.sqrt(occ.size * g0 * g0 / n), px = o.cell || 1.5 * spacing;
	var W = Math.floor((x1 - x0) / px) + 1, H = Math.floor((y1 - y0) / px) + 1, N = W * H;
	tick(1, STEPS);

	// the highest point of each cell
	var cellOf = new Int32Array(n), hgt = new Float32Array(N).fill(NaN), hit = new Uint8Array(N);   // hit: the cells holding points
	for (i = 0; i < n; i++) {
		k = Math.floor((Y[i] - y0) / px) * W + Math.floor((X[i] - x0) / px);
		cellOf[i] = k; hit[k] = 1;
		if (!(hgt[k] >= Z[i])) hgt[k] = Z[i];
	}
	var D8 = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1], DX = [-1, 0, 1, -1, 1, -1, 0, 1], mask = new Uint8Array(N);
	function inGrid(k, d) { var x2 = k % W + DX[d], q = k + D8[d]; return x2 >= 0 && x2 < W && q >= 0 && q < N; }
	// holes: up to 10 passes of the mean of at least 3 valid neighbours; what is left is outside
	for (var pass = 0; pass < 10; pass++) {
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
	function ok(k, d) { return inGrid(k, d) && mask[k + D8[d]]; }
	tick(2, STEPS);

	// smoothed (Gaussian, 1.5 cells), then relief above the box mean of radius R
	var fs = gauss(hgt, 1.5), mean = boxMean(fs, Math.max(1, Math.round(R / px))), relief = new Float32Array(N);
	for (k = 0; k < N; k++) relief[k] = mask[k] ? fs[k] - mean[k] : -Infinity;
	tick(3, STEPS);

	// seeds: connected cells where relief - reconstruct(relief - h) >= h (extended maxima)
	var J = new Float32Array(N);
	for (k = 0; k < N; k++) J[k] = mask[k] ? relief[k] - h : -Infinity;
	reconstruct(J, relief);
	var lab = new Int32Array(N), nl = 0, st = new Int32Array(N);
	for (k = 0; k < N; k++) {
		if (!mask[k] || lab[k] || relief[k] - J[k] < h - 1e-4) continue;
		nl++; var sp = 0; st[sp++] = k; lab[k] = nl;
		while (sp) {
			var p = st[--sp];
			for (d = 0; d < 8; d++) { if (!ok(p, d)) continue; var q = p + D8[d]; if (!lab[q] && relief[q] - J[q] >= h - 1e-4) { lab[q] = nl; st[sp++] = q; } }
		}
	}
	tick(4, STEPS);

	// flood down the relief from the seeds (Meyer): each cell takes the label of its lowest labelled neighbour
	var heap = new Heap(N), inq = new Uint8Array(N);
	for (k = 0; k < N; k++) if (lab[k]) for (d = 0; d < 8; d++) { if (!ok(k, d)) continue; q = k + D8[d]; if (!lab[q] && !inq[q]) { inq[q] = 1; heap.push(-relief[q], q); } }
	while (heap.n) {
		p = heap.pop(); var best = 0, bl = Infinity;
		for (d = 0; d < 8; d++) { if (!ok(p, d)) continue; q = p + D8[d]; if (lab[q] && -relief[q] < bl) { bl = -relief[q]; best = lab[q]; } }
		lab[p] = best;
		for (d = 0; d < 8; d++) { if (!ok(p, d)) continue; q = p + D8[d]; if (!lab[q] && !inq[q]) { inq[q] = 1; heap.push(-relief[q], q); } }
	}
	// the gaps and fines between rocks in no fragment (the areas count only cells holding points, so
	// the cells the hole fill adds round the cloud's edge, outside a selection, count for nothing): clip "relief" (default), cells under the mean
	// surface (minus clipBelow); "concave", cells where the surface curves up (Laplacian of the height
	// smoothed over curveSigma cells above curveMax per metre); "none"
	var clip = o.clip || "relief", cut = new Uint8Array(N);
	if (clip === "relief") { var below = o.clipBelow || 0; for (k = 0; k < N; k++) if (mask[k] && relief[k] < below) cut[k] = 1; }
	else if (clip === "concave") {
		var fc = gauss(hgt, o.curveSigma || 3), cmax = o.curveMax || 0;
		for (k = 0; k < N; k++) {
			if (!mask[k]) continue;
			var sum = 0, m4 = 0;
			for (d of [1, 3, 4, 6]) if (ok(k, d)) { sum += fc[k + D8[d]]; m4++; }
			if (m4 === 4 && (sum - 4 * fc[k]) / (px * px) > cmax) cut[k] = 1;
		}
	}
	if (o.labelsOut) { o.labelsOut.lab = Int32Array.from(lab); o.labelsOut.cut = cut; o.labelsOut.cellOf = cellOf; o.labelsOut.W = W; o.labelsOut.N = N; }   // for experiments
	var cells = 0, unassignedCells = 0;
	for (k = 0; k < N; k++) { if (!mask[k]) continue; if (cut[k]) lab[k] = 0; if (!hit[k]) continue; cells++; if (!lab[k]) unassignedCells++; }
	tick(5, STEPS);

	// fragments: the points of each label, minPoints and up; ids by size, largest first
	var count = new Uint32Array(nl + 1);
	for (i = 0; i < n; i++) count[lab[cellOf[i]]]++;
	var start = new Uint32Array(nl + 2);
	for (var l = 1; l <= nl; l++) start[l + 1] = start[l] + count[l];
	var members = new Uint32Array(start[nl + 1]), fillAt = Uint32Array.from(start);
	for (i = 0; i < n; i++) { l = lab[cellOf[i]]; if (l) members[fillAt[l]++] = i; }
	var frags = [], dropped = 0;
	for (l = 1; l <= nl; l++) {
		if (count[l] < minPoints) { if (count[l]) dropped += count[l]; continue; }
		var pts = members.subarray(start[l], start[l + 1]), ax = fragmentAxes(X, Y, Z, 1, pts), nv = ax.smallest;
		if (nv[2] < 0) nv = [-nv[0], -nv[1], -nv[2]];
		var shape = facetOutline(X, Y, Z, 1, pts, ax.centroid, nv, 2 * px);
		frags.push({ label: l, count: pts.length, centroid: ax.centroid, normal: nv, axes: ax.axes, size: ax.axes[1], area: shape.area, outline: shape.outline, facets: [] });
	}
	frags.sort(function (a, b) { return b.size - a.size || b.count - a.count || a.label - b.label; });
	var idOf = new Uint32Array(nl + 1);
	frags.forEach(function (f, j) { f.id = j + 1; idOf[f.label] = f.id; delete f.label; });
	var fragment = new Uint32Array(n);
	for (i = 0; i < n; i++) fragment[i] = idOf[lab[cellOf[i]]];
	tick(6, STEPS);
	var surfaceArea = cells * px * px, unassignedArea = unassignedCells * px * px + dropped / n * surfaceArea;
	tick(STEPS, STEPS);
	return { fragment: fragment, fragments: frags, surfaceArea: surfaceArea, unassignedArea: unassignedArea, facets: { facets: [] }, planeDistance: NaN, cell: px, spacing: spacing };

	// NaN-aware separable Gaussian
	function gauss(g, sigma) {
		var r = Math.ceil(3 * sigma), w = [], t, x, y, s, ws, v, tmp = new Float32Array(N), out = new Float32Array(N);
		for (t = -r; t <= r; t++) w.push(Math.exp(-t * t / (2 * sigma * sigma)));
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			s = 0; ws = 0;
			for (t = Math.max(-r, -x); t <= Math.min(r, W - 1 - x); t++) { v = g[y * W + x + t]; if (v === v) { s += w[t + r] * v; ws += w[t + r]; } }
			tmp[y * W + x] = ws ? s / ws : NaN;
		}
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			s = 0; ws = 0;
			for (t = Math.max(-r, -y); t <= Math.min(r, H - 1 - y); t++) { v = tmp[(y + t) * W + x]; if (v === v) { s += w[t + r] * v; ws += w[t + r]; } }
			out[y * W + x] = ws && mask[y * W + x] ? s / ws : NaN;
		}
		return out;
	}
	// box mean of radius rr cells (summed-area table), NaN-aware
	function boxMean(g, rr) {
		var S = new Float64Array((W + 1) * (H + 1)), C = new Float64Array((W + 1) * (H + 1)), out = new Float32Array(N), x, y;
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			var v = g[y * W + x], has = v === v, a = (y + 1) * (W + 1) + x + 1;
			S[a] = (has ? v : 0) + S[a - 1] + S[a - W - 1] - S[a - W - 2];
			C[a] = (has ? 1 : 0) + C[a - 1] + C[a - W - 1] - C[a - W - 2];
		}
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			var xa = Math.max(0, x - rr), xb = Math.min(W, x + rr + 1), ya = Math.max(0, y - rr), yb = Math.min(H, y + rr + 1);
			var p1 = yb * (W + 1) + xb, p2 = ya * (W + 1) + xb, p3 = yb * (W + 1) + xa, p4 = ya * (W + 1) + xa, c = C[p1] - C[p2] - C[p3] + C[p4];
			out[y * W + x] = c ? (S[p1] - S[p2] - S[p3] + S[p4]) / c : NaN;
		}
		return out;
	}
	// reconstruction by dilation of J under I, in place (Vincent's hybrid), 8-connected
	function reconstruct(J, I) {
		var x, y, k, d, q, m;
		for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
			k = y * W + x; if (!mask[k]) continue;
			m = J[k]; for (d = 0; d < 4; d++) if (ok(k, d) && J[k + D8[d]] > m) m = J[k + D8[d]];
			J[k] = Math.min(m, I[k]);
		}
		var queue = new Int32Array(N), head = 0, tail = 0, size = 0, queued = new Uint8Array(N);
		for (y = H - 1; y >= 0; y--) for (x = W - 1; x >= 0; x--) {
			k = y * W + x; if (!mask[k]) continue;
			m = J[k]; for (d = 4; d < 8; d++) if (ok(k, d) && J[k + D8[d]] > m) m = J[k + D8[d]];
			J[k] = Math.min(m, I[k]);
			for (d = 4; d < 8; d++) { if (!ok(k, d)) continue; q = k + D8[d]; if (J[q] < J[k] && J[q] < I[q]) { queued[k] = 1; queue[tail] = k; tail = (tail + 1) % N; size++; break; } }
		}
		while (size) {
			var p = queue[head]; head = (head + 1) % N; size--; queued[p] = 0;
			for (d = 0; d < 8; d++) {
				if (!ok(p, d)) continue; q = p + D8[d];
				if (J[q] < J[p] && I[q] !== J[q]) { J[q] = Math.min(J[p], I[q]); if (!queued[q]) { queued[q] = 1; queue[tail] = q; tail = (tail + 1) % N; size++; } }
			}
		}
	}
}

// a binary min-heap of cell numbers by a Float32 key
function Heap(cap) { this.k = new Float32Array(cap); this.v = new Int32Array(cap); this.n = 0; }
Heap.prototype.push = function (key, val) {
	var i = this.n++, K = this.k, V = this.v;
	while (i > 0) { var p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
	K[i] = key; V[i] = val;
};
Heap.prototype.pop = function () {
	var K = this.k, V = this.v, top = V[0], last = --this.n, key = K[last], val = V[last], i = 0;
	for (;;) { var l = 2 * i + 1; if (l >= last) break; var r = l + 1, m = r < last && K[r] < K[l] ? r : l; if (K[m] >= key) break; K[i] = K[m]; V[i] = V[m]; i = m; }
	K[i] = key; V[i] = val;
	return top;
};

/**
 * The hybrid: the watershed first, then findFragments on what it left in no fragment (the grey);
 * the rock-shaped fragments facets find there (c / b at least 0.15) become rocks too, and what is
 * left is fines. Scored on the ultra corner: fines 54 % to 21 %, the drawn rocks matched as well
 * as by the watershed alone. Ids by size, largest first, over both; each fragment's `from` says
 * which method found it.
 * @param {object} cols - as watershedFragments.
 * @param {object} wsOpts - watershedFragments' options (onProgress covers the whole run).
 * @param {object} facetOpts - findFragments' options for the rest.
 * @returns {object} watershedFragments' shape, plus facets (the rest's findFacets result), fromWatershed, fromFacets.
 */
export function watershedThenFacets(cols, wsOpts, facetOpts) {
	var tick = wsOpts.onProgress || function () {}, out = {}, n = cols.count, i, j;
	var w = watershedFragments(cols, Object.assign({}, wsOpts, { labelsOut: out, onProgress: function (d, t) { tick(0.15 * d / t, 1); } }));
	var rest = [];
	for (i = 0; i < n; i++) if (!w.fragment[i]) rest.push(i);
	if (rest.length < 9 || !out.cellOf) return Object.assign(w, { fromWatershed: w.fragments.length, fromFacets: 0 });
	var rc = { count: rest.length, x: new Float32Array(rest.length), y: new Float32Array(rest.length), z: new Float32Array(rest.length) };
	for (j = 0; j < rest.length; j++) { var p = rest[j]; rc.x[j] = cols.x[p]; rc.y[j] = cols.y[p]; rc.z[j] = cols.z[p]; }
	var fr = findFragments(rc, Object.assign({}, facetOpts, { onProgress: function (d, t) { tick(0.15 + 0.85 * d / t, 1); } }));
	var kept = fr.fragments.filter(function (f) { return f.axes[1] > 0 && f.axes[2] / f.axes[1] >= SHEET_CB; });
	var all = w.fragments.map(function (f) { return { f: f, ws: true }; }).concat(kept.map(function (f) { return { f: f, ws: false }; }));
	all.sort(function (a, b) { return b.f.size - a.f.size || b.f.count - a.f.count || (a.ws === b.ws ? a.f.id - b.f.id : a.ws ? -1 : 1); });
	var wsNew = new Uint32Array(w.fragments.length + 1), facNew = new Uint32Array(fr.fragments.length + 1), fragments = [];
	all.forEach(function (e, k) {
		var g = Object.assign({}, e.f, { id: k + 1, from: e.ws ? "watershed" : "facets" });
		fragments.push(g);
		if (e.ws) wsNew[e.f.id] = k + 1; else facNew[e.f.id] = k + 1;
	});
	var fragment = new Uint32Array(n);
	for (i = 0; i < n; i++) if (w.fragment[i]) fragment[i] = wsNew[w.fragment[i]];
	for (j = 0; j < rest.length; j++) if (fr.fragment[j]) fragment[rest[j]] = facNew[fr.fragment[j]];
	// plan areas: the cells holding points; fines, those whose points are all in no fragment
	var hit = new Uint8Array(out.N), held = new Uint8Array(out.N), cells = 0, none = 0;
	for (i = 0; i < n; i++) { var k = out.cellOf[i]; hit[k] = 1; if (fragment[i]) held[k] = 1; }
	for (k = 0; k < out.N; k++) if (hit[k]) { cells++; if (!held[k]) none++; }
	var a = w.cell * w.cell;
	tick(1, 1);
	return { fragment: fragment, fragments: fragments, surfaceArea: cells * a, unassignedArea: none * a, facets: fr.facets, planeDistance: fr.planeDistance,
		cell: w.cell, spacing: w.spacing, fromWatershed: w.fragments.length, fromFacets: kept.length };
}
