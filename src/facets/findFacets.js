// src/facets/findFacets.js
//==========================================================
// Facets: flat patches of a scan, by region growing on the 0.7.0 point
// normals (CloudCompare's Facets tool in spirit). Seeds are taken
// flattest first (lowest plane-fit residual); from each, a queue grows
// the facet through each point's k nearest within maxDistance: a
// neighbour joins when its normal is within maxAngle of the facet's
// (axial) and it lies within planeDistance of the facet's plane - the
// two checks of trimesh-build-js's bridging guard, which keep a facet on
// one surface. The plane comes from running Float64 sums on offsets
// from the seed and is refitted when the count passes 1.25 x the count
// at the last fit, so the work stays linear. A facet whose area
// (outline.js) is under minArea is released: its points go back to 0
// and may join a later facet (they are not seeds again), once - a point
// released twice stays 0. A speck under minPoints is released for good:
// its points stay 0 and join nothing later. So rough ground (many small
// tries) is not regrown over and over: each point is visited at most
// about three times.
// Facet ids are 1 ... n by area, largest first; 0 is none.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { buildKdTree, kdNearest } from "../index/kdtree.js";
import { checkK, checkMaxDistance } from "../index/knn.js";
import { pointNormals, estimateNoise, smallestEigen } from "../ops/normals.js";
import { poleOf, orientationOf } from "./orientation.js";
import { facetOutline } from "./outline.js";

var D = Math.PI / 180, SPACING_SAMPLE = 4096;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function positive(v) { return typeof v === "number" && isFinite(v) && v > 0; }

function options(cols, opts) {
	if (opts === undefined || opts === null || typeof opts !== "object") throw bad("findFacets needs options: { maxDistance, … }");
	var o = opts, n = cols.count;
	var k = o.k === undefined ? 16 : o.k;
	checkK(k, "k");
	if (k < 3) throw bad("k must be at least 3 (a plane needs 3 points), not " + k);
	checkMaxDistance(o.maxDistance);
	var maxAngle = o.maxAngle === undefined ? 10 : o.maxAngle;
	if (typeof maxAngle !== "number" || !(maxAngle > 0 && maxAngle < 90)) throw bad("maxAngle must be a number of degrees above 0 and below 90, not " + JSON.stringify(maxAngle));
	if (o.planeDistance !== undefined && !positive(o.planeDistance)) throw bad("planeDistance must be a positive distance, not " + o.planeDistance);
	var minArea = o.minArea === undefined ? 1 : o.minArea;
	if (typeof minArea !== "number" || !(minArea >= 0) || !isFinite(minArea)) throw bad("minArea must be a number >= 0, not " + minArea);
	var minPoints = o.minPoints === undefined ? 20 : o.minPoints;
	if (!Number.isInteger(minPoints) || minPoints < 3) throw bad("minPoints must be a whole number >= 3, not " + minPoints);
	if (o.outlineCell !== undefined && !positive(o.outlineCell)) throw bad("outlineCell must be a positive size, not " + o.outlineCell);
	if (o.normals !== undefined) {
		var nm = o.normals;
		if (!nm || !nm.normal || !nm.residual || nm.normal.length !== 3 * n || nm.residual.length !== n) throw bad("normals must be { normal (3 a point), residual (1 a point) } from pointNormals for this cloud");
	}
	if (o.onProgress !== undefined && typeof o.onProgress !== "function") throw bad("onProgress must be a function");
	return { k: k, maxDistance: o.maxDistance, maxAngle: maxAngle, planeDistance: o.planeDistance, minArea: minArea, minPoints: minPoints, outlineCell: o.outlineCell, normals: o.normals, onProgress: o.onProgress };
}

/**
 * Split a cloud into facets (flat patches) by region growing on point normals.
 * @param {object} cols - point columns (x / y / z or a k = 3 positions column), in any frame;
 *   every result is in the columns' frame.
 * @param {{maxDistance: number, k?: number, maxAngle?: number, planeDistance?: number, minArea?: number,
 *   minPoints?: number, outlineCell?: number, normals?: {normal: Float32Array, residual: Float32Array},
 *   onProgress?: function(number, number)}} options - maxDistance required; k 16; maxAngle 10 degrees;
 *   planeDistance 3 x estimateNoise (maxDistance / 10 when it cannot be measured); minArea 1;
 *   minPoints 20; outlineCell 2 x the facet's median nearest-neighbour spacing; normals from
 *   pointNormals with the same k and maxDistance, to skip computing them.
 * @returns {{facet: Uint32Array, facets: Array<{id: number, count: number, normal: number[], centroid: number[],
 *   dip: number, dipDirection: number, area: number, rms: number, outline: Float64Array}>, planeDistance: number}}
 * @throws {LasError} INVALID_ARGUMENT naming the bad option.
 */
