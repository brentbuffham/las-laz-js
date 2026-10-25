// test/helpers/rocks.js
//==========================================================
// A synthetic muckpile for the fragment tests: boxes (a >= b >= c),
// turned (yaw) and tilted (about their long axis), resting on a rough
// ground. The ground is a grid of columns at the given spacing where no
// box covers it; each box face that faces up is sampled at the spacing
// over its area and kept where nothing lies above it, so hidden faces
// drop out as they do in a scan seen from above. Boxes are given, or drawn: b from a known
// Swebrec, a = b x 1.2 ... 1.6, c = b x 0.5 ... 0.9, placed largest
// first at random with a crack between neighbours of 3 spacings up to
// 0.3 b (a scan sees the crack; flush contacts are tested with given boxes).
// The ground is fines: random heights per point (below what a scan
// resolves), or pebbles 3 spacings across (fines: "pebbles"). A bevel cuts a box's top +a edge by a 45 degree plane that deep.
// truth holds each point's box (1 ...) or 0 for ground and stray
// points; visibleB is the axes measure (src/fragments/axes.js) of a
// box's own points, so a fragment is checked against what was seen.
// float32 + origin gives local Float32 columns about origin, as
// planesCloud. Test-only.
//==========================================================

import { rng } from "./clouds.js";
import { fragmentAxes } from "../../src/fragments/axes.js";

var D = Math.PI / 180, H = 100;

