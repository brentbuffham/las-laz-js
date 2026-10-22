// src/index/query.js
//==========================================================
// Queries on a PointIndex (grid.js). The grid only prunes: every
// candidate is distance-checked in Float64 against the stored
// coordinates, "within" is inclusive (<=) and ties go to the lowest
// point number, so each answer equals a plain scan of the points.
// Cell ranges and cell distances are widened by a millionth of a
// cell so float rounding can never skip a cell holding an answer.
// When a query would visit more cells than the hash table has
// slots (a cell size far below the query's reach, or a query far
// outside the cloud), it walks the occupied slots instead.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { checkIndex, lookup as lookupCell } from "./grid.js";

var EPS = 1e-6;   // in cells

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

function fin(v) { return typeof v === "number" && isFinite(v); }

// [x, y, z] as Numbers; with xy, [x, y] or [x, y, anything]
function checkPoint(p, xy, name) {
	var ok = Array.isArray(p) && (p.length === 3 || (xy && p.length === 2)) && fin(p[0]) && fin(p[1]) && (xy || fin(p[2]));
	if (!ok) throw bad(name + " must be [x, y, z]" + (xy ? " or [x, y]" : "") + " of finite numbers");
	return [p[0], p[1], xy ? 0 : p[2]];
}

function checkPositive(v, name, optional) {
	if (optional && v === undefined) return;
	if (!(fin(v) && v > 0)) throw bad(name + " must be a positive finite number, not " + String(v));
}

function dims(index) { return [index.nx, index.ny, index.nz]; }

// Inclusive cell range on one axis covering [a, b], clamped; lo > hi when empty
function cellRange(index, axis, a, b) {
	var n = dims(index)[axis], inv = 1 / index.cellSize, m = index.min[axis];
	var lo = Math.floor((a - m) * inv - EPS), hi = Math.floor((b - m) * inv + EPS);
	return [Math.max(0, lo), Math.min(n - 1, hi)];
}

// Squared distance from q to the box of cell (ix, iy, iz), the box widened by EPS cells
function cellDist2(index, ix, iy, iz, q, xy) {
	var cs = index.cellSize, g = cs * EPS, m = index.min, c = [ix, iy, iz], s = 0;
	for (var a = 0; a < (xy ? 2 : 3); a++) {
		var lo = m[a] + c[a] * cs - g, hi = m[a] + (c[a] + 1) * cs + g;
		var d = lo - q[a] > 0 ? lo - q[a] : (q[a] - hi > 0 ? q[a] - hi : 0);
		s += d * d;
	}
	return s;
}

function decode(index, key) {
	var iz = key % index.nz, t = (key - iz) / index.nz, iy = t % index.ny;
	return [(t - iy) / index.ny, iy, iz];
}

/**
 * Call fn(slot, ix, iy, iz) for every occupied cell in an inclusive cell box.
 * Walks the table instead when the box has more cells than the table has slots.
 * @param {object} index - PointIndex.
 * @param {number[]} lo - [ix, iy, iz] low corner.
 * @param {number[]} hi - [ix, iy, iz] high corner.
 * @param {function} fn
 */
export function visitBox(index, lo, hi, fn) {
	if (lo[0] > hi[0] || lo[1] > hi[1] || lo[2] > hi[2]) return;
	var cells = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1), keys = index.keys;
	if (cells > keys.length) {
		for (var s = 0; s < keys.length; s++) {
			if (keys[s] < 0) continue;
			var c = decode(index, keys[s]);
			if (c[0] >= lo[0] && c[0] <= hi[0] && c[1] >= lo[1] && c[1] <= hi[1] && c[2] >= lo[2] && c[2] <= hi[2]) fn(s, c[0], c[1], c[2]);
		}
		return;
	}
	for (var ix = lo[0]; ix <= hi[0]; ix++) {
		for (var iy = lo[1]; iy <= hi[1]; iy++) {
			for (var iz = lo[2]; iz <= hi[2]; iz++) {
				var slot = lookupCell(index, ix, iy, iz);
				if (slot >= 0) fn(slot, ix, iy, iz);
			}
		}
	}
}

