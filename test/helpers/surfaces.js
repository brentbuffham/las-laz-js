// test/helpers/surfaces.js
//==========================================================
// Synthetic pit surfaces with a known true shape, for the smoothing
// tests: points about 0.05 apart, seeded Gaussian noise along the
// true normal, and error(i) — point i's distance to the true surface.
//  - "plane"  z = 0 over side × side metres (default 6)
//  - "crest"  a bench edge: the floor z = 0 for x ≤ 0 and the face
//             x = 0 for z < 0, each 3 m deep and 6 m long (in y)
//  - "cone"   z = 3 − r for r ≤ 3 (a 45° pile, apex at z = 3)
// Test-only.
//==========================================================

import { rng } from "./clouds.js";

function gauss(r) { var u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/**
 * @param {string} kind - "plane", "crest" or "cone".
 * @param {{noise?: number, seed?: number, offset?: number[], side?: number, step?: number}} [opts] - noise 0.02, step 0.05.
 * @returns {{cols: object, error: function(number, object): number}} error(i, cols): point i of cols to the true surface
 */
export function surface(kind, opts) {
	opts = opts || {};
	var noise = opts.noise === undefined ? 0.02 : opts.noise, step = opts.step || 0.05, r = rng(opts.seed || 1);
	var off = opts.offset || [0, 0, 0], side = opts.side || 6, px = [], py = [], pz = [];
	function add(x, y, z, nx, ny, nz) {
		var h = noise * gauss(r);
		px.push(x + h * nx); py.push(y + h * ny); pz.push(z + h * nz);
	}
	var i, j, m = Math.round(side / step);
	if (kind === "plane") {
		for (j = 0; j < m; j++) for (i = 0; i < m; i++) add(i * step, j * step, 0, 0, 0, 1);
	} else if (kind === "crest") {
		var d = Math.round(3 / step);
		for (j = 0; j < m; j++) {
			for (i = 0; i <= d; i++) add(-i * step, j * step, 0, 0, 0, 1);
			for (i = 1; i <= d; i++) add(0, j * step, -i * step, 1, 0, 0);
		}
	} else if (kind === "cone") {
		var s = Math.round(3 / step), q = Math.SQRT1_2;
		for (j = -s; j <= s; j++) {
			for (i = -s; i <= s; i++) {
				var x = i * step, y = j * step, rr = Math.hypot(x, y);
				if (rr > 3) continue;
				if (rr === 0) { add(0, 0, 3, 0, 0, 1); continue; }
				add(x, y, 3 - rr, q * x / rr, q * y / rr, q);
			}
		}
	} else throw new Error("unknown surface " + kind);
	var n = px.length, cols = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (i = 0; i < n; i++) { cols.x[i] = px[i] + off[0]; cols.y[i] = py[i] + off[1]; cols.z[i] = pz[i] + off[2]; }

	function error(k, c) {
		var x = c.x[k] - off[0], y = c.y[k] - off[1], z = c.z[k] - off[2];
		if (kind === "plane") return Math.abs(z);
		if (kind === "crest") {
			var a = x <= 0 ? Math.abs(z) : Math.hypot(x, z);
			var b = z <= 0 ? Math.abs(x) : Math.hypot(x, z);
			return Math.min(a, b);
		}
		var rr = Math.hypot(x, y), t = Math.min(3, Math.max(0, (rr - z + 3) / 2));
		return Math.hypot(rr - t, z - (3 - t));
	}
	return { cols: cols, error: error };
}
