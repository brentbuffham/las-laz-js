// src/facets/orientation.js
//==========================================================
// Plane orientation in Kirra's convention, and Fisher statistics of a
// set of poles. A plane's pole is its unit normal oriented up (z > 0;
// a vertical one by orientNormal: x > 0, then y > 0). dip = acos(n_z)
// in degrees, 0-90 (90 vertical); dip direction = the bearing of the
// pole's horizontal part, degrees clockwise from north (+Y), east (+X)
// = 90; 0 when dip is 0. Coordinates are x east, y north, z up. Poles
// are axial in the statistics: a pole and its opposite are one.
//==========================================================

import { orientNormal } from "../ops/normals.js";

var D = Math.PI / 180;

/**
 * A plane's pole: the unit normal oriented up (a vertical one: x > 0, then y > 0).
 * @param {ArrayLike<number>} normal - any non-zero length.
 * @returns {number[]} [x, y, z]
 */
export function poleOf(normal) {
	var l = Math.hypot(normal[0], normal[1], normal[2]);
	var p = [normal[0] / l, normal[1] / l, normal[2] / l];
	orientNormal(p);
	return p;
}

/**
 * Dip and dip direction (degrees) of the plane with this normal (either sign).
 * @param {ArrayLike<number>} normal
 * @returns {{dip: number, dipDirection: number}} dip 0-90; dipDirection in [0, 360), 0 when dip is 0
 */
export function orientationOf(normal) {
	var p = poleOf(normal);
	var dip = Math.acos(Math.min(1, p[2])) / D;
	if (!(dip > 0)) return { dip: 0, dipDirection: 0 };
	var dd = (Math.atan2(p[0], p[1]) / D + 360) % 360;
	return { dip: dip, dipDirection: dd + 0 };
}

/**
 * The pole of the plane with this dip and dip direction (degrees).
 * @param {number} dip
 * @param {number} dipDirection
 * @returns {number[]} [x, y, z], unit, z >= 0
 */
export function poleFromOrientation(dip, dipDirection) {
	var d = dip * D, a = dipDirection * D;
	return [Math.sin(d) * Math.sin(a) + 0, Math.sin(d) * Math.cos(a) + 0, Math.cos(d) + 0];
}

/**
 * The angle between two axes in degrees, 0-90 (a vector and its opposite are one axis).
 * Internal; not exported from the package entry.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function angleBetweenAxes(a, b) {
	var c = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]));
	return Math.acos(Math.min(1, c)) / D;
}

/**
 * Fisher statistics of axial poles: each pole flipped into the mean's hemisphere, weights scaled
 * so they sum to N (the pole count). Internal; not exported from the package entry.
 * @param {Float64Array} poles - x, y, z per pole (unit).
 * @param {Float64Array|null} weights - one per pole (e.g. facet areas), or null for equal.
 * @returns {{normal: number[], fisherK: number, cone95: number, N: number, R: number}} normal: the
 *   mean pole (oriented up); fisherK = (N - 1) / (N - R); cone95 in degrees; both NaN for N < 2
 */
export function fisherStats(poles, weights) {
	var N = poles.length / 3, scale = 1, i;
	if (weights) {
		var sw = 0;
		for (i = 0; i < N; i++) sw += weights[i];
		scale = N / sw;
	}
	// two passes: the first pole sets the hemisphere, then the mean so found
	var rx = poles[0], ry = poles[1], rz = poles[2], sx = 0, sy = 0, sz = 0;
	for (var pass = 0; pass < 2; pass++) {
		sx = 0; sy = 0; sz = 0;
		for (i = 0; i < N; i++) {
			var x = poles[3 * i], y = poles[3 * i + 1], z = poles[3 * i + 2], w = weights ? weights[i] * scale : 1;
			var s = x * rx + y * ry + z * rz < 0 ? -w : w;
			sx += s * x; sy += s * y; sz += s * z;
		}
		rx = sx; ry = sy; rz = sz;
	}
	var R = Math.hypot(sx, sy, sz);
	var spread = Math.max(0, N - R);   // rounding can put R a hair above N for identical poles
	var K = N < 2 ? NaN : (N - 1) / spread;   // Infinity for identical poles
	var cone = N < 2 ? NaN : Math.acos(Math.max(-1, Math.min(1, 1 - spread / R * (Math.pow(20, 1 / (N - 1)) - 1)))) / D;
	return { normal: poleOf([sx, sy, sz]), fisherK: K, cone95: cone, N: N, R: R };
}
