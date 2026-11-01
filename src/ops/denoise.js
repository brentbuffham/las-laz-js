// src/ops/denoise.js
//==========================================================
// Smooth a fuzzy scan: each point moves against its neighbours (the
// other points among its k nearest within maxDistance).
//  - "bilateral" (the default; edges stay sharp): the point moves
//    along its normal by the weighted mean height of its neighbours
//    above its plane (Fleishman, Drori and Cohen-Or, 2003, on points).
//    A neighbour's weight falls with its distance (σc, half the
//    farthest neighbour's distance) and with its height (σs, twice
//    the noise level), so a face across a crest counts for almost
//    nothing. The normal is fitted twice: plainly, then with those
//    weights, so a crest point follows the face it is on.
//  - "mls": the point moves onto the plane fitted to its neighbours
//    with distance weights. Smooths more; rounds edges slightly.
// The noise level (sigma) is measured (estimateNoise) unless given.
// Every point is computed from the old coordinates, so the result
// does not depend on point order; a further pass rebuilds the index.
// A point with fewer than 5 neighbours, or on no plane, stays put.
// The result is as transformPoints returns it: new coordinates of the
// input's types, every other column shared.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf } from "../index/grid.js";
import { checkK, checkMaxDistance } from "../index/knn.js";
import { sharedBar } from "../progressBar.js";
import { buildKdTree, kdNearest } from "../index/kdtree.js";
import { fitPlane, estimateNoise } from "./normals.js";
import { columnsOf, sameType, checkNoSharedMemory } from "./columns.js";

var MIN_NEIGHBOURS = 5;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/**
 * Smooth point columns against their neighbours.
 * @param {object} cols - point columns (x, y, z or a k = 3 positions column).
 * @param {{method?: string, k?: number, maxDistance: number, sigma?: number, iterations?: number,
 *   normals?: boolean, inPlace?: boolean, onProgress?: function(number, number), signal?: AbortSignal}} opts -
 *   method "bilateral" or "mls" (default "bilateral"), k 16, sigma measured, iterations 1. onProgress(done, total) counts
 *   points x iterations, with the noise measure first when sigma is not given (a tenth of it) and each pass's tree build
 *   (a tenth of the pass) on it; a signal is looked at as it ticks (ABORTED).
 * @returns {object} point columns: new x, y, z (or positions); with normals, a normal column (Float32, k = 3)
 */
