// test/helpers/clouds.js
//==========================================================
// Seeded random point clouds for the neighbour-index tests (so a
// failure reproduces), and a coordinate reader for either layout.
// Kinds, in a 100 m box from the origin:
//  - "uniform"   every point uniform in the box
//  - "clustered" 80 % in 5 tight Gaussian blobs (σ 1 m), 20 % uniform
//  - "plane"     uniform in x, y with z = 0
// Test-only.
//==========================================================

export function rng(seed) {
	var s = seed | 0;
	return function () {
		s = (s + 0x6D2B79F5) | 0;
		var t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function gauss(r) {
	var u = r() || 1e-12, v = r();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param {number} n
 * @param {{seed?: number, kind?: string, float32?: boolean, positions?: boolean}} [opts]
 * @returns {object} point columns: x / y / z, or a k = 3 positions column
 */
export function randomCloud(n, opts) {
	opts = opts || {};
	var r = rng(opts.seed || 1), kind = opts.kind || "uniform";
	var T = opts.float32 ? Float32Array : Float64Array;
	var xs = new T(n), ys = new T(n), zs = new T(n);
	var centres = [];
	for (var c = 0; c < 5; c++) centres.push([10 + r() * 80, 10 + r() * 80, 10 + r() * 80]);
	for (var i = 0; i < n; i++) {
		if (kind === "clustered" && r() < 0.8) {
			var cc = centres[Math.floor(r() * 5)];
			xs[i] = cc[0] + gauss(r); ys[i] = cc[1] + gauss(r); zs[i] = cc[2] + gauss(r);
		} else {
			xs[i] = r() * 100; ys[i] = r() * 100; zs[i] = kind === "plane" ? 0 : r() * 100;
		}
	}
	if (!opts.positions) return { count: n, x: xs, y: ys, z: zs };
	var pos = new T(3 * n);
	for (i = 0; i < n; i++) { pos[3 * i] = xs[i]; pos[3 * i + 1] = ys[i]; pos[3 * i + 2] = zs[i]; }
	return { count: n, positions: pos };
}

/**
 * Point i of either layout, as [x, y, z] Numbers.
 * @param {object} cols
 * @returns {function(number): number[]}
 */
export function pointReader(cols) {
	if (cols.positions) return function (i) { return [cols.positions[3 * i], cols.positions[3 * i + 1], cols.positions[3 * i + 2]]; };
	return function (i) { return [cols.x[i], cols.y[i], cols.z[i]]; };
}
