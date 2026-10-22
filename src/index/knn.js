// src/index/knn.js
//==========================================================
// The k nearest points on a PointIndex (grid.js): Chebyshev rings of
// cells outward from the query's cell, as nearestPoint searches, with
// the best k kept in a bounded max-heap ordered by (distance², point
// number), so ties go to the lowest number. Distances are checked in
// Float64 against the stored coordinates, so results are exact.
// Also the "working index" the denoise tools build: its cell size is
// the median distance to the k-th neighbour, so a 3 × 3 × 3 block of
// cells holds about k points on a surface (the automatic 0.6.0 size
// aims at 16 points per cell of the bounding volume, coarse on a
// surface). And the argument checks and progress ticker they share.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { buildGrid, coordsOf, checkPointCount, checkIndex, lookup } from "./grid.js";
import { checkPoint, checkPositive, cellDist2, decode } from "./query.js";
import { thinSelection } from "../ops/select.js";

var EPS = 1e-6;   // in cells, as query.js
var MAX_CELLS = 4503599627370496;   // 2^52: the working index stays well inside buildGrid's 2^53

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/**
 * Refuse a k that is not a whole number >= 1.
 * @param {*} v
 * @param {string} name
 */
export function checkK(v, name) {
	if (!(Number.isInteger(v) && v >= 1)) throw bad(name + " must be a whole number >= 1, not " + String(v));
}

/**
 * Refuse a missing or non-positive maxDistance.
 * @param {*} v
 */
export function checkMaxDistance(v) {
	if (v === undefined) throw bad("maxDistance is required: a positive distance in the columns' units (e.g. 0.3 m for a handheld scan)");
	checkPositive(v, "maxDistance");
}

/**
 * A ticker that calls onProgress(done, total) about every 1 % of total, and at total.
 * @param {function|undefined} onProgress
 * @param {number} total
 * @returns {function(number)}
 */
export function progress(onProgress, total) {
	if (onProgress === undefined) return function () {};
	if (typeof onProgress !== "function") throw bad("onProgress must be a function");
	var step = Math.max(1, Math.floor(total / 100)), last = 0;
	return function (done) {
		if (done === total || done - last >= step) { last = done; onProgress(done, total); }
	};
}

/**
 * The k nearest points to (qx, qy, qz), nearest first by (distance², point number).
 * Fills outP / outD2 (squared distances) and returns how many it found (<= k).
 * @param {object} index - PointIndex.
 * @param {number} qx
 * @param {number} qy
 * @param {number} qz - ignored with xy.
 * @param {number} k - >= 1; outP and outD2 hold at least k.
 * @param {number} maxD2 - squared distance limit (Infinity: none).
 * @param {number} skip - a point number to leave out (-1: none).
 * @param {Uint32Array} outP
 * @param {Float64Array} outD2
 * @param {boolean} [xy] - measure in XY only.
 * @returns {number}
 */