export function denoisePoints(cols, opts) {
	opts = opts || {};
	var method = opts.method === undefined ? "bilateral" : opts.method;
	if (method !== "bilateral" && method !== "mls") throw bad("method must be \"bilateral\" or \"mls\", not " + String(method));
	var k = opts.k === undefined ? 16 : opts.k;
	checkK(k, "k");
	checkMaxDistance(opts.maxDistance);
	var iterations = opts.iterations === undefined ? 1 : opts.iterations;
	if (!(Number.isInteger(iterations) && iterations >= 1)) throw bad("iterations must be a whole number >= 1, not " + String(iterations));
	if (opts.sigma !== undefined && !(typeof opts.sigma === "number" && isFinite(opts.sigma) && opts.sigma > 0)) throw bad("sigma must be a positive finite number, not " + String(opts.sigma));
	var maxDistance = opts.maxDistance, maxD2 = maxDistance * maxDistance;
	var co = coordsOf(cols, "denoisePoints"), n = cols.count, positions = co.stride === 3;
	var bar = sharedBar(opts.onProgress, opts.signal, n * iterations), MEASURE = opts.sigma !== undefined ? 0 : 0.1, BUILD = 0.1;
	bar.at(0);
	if (opts.inPlace && !positions) checkNoSharedMemory(cols, [{ name: "x" }, { name: "y" }, { name: "z" }]);
	var sigma = opts.sigma !== undefined ? opts.sigma : estimateNoise(cols, { k: k, maxDistance: maxDistance, onProgress: bar.sub(0, MEASURE), signal: opts.signal });
	var move = sigma > 0;

	// Coordinate buffers of the input's types: pass i reads src and writes dst
	function buffers() { return positions ? { count: n, positions: sameType(cols.positions, 3 * n) } : { count: n, x: sameType(cols.x, n), y: sameType(cols.y, n), z: sameType(cols.z, n) }; }
	var src = positions ? { count: n, positions: cols.positions } : { count: n, x: cols.x, y: cols.y, z: cols.z };
	var dst = buffers();
	var normal = opts.normals ? new Float32Array(3 * n) : null;
	var P = new Uint32Array(k), D = new Float64Array(k), W = new Float64Array(k), fit = new Float64Array(7);
	var inv2s = 1 / (2 * (2 * sigma) * (2 * sigma));

	for (var pass = 0; pass < iterations; pass++) {
		var last = pass === iterations - 1;
		// this pass's part of the bar: its tree build, then its points
		var from = MEASURE + (1 - MEASURE) * pass / iterations, to = MEASURE + (1 - MEASURE) * (pass + 1) / iterations, tick = bar.ticker(from + BUILD * (to - from), to, n);
		var index = move || (last && normal) ? buildKdTree(src, "denoisePoints", function (f) { bar.at(from + BUILD * (to - from) * f); }) : null;
		var sc = index ? index.coords : coordsOf(src, "denoisePoints");
		var X = sc.x, Y = sc.y, Z = sc.z, st = sc.stride;
		var dc = coordsOf(dst, "denoisePoints"), OX = dc.x, OY = dc.y, OZ = dc.z;
		for (var p = 0, o = 0; p < n; p++, o += st) {
			var px = X[o], py = Y[o], pz = Z[o], nx = 0, ny = 0, nz = 0, delta = 0;
			var m = index ? kdNearest(index, px, py, pz, k, maxD2, p, P, D) : 0;
			if (m >= 3 && fitPlane(X, Y, Z, st, p, P, m, null, fit)) {
				nx = fit[0]; ny = fit[1]; nz = fit[2];
				if (move && m >= MIN_NEIGHBOURS && D[m - 1] > 0) {
					var s = 0.5 * Math.sqrt(D[m - 1]), inv2c = 1 / (2 * s * s), j, q, h;
					if (method === "bilateral") {
						for (j = 0; j < m; j++) {
							q = P[j] * st;
							h = nx * (X[q] - px) + ny * (Y[q] - py) + nz * (Z[q] - pz);
							W[j] = Math.exp(-D[j] * inv2c - h * h * inv2s);
						}
						if (fitPlane(X, Y, Z, st, p, P, m, W, fit)) { nx = fit[0]; ny = fit[1]; nz = fit[2]; }
						var num = 0, den = 0;
						for (j = 0; j < m; j++) {
							q = P[j] * st;
							h = nx * (X[q] - px) + ny * (Y[q] - py) + nz * (Z[q] - pz);
							var w = Math.exp(-D[j] * inv2c - h * h * inv2s);
							num += w * h; den += w;
						}
						if (den > 0) delta = num / den;
					} else {
						for (j = 0; j < m; j++) W[j] = Math.exp(-D[j] * inv2c);
						if (fitPlane(X, Y, Z, st, p, P, m, W, fit)) {
							nx = fit[0]; ny = fit[1]; nz = fit[2];
							delta = nx * fit[4] + ny * fit[5] + nz * fit[6];
						}
					}
				}
			}
			var d = p * dc.stride;
			if (delta !== 0) { OX[d] = px + nx * delta; OY[d] = py + ny * delta; OZ[d] = pz + nz * delta; }
			else { OX[d] = px; OY[d] = py; OZ[d] = pz; }
			if (normal && last) { normal[3 * p] = nx; normal[3 * p + 1] = ny; normal[3 * p + 2] = nz; }
			tick(p + 1);
		}
		if (!last) {
			// the input is never written: pass 1 needs a second buffer, later passes swap the two
			var old = src;
			src = dst; dst = pass === 0 ? buffers() : old;
		}
	}

	bar.at(1);
	return denoiseResult(cols, dst, normal, positions, opts.inPlace);
}

/**
 * The columns denoisePoints returns: the new positions (written into cols with inPlace), every other column shared, and the normals.
 * Internal (denoisePointsParallel); not exported from the package entry.
 * @param {object} cols - the input columns.
 * @param {object} dst - the new coordinates, { count, x, y, z } or { count, positions }.
 * @param {Float32Array|null} normal - 3 values a point.
 * @param {boolean} positions - the input holds a k = 3 positions column.
 * @param {boolean} [inPlace]
 * @returns {object}
 */
export function denoiseResult(cols, dst, normal, positions, inPlace) {
	var moved = dst, n = cols.count;
	if (inPlace) {
		if (positions) cols.positions.set(dst.positions);
		else { cols.x.set(dst.x); cols.y.set(dst.y); cols.z.set(dst.z); }
		moved = cols;
	}
	var names = positions ? ["positions"] : ["x", "y", "z"], out = { count: n };
	columnsOf(cols).forEach(function (c) {
		// defineProperty so a column named "__proto__" stays a column
		var v = names.indexOf(c.name) >= 0 ? moved[c.name] : cols[c.name];
		Object.defineProperty(out, c.name, { value: v, enumerable: true, writable: true, configurable: true });
	});
	if (normal) Object.defineProperty(out, "normal", { value: normal, enumerable: true, writable: true, configurable: true });
	return out;
}
