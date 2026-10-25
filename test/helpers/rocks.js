// test/helpers/rocks.js
//==========================================================
// A synthetic muckpile for the fragment tests: boxes (a >= b >= c),
// turned (yaw) and tilted (about their long axis), resting on a rough
// ground, sampled from above as a height field - each column of a grid
// at the given spacing takes its highest surface, so hidden faces drop
// out as they do in a scan. Boxes are given, or drawn: b from a known
// Swebrec, a = b x 1.2 ... 1.6, c = b x 0.5 ... 0.9, placed largest
// first at random, apart by about their long half-axes so some touch.
// A bevel cuts a box's top +a edge by a 45 degree plane that deep.
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
function ground(x, y) { return 0.02 * (Math.sin(7 * x) + Math.sin(5 * y)); }

function drawBoxes(r, o) {
	var sw = o.swebrec, E = o.extent, list = [], i;
	for (i = 0; i < o.count; i++) {
		var P = 0.05 + 0.945 * r(), b = sw.xmax / Math.exp(Math.log(sw.xmax / sw.x50) * Math.pow(1 / P - 1, 1 / sw.b));
		list.push({ size: [b * (1.2 + 0.4 * r()), b, b * (0.5 + 0.4 * r())], yaw: 360 * r(), tilt: 20 * r() });
	}
	list.sort(function (p, q) { return q.size[1] - p.size[1]; });
	var placed = [];
	list.forEach(function (bx) {
		var ra = bx.size[0] / 2;
		for (var t = 0; t < 200; t++) {
			var c = [ra + r() * (E - 2 * ra), ra + r() * (E - 2 * ra)];
			if (!(E > 2 * ra)) return;
			var ok = placed.every(function (p) { return Math.hypot(p.centre[0] - c[0], p.centre[1] - c[1]) >= 0.85 * (ra + p.size[0] / 2); });
			if (ok) { bx.centre = c; placed.push(bx); return; }
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
 *   noise?: number, stray?: number, seed?: number, float32?: boolean, origin?: number[]}} o
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
	var x = [], y = [], z = [], truth = [], cells = Math.round(E / s), groundPoints = 0, zmin = Infinity, zmax = -Infinity;
	for (var i = 0; i < cells; i++) {
		for (var j = 0; j < cells; j++) {
			var cx = (i + 0.5) * s, cy = (j + 0.5) * s, top = ground(cx, cy), id = 0;
			buckets[Math.floor(cx) * nb + Math.floor(cy)].forEach(function (k) {
				var t = topOf(frames[k], cx, cy);
				if (t > top) { top = t; id = k + 1; }
			});
			if (!id) groundPoints++;
			x.push(cx + noise * gauss(r)); y.push(cy + noise * gauss(r)); z.push(top + noise * gauss(r)); truth.push(id);
			if (top < zmin) zmin = top;
			if (top > zmax) zmax = top;
		}
	}
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