/**
 * Every point within `radius` of a point (inclusive), as a selection.
 * @param {object} index - PointIndex from buildIndex.
 * @param {number[]} point - [x, y, z]; with xy, [x, y] is enough.
 * @param {number} radius - > 0.
 * @param {{xy?: boolean}} [opts] - xy: measure in XY only.
 * @returns {Uint32Array} ascending point numbers
 */
export function pointsInRadius(index, point, radius, opts) {
	checkIndex(index, "pointsInRadius");
	var xy = !!(opts && opts.xy);
	var q = checkPoint(point, xy, "point");
	checkPositive(radius, "radius");
	if (index.count === 0) return new Uint32Array(0);
	var rx = cellRange(index, 0, q[0] - radius, q[0] + radius), ry = cellRange(index, 1, q[1] - radius, q[1] + radius);
	var rz = xy ? [0, index.nz - 1] : cellRange(index, 2, q[2] - radius, q[2] + radius);
	var r2 = radius * radius, co = index.coords, X = co.x, Y = co.y, Z = co.z, st = co.stride, order = index.order;
	var hits = [];
	visitBox(index, [rx[0], ry[0], rz[0]], [rx[1], ry[1], rz[1]], function (s, ix, iy, iz) {
		if (cellDist2(index, ix, iy, iz, q, xy) > r2) return;
		for (var j = index.start[s], e = j + index.length[s]; j < e; j++) {
			var p = order[j], o = p * st;
			var dx = X[o] - q[0], dy = Y[o] - q[1], dz = xy ? 0 : Z[o] - q[2];
			if (dx * dx + dy * dy + dz * dz <= r2) hits.push(p);
		}
	});
	return Uint32Array.from(hits).sort();
}

/**
 * The nearest point (lowest number on a tie), or -1 when none is within maxDistance.
 * @param {object} index - PointIndex from buildIndex.
 * @param {number[]} point - [x, y, z]; with xy, [x, y] is enough.
 * @param {{maxDistance?: number, xy?: boolean}} [opts] - maxDistance omitted: unlimited.
 * @returns {number}
 */
export function nearestPoint(index, point, opts) {
	checkIndex(index, "nearestPoint");
	var xy = !!(opts && opts.xy);
	var q = checkPoint(point, xy, "point");
	var maxD = opts ? opts.maxDistance : undefined;
	checkPositive(maxD, "maxDistance", true);
	if (index.count === 0) return -1;
	var maxD2 = maxD === undefined ? Infinity : maxD * maxD;
	var n = dims(index), cs = index.cellSize, inv = 1 / cs, m = index.min, axes = xy ? 2 : 3;
	var c = [0, 0, 0];
	for (var a = 0; a < axes; a++) c[a] = Math.min(n[a] - 1, Math.max(0, Math.floor((q[a] - m[a]) * inv)));
	var co = index.coords, X = co.x, Y = co.y, Z = co.z, st = co.stride, order = index.order;
	var best = -1, bd = Infinity, visited = 0, budget = index.keys.length;
	// How far the query lies outside the grid on each axis (0 inside)
	var out = [0, 0, 0];
	for (a = 0; a < axes; a++) {
		var gl = m[a], gh = m[a] + n[a] * cs;
		out[a] = Math.max(0, (q[a] < gl ? gl - q[a] : q[a] > gh ? q[a] - gh : 0) - cs * EPS);
	}

	function cell(ix, iy, iz) {
		visited++;
		var s = lookupCell(index, ix, iy, iz);
		if (s < 0 || cellDist2(index, ix, iy, iz, q, xy) > Math.min(bd, maxD2)) return;
		for (var j = index.start[s], e = j + index.length[s]; j < e; j++) {
			var p = order[j], o = p * st;
			var dx = X[o] - q[0], dy = Y[o] - q[1], dz = xy ? 0 : Z[o] - q[2];
			var d = dx * dx + dy * dy + dz * dz;
			if (d <= maxD2 && (d < bd || (d === bd && p < best))) { bd = d; best = p; }
		}
	}
	// Every grid cell at Chebyshev distance r (in the axes used) from c
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
			// interior columns: only the two z faces
			for (iy = Math.max(y0, c[1] - r + 1); iy <= Math.min(y1, c[1] + r - 1); iy++) {
				if (c[2] - r >= 0) cell(ix, iy, c[2] - r);
				if (c[2] + r < n[2]) cell(ix, iy, c[2] + r);
			}
		}
	}

	function gap(g) { g = Math.max(0, g - cs * EPS); return g * g; }

	for (var r = 0; ; r++) {
		ring(r);
		if (visited > budget) return nearestByScan(index, q, xy, maxD2, best, bd);
		// Unvisited points lie beyond a face of the cells c - r .. c + r on some axis a, and
		// inside the grid on the others: a lower bound on their squared distance
		var bound2 = Infinity;
		for (a = 0; a < axes; a++) {
			var rest = 0;
			for (var b = 0; b < axes; b++) if (b !== a) rest += out[b] * out[b];
			if (c[a] - r > 0) bound2 = Math.min(bound2, gap(q[a] - (m[a] + (c[a] - r) * cs)) + rest);
			if (c[a] + r < n[a] - 1) bound2 = Math.min(bound2, gap(m[a] + (c[a] + r + 1) * cs - q[a]) + rest);
		}
		if (bound2 === Infinity) break;
		if (best >= 0 && bd < bound2) break;
		if (bound2 > maxD2) break;
	}
	return best;
}