export function knnSearch(index, qx, qy, qz, k, maxD2, skip, outP, outD2, xy) {
	var m = 0;
	if (index.count === 0) return 0;
	var q = [qx, qy, xy ? 0 : qz];
	var n = [index.nx, index.ny, index.nz], cs = index.cellSize, inv = 1 / cs, mn = index.min, axes = xy ? 2 : 3;
	var c = [0, 0, 0], a;
	for (a = 0; a < axes; a++) c[a] = Math.min(n[a] - 1, Math.max(0, Math.floor((q[a] - mn[a]) * inv)));
	var co = index.coords, X = co.x, Y = co.y, Z = co.z, st = co.stride, order = index.order;
	var P = outP, D = outD2, visited = 0, budget = index.keys.length;
	var out = [0, 0, 0];
	for (a = 0; a < axes; a++) {
		var gl = mn[a], gh = mn[a] + n[a] * cs;
		out[a] = Math.max(0, (q[a] < gl ? gl - q[a] : q[a] > gh ? q[a] - gh : 0) - cs * EPS);
	}

	// Max-heap on (D, P): the root is the worst of the best m
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
		if (m < k) {
			P[m] = p; D[m] = d;
			for (var i = m++; i > 0;) { var up = (i - 1) >> 1; if (!worse(i, up)) break; swap(i, up); i = up; }
		} else if (d < D[0] || (d === D[0] && p < P[0])) {
			P[0] = p; D[0] = d; down(0, m);
		}
	}
	function limit() { return m === k ? Math.min(D[0], maxD2) : maxD2; }
	function scanSlot(s) {
		for (var j = index.start[s], e = j + index.length[s]; j < e; j++) {
			var p = order[j];
			if (p === skip) continue;
			var o = p * st;
			var dx = X[o] - q[0], dy = Y[o] - q[1], dz = xy ? 0 : Z[o] - q[2];
			var d = dx * dx + dy * dy + dz * dz;
			if (d <= maxD2) offer(p, d);
		}
	}
	function cell(ix, iy, iz) {
		visited++;
		var s = lookup(index, ix, iy, iz);
		if (s < 0 || cellDist2(index, ix, iy, iz, q, xy) > limit()) return;
		scanSlot(s);
	}
	function ring(r) {
		var x0 = Math.max(0, c[0] - r), x1 = Math.min(n[0] - 1, c[0] + r);
		var y0 = Math.max(0, c[1] - r), y1 = Math.min(n[1] - 1, c[1] + r);
		var z0 = xy ? 0 : Math.max(0, c[2] - r), z1 = xy ? n[2] - 1 : Math.min(n[2] - 1, c[2] + r);
		function column(ix, iy) { for (var iz = z0; iz <= z1; iz++) cell(ix, iy, iz); }
		for (var ix = x0; ix <= x1; ix++) {
			if (ix === c[0] - r || ix === c[0] + r) {
				for (var iy = y0; iy <= y1; iy++) column(ix, iy);
				continue;
			}
			if (c[1] - r >= 0) column(ix, c[1] - r);
			if (c[1] + r < n[1]) column(ix, c[1] + r);
			if (xy) continue;
			for (iy = Math.max(y0, c[1] - r + 1); iy <= Math.min(y1, c[1] + r - 1); iy++) {
				if (c[2] - r >= 0) cell(ix, iy, c[2] - r);
				if (c[2] + r < n[2]) cell(ix, iy, c[2] + r);
			}
		}
	}
	function gap(g) { g = Math.max(0, g - cs * EPS); return g * g; }
	// The occupied cells in order of distance, from scratch, for queries rings would make slow
	function byScan() {
		m = 0;
		var keys = index.keys, cand = [];
		for (var s = 0; s < keys.length; s++) {
			if (keys[s] < 0) continue;
			var cc = decode(index, keys[s]), cd = cellDist2(index, cc[0], cc[1], cc[2], q, xy);
			if (cd <= maxD2) cand.push([cd, s]);
		}
		cand.sort(function (u, v) { return u[0] - v[0]; });
		for (var i = 0; i < cand.length; i++) {
			if (cand[i][0] > limit()) break;
			scanSlot(cand[i][1]);
		}
	}

	for (var r = 0; ; r++) {
		ring(r);
		if (visited > budget) { byScan(); break; }
		// A lower bound on the squared distance of every point not yet visited
		var bound2 = Infinity;
		for (a = 0; a < axes; a++) {
			var rest = 0;
			for (var b = 0; b < axes; b++) if (b !== a) rest += out[b] * out[b];
			if (c[a] - r > 0) bound2 = Math.min(bound2, gap(q[a] - (mn[a] + (c[a] - r) * cs)) + rest);
			if (c[a] + r < n[a] - 1) bound2 = Math.min(bound2, gap(mn[a] + (c[a] + r + 1) * cs - q[a]) + rest);
		}
		if (bound2 === Infinity) break;
		if (m === k && D[0] < bound2) break;
		if (bound2 > maxD2) break;
	}
	// Heap sort: ascending by (D, P)
	for (var end = m - 1; end > 0; end--) { swap(0, end); down(0, end); }
	return m;
}