function gauss(r) { var u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
// fines below what a scan resolves: each point a random height up to NOISE_AMP spacings ("noise",
// the default); or pebbles: random heights on a lattice 3 spacings wide, up to PEBBLE_AMP spacings
// high, smoothly joined ("pebbles", bumps at the facets' own scale)
var NOISE_AMP = 1.5, PEBBLE_CELL = 3, PEBBLE_AMP = 4;
function hash(i, j) { var h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return h - Math.floor(h); }
function ground(x, y, s, kind, r) {
	if (kind !== "pebbles") return NOISE_AMP * s * r();
	var u = x / (PEBBLE_CELL * s), v = y / (PEBBLE_CELL * s), i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
	fu = fu * fu * (3 - 2 * fu); fv = fv * fv * (3 - 2 * fv);
	var a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
	return PEBBLE_AMP * s * (a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv);
}

// two boxes' plan footprints (rectangles a x b turned by yaw, grown by the tilt's lean) at least gap apart:
// a separating axis among the four edge directions with the projections that far apart
function apart(p, q, gap) {
	function rect(bx) {
		var y = bx.yaw * D, lean = bx.size[2] * Math.sin(Math.abs(bx.tilt) * D) / 2;
		return { c: bx.centre, u: [Math.cos(y), Math.sin(y)], v: [-Math.sin(y), Math.cos(y)], h: [bx.size[0] / 2 + lean, bx.size[1] / 2 + lean] };
	}
	var A = rect(p), B = rect(q), axes = [A.u, A.v, B.u, B.v];
	function reach(R, ax) { return R.h[0] * Math.abs(R.u[0] * ax[0] + R.u[1] * ax[1]) + R.h[1] * Math.abs(R.v[0] * ax[0] + R.v[1] * ax[1]); }
	return axes.some(function (ax) {
		var d = Math.abs((A.c[0] - B.c[0]) * ax[0] + (A.c[1] - B.c[1]) * ax[1]);
		return d - reach(A, ax) - reach(B, ax) >= gap;
	});
}

function drawBoxes(r, o) {
	var sw = o.swebrec, E = o.extent, list = [], i;
	for (i = 0; i < o.count; i++) {
		var P = 0.05 + 0.945 * r(), b = sw.xmax / Math.exp(Math.log(sw.xmax / sw.x50) * Math.pow(1 / P - 1, 1 / sw.b));
		list.push({ size: [b * (1.2 + 0.4 * r()), b, b * (0.5 + 0.4 * r())], yaw: 360 * r(), tilt: 20 * r() });
	}
	list.sort(function (p, q) { return q.size[1] - p.size[1]; });
	var placed = [], s = o.spacing;
	list.forEach(function (bx) {
		for (var t = 0; t < 200; t++) {
			var ra = bx.size[0] / 2;
			if (!(E > 2 * ra)) return;
			bx.centre = [ra + r() * (E - 2 * ra), ra + r() * (E - 2 * ra)];
			var ok = placed.every(function (p) { return apart(bx, p, Math.max(3 * s, 0.3 * r() * Math.min(bx.size[1], p.size[1]))); });
			if (ok) { placed.push(bx); return; }
		}
	});
	return placed;
}

// a box's frame: R = Rz(yaw) Rx(tilt), local u along a, v along b, w along c; resting at z = c / 2
function frame(bx) {
	var cy = Math.cos(bx.yaw * D), sy = Math.sin(bx.yaw * D), ct = Math.cos(bx.tilt * D), st = Math.sin(bx.tilt * D);
	var R = [[cy, -sy * ct, sy * st], [sy, cy * ct, -cy * st], [0, st, ct]];
	var h = [bx.size[0] / 2, bx.size[1] / 2, bx.size[2] / 2];
	// half-spaces n . local <= k
	var planes = [[[1, 0, 0], h[0]], [[-1, 0, 0], h[0]], [[0, 1, 0], h[1]], [[0, -1, 0], h[1]], [[0, 0, 1], h[2]], [[0, 0, -1], h[2]]];
	if (bx.bevel) planes.push([[1, 0, 1], h[0] + h[2] - bx.bevel]);
	return { R: R, C: [bx.centre[0], bx.centre[1], h[2]], planes: planes, reach: Math.hypot(h[0], h[1], h[2]) };
}

// the z where a vertical ray down through (x, y) enters the box, or -Infinity
function topOf(f, x, y) {
	var R = f.R, px = x - f.C[0], py = y - f.C[1], pz = H - f.C[2];
	var o = [R[0][0] * px + R[1][0] * py + R[2][0] * pz, R[0][1] * px + R[1][1] * py + R[2][1] * pz, R[0][2] * px + R[1][2] * py + R[2][2] * pz];
	var d = [-R[2][0], -R[2][1], -R[2][2]], tIn = -Infinity, tOut = Infinity;
	for (var i = 0; i < f.planes.length; i++) {
		var n = f.planes[i][0], k = f.planes[i][1];
		var nd = n[0] * d[0] + n[1] * d[1] + n[2] * d[2], no = n[0] * o[0] + n[1] * o[1] + n[2] * o[2];
		if (nd === 0) { if (no > k) return -Infinity; continue; }
		var t = (k - no) / nd;
		if (nd < 0) { if (t > tIn) tIn = t; } else if (t < tOut) tOut = t;
	}
	return tIn <= tOut ? H - tIn : -Infinity;
}

/**
 * @param {{boxes?: Array<{centre: number[], size: number[], yaw: number, tilt: number, bevel?: number}>,
 *   count?: number, swebrec?: {x50: number, xmax: number, b: number}, extent: number, spacing: number,
 *   noise?: number, stray?: number, seed?: number, float32?: boolean, origin?: number[], fines?: string}} o
 * @returns {{cols: object, truth: Uint32Array, boxes: Array<{id: number, size: number[], centre: number[],
 *   visibleB: number, points: number}>, groundArea: number}}
 */
export function rockPile(o) {
	var r = rng(o.seed || 1), s = o.spacing, E = o.extent, noise = o.noise || 0;
	var boxes = o.boxes ? o.boxes.map(function (b) { return Object.assign({}, b); }) : drawBoxes(r, o);
	var frames = boxes.map(frame);
	// boxes bucketed by 1 m columns of the plan, so each grid column tries only its neighbours
	var nb = Math.ceil(E) + 1, buckets = [];
	for (var q = 0; q < nb * nb; q++) buckets.push([]);
	frames.forEach(function (f, k) {
		for (var bx = Math.max(0, Math.floor(f.C[0] - f.reach)); bx <= Math.min(nb - 1, Math.floor(f.C[0] + f.reach)); bx++)
			for (var by = Math.max(0, Math.floor(f.C[1] - f.reach)); by <= Math.min(nb - 1, Math.floor(f.C[1] + f.reach)); by++) buckets[bx * nb + by].push(k);
	});
	function occluded(k, px, py, pz) {
		var bi = Math.floor(px) * nb + Math.floor(py), list = buckets[bi] || [];
		for (var m = 0; m < list.length; m++) if (list[m] !== k && topOf(frames[list[m]], px, py) > pz + 1e-6) return true;
		return false;
	}
	var x = [], y = [], z = [], truth = [], cells = Math.round(E / s), groundPoints = 0, zmin = Infinity, zmax = -Infinity;
	function push(px, py, pz, id) {
		x.push(px + noise * gauss(r)); y.push(py + noise * gauss(r)); z.push(pz + noise * gauss(r)); truth.push(id);
		if (pz < zmin) zmin = pz;
		if (pz > zmax) zmax = pz;
	}
	// the ground where no box covers it, a column per grid cell
	for (var i = 0; i < cells; i++) {
		for (var j = 0; j < cells; j++) {
			var cx = (i + 0.5) * s, cy = (j + 0.5) * s, top = ground(cx, cy, s, o.fines, r), covered = false;
			buckets[Math.floor(cx) * nb + Math.floor(cy)].forEach(function (k) { if (topOf(frames[k], cx, cy) > top) covered = true; });
			if (!covered) { groundPoints++; push(cx, cy, top, 0); }
		}
	}
	// each box's faces that face up, sampled at the spacing over their area (as photogrammetry or a
	// scanner sees steep faces), kept where nothing lies above them
	var groundTop = o.fines === "pebbles" ? PEBBLE_AMP * s : NOISE_AMP * s / 2;
	frames.forEach(function (f, k) {
		var R = f.R;
		f.planes.forEach(function (pl, pi) {
			var nl = Math.hypot(pl[0][0], pl[0][1], pl[0][2]), nn = [pl[0][0] / nl, pl[0][1] / nl, pl[0][2] / nl];
			if (R[2][0] * nn[0] + R[2][1] * nn[1] + R[2][2] * nn[2] <= 0.05) return;
			var e = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
			var u1 = [nn[1] * e[2] - nn[2] * e[1], nn[2] * e[0] - nn[0] * e[2], nn[0] * e[1] - nn[1] * e[0]], ul = Math.hypot(u1[0], u1[1], u1[2]);
			u1 = [u1[0] / ul, u1[1] / ul, u1[2] / ul];
			var u2 = [nn[1] * u1[2] - nn[2] * u1[1], nn[2] * u1[0] - nn[0] * u1[2], nn[0] * u1[1] - nn[1] * u1[0]];
			var d0 = pl[1] / nl, half = f.reach + s;
			for (var a = -half + s / 2; a < half; a += s) for (var c = -half + s / 2; c < half; c += s) {
				var L = [d0 * nn[0] + a * u1[0] + c * u2[0], d0 * nn[1] + a * u1[1] + c * u2[1], d0 * nn[2] + a * u1[2] + c * u2[2]];
				var inside = f.planes.every(function (q, qi) { return qi === pi || q[0][0] * L[0] + q[0][1] * L[1] + q[0][2] * L[2] <= q[1] + 1e-9; });
				if (!inside) continue;
				var px = f.C[0] + R[0][0] * L[0] + R[0][1] * L[1] + R[0][2] * L[2];
				var py = f.C[1] + R[1][0] * L[0] + R[1][1] * L[1] + R[1][2] * L[2];
				var pz = f.C[2] + R[2][0] * L[0] + R[2][1] * L[1] + R[2][2] * L[2];
				if (px < 0 || py < 0 || px >= E || py >= E || pz < groundTop || occluded(k, px, py, pz)) continue;
				push(px, py, pz, k + 1);
			}
		});
	});
	var nStray = Math.round((o.stray || 0) * x.length);
	for (q = 0; q < nStray; q++) { x.push(r() * E); y.push(r() * E); z.push(zmin + r() * (zmax + 1 - zmin)); truth.push(0); }

	var org = o.origin || [0, 0, 0], T = o.float32 ? Float32Array : Float64Array, n = x.length;
	var cols = { count: n, x: new T(n), y: new T(n), z: new T(n) };
	for (q = 0; q < n; q++) {
		cols.x[q] = (org[0] + x[q]) - org[0]; cols.y[q] = (org[1] + y[q]) - org[1]; cols.z[q] = (org[2] + z[q]) - org[2];
	}
	var tr = Uint32Array.from(truth), lists = boxes.map(function () { return []; });
	for (q = 0; q < n; q++) if (tr[q]) lists[tr[q] - 1].push(q);
	var seen = [];
	boxes.forEach(function (b, k) {
		if (!lists[k].length) return;
		var ax = fragmentAxes(cols.x, cols.y, cols.z, 1, Uint32Array.from(lists[k]));
		seen.push({ id: k + 1, size: b.size.slice(), centre: frames[k].C.slice(), visibleB: ax.axes[1], points: lists[k].length });
	});
	return { cols: cols, truth: tr, boxes: seen, groundArea: groundPoints * s * s };
}