// The occupied cells in order of distance, for queries a ring search would make slow
function nearestByScan(index, q, xy, maxD2, best, bd) {
	var keys = index.keys, cand = [];
	for (var s = 0; s < keys.length; s++) {
		if (keys[s] < 0) continue;
		var c = decode(index, keys[s]), cd = cellDist2(index, c[0], c[1], c[2], q, xy);
		if (cd <= maxD2 && cd <= bd) cand.push([cd, s]);
	}
	cand.sort(function (u, v) { return u[0] - v[0]; });
	var co = index.coords, X = co.x, Y = co.y, Z = co.z, st = co.stride, order = index.order;
	for (var i = 0; i < cand.length; i++) {
		if (cand[i][0] > bd) break;
		s = cand[i][1];
		for (var j = index.start[s], e = j + index.length[s]; j < e; j++) {
			var p = order[j], o = p * st;
			var dx = X[o] - q[0], dy = Y[o] - q[1], dz = xy ? 0 : Z[o] - q[2];
			var d = dx * dx + dy * dy + dz * dz;
			if (d <= maxD2 && (d < bd || (d === bd && p < best))) { bd = d; best = p; }
		}
	}
	return best;
}

/**
 * Every point near a ray: within radius + growth · t of its axis, where t >= 0 is the
 * point's distance along it (growth 0: a cylinder, as an orthographic view's pick ray;
 * growth > 0: a cone, as a perspective camera's, growth = tan of the half-angle).
 * The snap rules (front-most, priorities) are the caller's: pick from t and d.
 * @param {object} index - PointIndex from buildIndex.
 * @param {number[]} origin - [x, y, z].
 * @param {number[]} direction - [x, y, z], any length > 0.
 * @param {{radius: number, growth?: number, maxT?: number}} opts - maxT omitted: unlimited.
 * @returns {{points: Uint32Array, t: Float64Array, d: Float64Array}} points ascending; t, d parallel
 */
