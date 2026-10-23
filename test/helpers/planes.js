// test/helpers/planes.js
//==========================================================
// Synthetic planes for the facet tests: rectangles of points on planes
// of known dip and dip direction (a grid at the given spacing, Gaussian
// noise on every axis), plus a share of stray points spread over the
// whole box. truth holds each point's plane (1 …) or 0 for a stray.
// float32 + origin gives local Float32 columns about origin (the way the
// demo and Kirra read), the planes' centres being world coordinates.
//==========================================================

import { rng } from "./clouds.js";
import { poleFromOrientation } from "../../src/facets/orientation.js";

function gauss(r) { var u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// An in-plane basis: u along strike (horizontal), v up or down the dip
export function planeBasis(n) {
	var u = Math.abs(n[2]) > 1 - 1e-12 ? [1, 0, 0] : [-n[1], n[0], 0];
	var l = Math.hypot(u[0], u[1], u[2]);
	u = [u[0] / l, u[1] / l, u[2] / l];
	var v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
	return { u: u, v: v };
}

/**
 * @param {{planes: Array<{centre: number[], dip: number, dipDirection: number, width: number, height: number}>,
 *   spacing: number, noise?: number, stray?: number, seed?: number, float32?: boolean, origin?: number[]}} o
 * @returns {{cols: object, truth: Uint32Array, normals: number[][]}}
 */
export function planesCloud(o) {
	var r = rng(o.seed || 1), x = [], y = [], z = [], truth = [], normals = [], noise = o.noise || 0;
	o.planes.forEach(function (pl, k) {
		var n = poleFromOrientation(pl.dip, pl.dipDirection), b = planeBasis(n);
		normals.push(n);
		for (var a = -pl.width / 2 + o.spacing / 2; a < pl.width / 2; a += o.spacing) {
			for (var c = -pl.height / 2 + o.spacing / 2; c < pl.height / 2; c += o.spacing) {
				x.push(pl.centre[0] + a * b.u[0] + c * b.v[0] + noise * gauss(r));
				y.push(pl.centre[1] + a * b.u[1] + c * b.v[1] + noise * gauss(r));
				z.push(pl.centre[2] + a * b.u[2] + c * b.v[2] + noise * gauss(r));
				truth.push(k + 1);
			}
		}
	});
	var nStray = Math.round((o.stray || 0) * x.length);
	if (nStray) {
		var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		for (var q = 0; q < x.length; q++) {
			var p = [x[q], y[q], z[q]];
			for (var d = 0; d < 3; d++) { if (p[d] < lo[d]) lo[d] = p[d]; if (p[d] > hi[d]) hi[d] = p[d]; }
		}
		for (var s = 0; s < nStray; s++) {
			x.push(lo[0] + r() * (hi[0] - lo[0])); y.push(lo[1] + r() * (hi[1] - lo[1])); z.push(lo[2] + r() * (hi[2] - lo[2]));
			truth.push(0);
		}
	}
	var org = o.origin || [0, 0, 0], T = o.float32 ? Float32Array : Float64Array, n2 = x.length;
	var cols = { count: n2, x: new T(n2), y: new T(n2), z: new T(n2) };
	for (var i = 0; i < n2; i++) { cols.x[i] = x[i] - org[0]; cols.y[i] = y[i] - org[1]; cols.z[i] = z[i] - org[2]; }
	return { cols: cols, truth: Uint32Array.from(truth), normals: normals };
}