export function findFacets(cols, opts) {
	var o = options(cols, opts), n = cols.count;
	var computeNormals = !o.normals, total = (computeNormals ? n : 0) + n, last = -1;
	function tick(done) { if (o.onProgress && (done === total || done - last >= Math.max(1, total / 100))) { last = done; o.onProgress(done, total); } }
	if (!n) { if (o.onProgress) o.onProgress(0, 0); return { facet: new Uint32Array(0), facets: [], planeDistance: o.planeDistance || o.maxDistance / 10 }; }
	var nm = o.normals || pointNormals(cols, { k: o.k, maxDistance: o.maxDistance, onProgress: function (d) { tick(d); } });
	var N = nm.normal, RES = nm.residual, off = computeNormals ? n : 0;
	var pd = o.planeDistance;
	if (pd === undefined) {
		var noise = estimateNoise(cols, { k: o.k, maxDistance: o.maxDistance });
		pd = noise > 0 ? 3 * noise : o.maxDistance / 10;
	}
	var tree = buildKdTree(cols, "findFacets"), co = tree.coords, X = co.x, Y = co.y, Z = co.z, st = co.stride;
	var cosA = Math.cos(o.maxAngle * D), maxD2 = o.maxDistance * o.maxDistance;

	// seeds: points with a normal, flattest first
	var seeds = [];
	for (var i = 0; i < n; i++) if (RES[i] === RES[i] && (N[3 * i] || N[3 * i + 1] || N[3 * i + 2])) seeds.push(i);
	seeds.sort(function (a, b) { return RES[a] - RES[b] || a - b; });

	var facet = new Uint32Array(n), noSeed = new Uint8Array(n), out = new Uint8Array(n), released = new Uint8Array(n), queue = new Uint32Array(n);
	var P = new Uint32Array(o.k), Dd = new Float64Array(o.k), eig = new Float64Array(5), cov = new Float64Array(6);
	var found = [], id = 0, processed = 0, spacing = new Float64Array(SPACING_SAMPLE);

	seeds.forEach(function (seed) {
		if (facet[seed] || noSeed[seed] || out[seed]) return;
		id++;
		var sx = X[seed * st], sy = Y[seed * st], sz = Z[seed * st];
		// running sums on offsets from the seed
		var c = 0, s1 = 0, s2 = 0, s3 = 0, s11 = 0, s12 = 0, s13 = 0, s22 = 0, s23 = 0, s33 = 0;
		var mx = N[3 * seed], my = N[3 * seed + 1], mz = N[3 * seed + 2], cx = 0, cy = 0, cz = 0, lastFit = 1, ns = 0;
		function add(p) {
			var dx = X[p * st] - sx, dy = Y[p * st] - sy, dz = Z[p * st] - sz;
			c++; s1 += dx; s2 += dy; s3 += dz;
			s11 += dx * dx; s12 += dx * dy; s13 += dx * dz; s22 += dy * dy; s23 += dy * dz; s33 += dz * dz;
		}
		function fit() {
			cx = s1 / c; cy = s2 / c; cz = s3 / c;
			cov[0] = s11 / c - cx * cx; cov[1] = s12 / c - cx * cy; cov[2] = s13 / c - cx * cz;
			cov[3] = s22 / c - cy * cy; cov[4] = s23 / c - cy * cz; cov[5] = s33 / c - cz * cz;
			if (c >= 3 && smallestEigen(cov, eig)) { mx = eig[0]; my = eig[1]; mz = eig[2]; }
			lastFit = c;
		}
		facet[seed] = id; queue[0] = seed; add(seed); fit();
		var head = 0, len = 1;
		while (head < len) {
			var p = queue[head++];
			processed++;
			tick(off + Math.min(n, processed));
			var m = kdNearest(tree, X[p * st], Y[p * st], Z[p * st], o.k, maxD2, p, P, Dd);
			if (m && ns < SPACING_SAMPLE) spacing[ns++] = Math.sqrt(Dd[0]);
			for (var j = 0; j < m; j++) {
				var q = P[j];
				if (facet[q] || out[q]) continue;
				var nx = N[3 * q], ny = N[3 * q + 1], nz = N[3 * q + 2];
				if (Math.abs(nx * mx + ny * my + nz * mz) < cosA) continue;
				var dist = (X[q * st] - sx - cx) * mx + (Y[q * st] - sy - cy) * my + (Z[q * st] - sz - cz) * mz;
				if (Math.abs(dist) > pd) continue;
				facet[q] = id; queue[len++] = q; add(q);
				if (c >= 1.25 * lastFit) fit();
			}
		}
		var members = queue.slice(0, len);
		function release() {
			for (var r = 0; r < len; r++) { var q = members[r]; facet[q] = 0; noSeed[q] = 1; if (++released[q] >= 2) out[q] = 1; }
			id--;
		}
		if (len < o.minPoints) { release(); for (var r2 = 0; r2 < len; r2++) out[members[r2]] = 1; return; }
		fit();
		if (!(eig[3] === eig[3])) { release(); return; }
		var normal = poleOf([mx, my, mz]), centroid = [sx + cx, sy + cy, sz + cz];
		var sp = spacing.slice(0, ns).sort();
		var cell = o.outlineCell || 2 * (ns ? sp[(ns - 1) >> 1] : o.maxDistance / 2) || o.maxDistance;
		var shape = facetOutline(X, Y, Z, st, members, centroid, normal, cell);
		if (shape.area < o.minArea) { release(); return; }
		var or = orientationOf(normal);
		found.push({ tmp: id, count: len, normal: normal, centroid: centroid, dip: or.dip, dipDirection: or.dipDirection, area: shape.area, rms: Math.sqrt(Math.max(0, eig[3])), outline: shape.outline });
	});

	// ids by area, largest first
	found.sort(function (a, b) { return b.area - a.area || a.tmp - b.tmp; });
	var map = new Uint32Array(id + 1);
	var facets = found.map(function (f, w) {
		map[f.tmp] = w + 1;
		return { id: w + 1, count: f.count, normal: f.normal, centroid: f.centroid, dip: f.dip, dipDirection: f.dipDirection, area: f.area, rms: f.rms, outline: f.outline };
	});
	for (i = 0; i < n; i++) if (facet[i]) facet[i] = map[facet[i]];
	tick(total);
	return { facet: facet, facets: facets, planeDistance: pd };
}