/**
 * The k nearest points to a point, nearest first (lowest number on a tie).
 * @param {object} index - PointIndex from buildIndex.
 * @param {number[]} point - [x, y, z]; with xy, [x, y] is enough.
 * @param {number} k - how many, a whole number >= 1.
 * @param {{maxDistance?: number, xy?: boolean}} [opts] - maxDistance omitted: unlimited.
 * @returns {{points: Uint32Array, d: Float64Array}} point numbers and their distances
 */
export function nearestPoints(index, point, k, opts) {
	checkIndex(index, "nearestPoints");
	var xy = !!(opts && opts.xy);
	var q = checkPoint(point, xy, "point");
	checkK(k, "k");
	var maxD = opts ? opts.maxDistance : undefined;
	checkPositive(maxD, "maxDistance", true);
	var kk = Math.min(k, index.count), P = new Uint32Array(kk), D = new Float64Array(kk);
	var m = kk === 0 ? 0 : knnSearch(index, q[0], q[1], q[2], kk, maxD === undefined ? Infinity : maxD * maxD, -1, P, D, xy);
	for (var i = 0; i < m; i++) D[i] = Math.sqrt(D[i]);
	return { points: m === kk ? P : P.slice(0, m), d: m === kk ? D : D.slice(0, m) };
}

/**
 * An index over point columns for k-nearest work: cell size the median distance to the
 * k-th other point over up to 1,000 points spread through the cloud (at most maxDistance),
 * so a 3 × 3 × 3 block of cells holds about k points on a surface.
 * @param {object} cols - point columns (x, y, z or a k = 3 positions column).
 * @param {string} fn - the calling function's name, for messages.
 * @param {number} k
 * @param {number} [maxDistance]
 * @returns {object} PointIndex
 */
export function workingIndex(cols, fn, k, maxDistance) {
	var coords = coordsOf(cols, fn), n = cols.count;
	checkPointCount(n);
	var coarse = buildGrid(coords, n, undefined, false);
	var sample = thinSelection(n, 1000), P = new Uint32Array(k), D = new Float64Array(k);
	var maxD2 = maxDistance === undefined ? Infinity : maxDistance * maxDistance;
	var X = coords.x, Y = coords.y, Z = coords.z, st = coords.stride, dist = [];
	for (var i = 0; i < sample.length; i++) {
		var p = sample[i], o = p * st, m = knnSearch(coarse, X[o], Y[o], Z[o], k, maxD2, p, P, D);
		if (m === k) dist.push(Math.sqrt(D[k - 1]));
		else if (maxDistance !== undefined) dist.push(maxDistance);   // the k-th lies beyond the reach
		else if (m > 0) dist.push(Math.sqrt(D[m - 1]));
	}
	dist.sort(function (u, v) { return u - v; });
	var cellSize = dist.length ? dist[(dist.length - 1) >> 1] : 0;
	if (maxDistance !== undefined && cellSize > maxDistance) cellSize = maxDistance;
	if (!(cellSize > 0)) return coarse;
	// Keep the cell count inside 2^52 (a dense patch at one end of a long span)
	var ext = [coarse.nx * coarse.cellSize, coarse.ny * coarse.cellSize, coarse.nz * coarse.cellSize];
	function cells(s) { return (Math.floor(ext[0] / s) + 1) * (Math.floor(ext[1] / s) + 1) * (Math.floor(ext[2] / s) + 1); }
	while (cells(cellSize) > MAX_CELLS) cellSize *= 1.5;
	if (cellSize === coarse.cellSize) return coarse;
	return buildGrid(coords, n, cellSize, false);
}
