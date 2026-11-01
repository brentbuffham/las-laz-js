// src/index/density.js
//==========================================================
// How densely a cloud sits on its plan: points a unit area, from the
// area of a coarse grid's cells that a sample of the points falls in.
// Cheap (a sample of at most 500,000 points), for choosing a cell size
// or a default overlap before a pass over the whole cloud.
//==========================================================

var DENSITY_GRID = 256, DENSITY_SAMPLE = 500000;

// Points a unit area on the cloud's plan (its two widest axes): the points over the area of the coarse grid cells a
// sample of them falls in. Duplicates count, so it is never below the density of the points kept.
export function density(x, y, z, n, lo, hi) {
	var axes = [x, y, z], span = [hi[0] - lo[0], hi[1] - lo[1], z ? hi[2] - lo[2] : -1];
	var order = [0, 1, 2].filter(function (a) { return span[a] >= 0; }).sort(function (a, b) { return span[b] - span[a]; });
	var U = axes[order[0]], V = axes[order[1]], su = span[order[0]], sv = span[order[1]];
	if (!(su > 0 && sv > 0)) return Infinity;
	var G = DENSITY_GRID, gu = G / su, gv = G / sv, u0 = lo[order[0]], v0 = lo[order[1]], seen = new Uint8Array(G * G), occ = 0;
	var step = Math.max(1, Math.floor(n / DENSITY_SAMPLE));
	for (var p = 0; p < n; p += step) {
		var cu = Math.min(G - 1, Math.floor((U[p] - u0) * gu)), cv = Math.min(G - 1, Math.floor((V[p] - v0) * gv)), q = cv * G + cu;
		if (!seen[q]) { seen[q] = 1; occ++; }
	}
	return n / (occ / (G * G) * su * sv);
}


/**
 * Points a unit area on the cloud's plan, bounds measured here.
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @param {ArrayLike<number>|null} z
 * @param {number} n
 * @returns {number} Infinity for a cloud with no area
 */
export function cloudDensity(x, y, z, n) {
	var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], cols = [x, y, z], dims = z ? 3 : 2;
	for (var p = 0; p < n; p++) for (var a = 0; a < dims; a++) { var v = cols[a][p]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
	return n ? density(x, y, z, n, lo, hi) : Infinity;
}