export function pointsNearRay(index, origin, direction, opts) {
	checkIndex(index, "pointsNearRay");
	var o = checkPoint(origin, false, "origin");
	var dir = checkPoint(direction, false, "direction");
	var len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
	if (!(len > 0 && isFinite(len))) throw bad("direction must not be zero");
	var u = [dir[0] / len, dir[1] / len, dir[2] / len];
	opts = opts || {};
	checkPositive(opts.radius, "radius");
	var growth = opts.growth === undefined ? 0 : opts.growth;
	if (!(fin(growth) && growth >= 0)) throw bad("growth must be a finite number >= 0, not " + String(growth));
	checkPositive(opts.maxT, "maxT", true);
	var radius = opts.radius, maxT = opts.maxT;
	var points = [], ts = [], ds = [];
	var co = index.coords, X = co.x, Y = co.y, Z = co.z, st = co.stride, order = index.order;

	function check(s) {
		for (var j = index.start[s], e = j + index.length[s]; j < e; j++) {
			var p = order[j], q = p * st;
			var vx = X[q] - o[0], vy = Y[q] - o[1], vz = Z[q] - o[2];
			var t = vx * u[0] + vy * u[1] + vz * u[2];
			if (t < 0 || (maxT !== undefined && t > maxT)) continue;
			var cx = vy * u[2] - vz * u[1], cy = vz * u[0] - vx * u[2], cz = vx * u[1] - vy * u[0];
			var d = Math.sqrt(cx * cx + cy * cy + cz * cz);
			if (d <= radius + growth * t) { points.push(p); ts.push(t); ds.push(d); }
		}
	}

	if (index.count > 0) walk();
	var idx = points.map(function (_, i) { return i; }).sort(function (a, b) { return points[a] - points[b]; });
	return {
		points: Uint32Array.from(idx, function (i) { return points[i]; }),
		t: Float64Array.from(idx, function (i) { return ts[i]; }),
		d: Float64Array.from(idx, function (i) { return ds[i]; })
	};

	function walk() {
		var cs = index.cellSize, m = index.min, n = dims(index);
		var lo = [m[0], m[1], m[2]], hi = [m[0] + n[0] * cs, m[1] + n[1] * cs, m[2] + n[2] * cs];
		// No point has a t beyond the far side of the grid's bounding sphere
		var half = 0, dc = 0;
		for (var a = 0; a < 3; a++) { var e = (hi[a] - lo[a]) / 2, w = (lo[a] + hi[a]) / 2 - o[a]; half += e * e; dc += w * w; }
		var T = Math.sqrt(dc) + Math.sqrt(half);
		if (maxT !== undefined && maxT < T) T = maxT;
		var R = radius + growth * T + cs * EPS;
		// Clip [0, T] to where the ray is within R of the grid's box (slab method)
		var t0 = 0, t1 = T;
		for (a = 0; a < 3; a++) {
			if (u[a] === 0) {
				if (o[a] < lo[a] - R || o[a] > hi[a] + R) return;
				continue;
			}
			var ta = (lo[a] - R - o[a]) / u[a], tb = (hi[a] + R - o[a]) / u[a];
			if (ta > tb) { var sw = ta; ta = tb; tb = sw; }
			if (ta > t0) t0 = ta;
			if (tb < t1) t1 = tb;
		}
		if (t0 > t1) return;
		// Many more cells along the way than occupied cells: test each occupied cell once
		var across = 2 * R / cs + 1;
		if (((t1 - t0) / cs + 1) * across * across > index.keys.length) return scanCells();
		var seen = new Set();
		for (var t = t0; t <= t1; t += cs) {
			var t2 = Math.min(t + cs, t1), rr = radius + growth * t2;
			var bl = [0, 0, 0], bh = [0, 0, 0];
			for (a = 0; a < 3; a++) {
				var pa = o[a] + t * u[a], pb = o[a] + t2 * u[a];
				var r = cellRange(index, a, Math.min(pa, pb) - rr, Math.max(pa, pb) + rr);
				bl[a] = r[0]; bh[a] = r[1];
			}
			visitBox(index, bl, bh, function (s) {
				if (seen.has(s)) return;
				seen.add(s);
				check(s);
			});
			if (t2 >= t1) break;
		}
	}

	// A cell can hold an answer only if its centre is near enough: every point is
	// within hd of the centre, so its t and d differ from the centre's by at most hd
	function scanCells() {
		var cs = index.cellSize, m = index.min, keys = index.keys, hd = cs * Math.sqrt(3) / 2 + cs * EPS;
		for (var s = 0; s < keys.length; s++) {
			if (keys[s] < 0) continue;
			var c = decode(index, keys[s]);
			var vx = m[0] + (c[0] + 0.5) * cs - o[0], vy = m[1] + (c[1] + 0.5) * cs - o[1], vz = m[2] + (c[2] + 0.5) * cs - o[2];
			var tc = vx * u[0] + vy * u[1] + vz * u[2];
			if (tc + hd < 0 || (maxT !== undefined && tc - hd > maxT)) continue;
			var cx = vy * u[2] - vz * u[1], cy = vz * u[0] - vx * u[2], cz = vx * u[1] - vy * u[0];
			if (Math.sqrt(cx * cx + cy * cy + cz * cz) - hd > radius + growth * Math.max(0, tc + hd)) continue;
			check(s);
		}
	}
}

export { checkPoint, checkPositive, cellRange, cellDist2, decode };
