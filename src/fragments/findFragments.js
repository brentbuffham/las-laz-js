// src/fragments/findFragments.js
//==========================================================
// Fragments: the rocks of a muckpile scan, as facets (0.9.0) merged
// across convex edges - LCCP (Stein et al. 2014) in spirit, with the
// facets as its patches. On rock-face settings each face is a facet;
// facets that meet at a ridge (convex) are one rock, a valley
// (concave) keeps two apart. Each facet faces out of the pile
// (pileNormals.js). Where two facets touch, every boundary pair of
// points votes: convex when (n_i - n_j) . (p - q) > 0, or when the
// normals are within concaveAngle and the pair lies on one plane (a
// face split by noise); parallel but offset is a step - a rock on a
// rock - and votes concave. An edge of at least 3 pairs is convex when
// more than half vote so; union-find merges along convex edges, strongest
// first, and only while the fragment stays convex - each member facet's
// centroid behind every other member's plane (within 2 x planeDistance) -
// so rough ground does not chain into one huge fragment. A facet
// nearly edge-on to the pile has no reliable outward side, so it does
// not vote; after the merge it joins the touching fragment it stays
// convex with for one of its two sides (most contact pairs first). A point in no facet joins the fragment of the nearest
// facet point within fillDistance - one hop, so fines between rocks
// stay 0. Fragments under minPoints go back to 0; each is measured by
// its PCA spans (axes.js), its size the intermediate one. surfaceArea is
// the scan's area per coarse cell on the cell's plane; unassignedArea each
// cell's share of it held by points at 0.
// Fragment ids are 1 ... n by size, largest first; 0 is none.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf } from "../index/grid.js";
import { buildKdTree, kdNearest } from "../index/kdtree.js";
import { pointNormals } from "../ops/normals.js";
import { findFacets, checkFacetOptions } from "../facets/findFacets.js";
import { facetOutline } from "../facets/outline.js";
import { poleOf } from "../facets/orientation.js";
import { pileNormals } from "./pileNormals.js";
import { fragmentAxes } from "./axes.js";

var D = Math.PI / 180, EDGE_ON = 0.1, MIN_PAIRS = 3, SPACING_SAMPLE = 4096;
var FACE_DEFAULTS = { maxAngle: 20, minArea: 0, minPoints: 10 };

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function finite(v) { return typeof v === "number" && isFinite(v); }

function options(cols, opts) {
	if (opts === undefined || opts === null || typeof opts !== "object") throw bad("findFragments needs options: { maxDistance, … }");
	var o = opts;
	if (o.facetOptions !== undefined && (o.facetOptions === null || typeof o.facetOptions !== "object")) throw bad("facetOptions must be an object of findFacets options");
	var face = Object.assign({}, FACE_DEFAULTS, o.facetOptions || {}, { maxDistance: o.maxDistance, k: o.k, normals: o.normals, onProgress: o.onProgress });
	var fo = checkFacetOptions(cols, face);
	var concaveAngle = o.concaveAngle === undefined ? 10 : o.concaveAngle;
	if (!finite(concaveAngle) || !(concaveAngle > 0 && concaveAngle < 90)) throw bad("concaveAngle must be a number of degrees above 0 and below 90, not " + JSON.stringify(concaveAngle));
	var surfaceDistance = o.surfaceDistance;
	if (surfaceDistance !== undefined && (!finite(surfaceDistance) || !(surfaceDistance > fo.maxDistance))) throw bad("surfaceDistance must be a distance above maxDistance (" + fo.maxDistance + "), not " + JSON.stringify(surfaceDistance));
	var fillDistance = o.fillDistance === undefined ? fo.maxDistance : o.fillDistance;
	if (!finite(fillDistance) || !(fillDistance > 0)) throw bad("fillDistance must be a positive distance, not " + JSON.stringify(fillDistance));
	var fill = o.fill === undefined ? true : o.fill;
	if (typeof fill !== "boolean") throw bad("fill must be true or false, not " + JSON.stringify(fill));
	var minPoints = o.minPoints === undefined ? 50 : o.minPoints;
	if (!Number.isInteger(minPoints) || minPoints < 3) throw bad("minPoints must be a whole number >= 3, not " + JSON.stringify(minPoints));
	var vp = o.viewpoint;
	if (vp !== undefined && !(Array.isArray(vp) && vp.length === 3 && vp.every(finite))) throw bad("viewpoint must be [x, y, z], 3 finite numbers in the columns' frame, not " + JSON.stringify(vp));
	return { face: face, faceMinPoints: fo.minPoints, k: fo.k, maxDistance: fo.maxDistance, normals: o.normals, onProgress: o.onProgress, outlineCell: fo.outlineCell,
		cosFlat: Math.cos(concaveAngle * D), surfaceDistance: surfaceDistance, fillDistance: fillDistance, fill: fill, minPoints: minPoints, viewpoint: vp };
}

/**
 * One boundary pair's vote: is the edge between facets i and j convex there? Normals point out
 * of the pile.
 * @param {number[]} ni - facet i's outward unit normal; nj likewise.
 * @param {number[]} nj
 * @param {number[]} p - the pair's point in facet i; q its point in facet j.
 * @param {number[]} q
 * @param {number} cosFlat - cos(concaveAngle).
 * @param {number} planeDistance - how far off one plane a flat pair may lie.
 * @returns {boolean}
 */
export function convexVote(ni, nj, p, q, cosFlat, planeDistance) {
	var dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
	if (ni[0] * nj[0] + ni[1] * nj[1] + ni[2] * nj[2] >= cosFlat) {
		var mx = ni[0] + nj[0], my = ni[1] + nj[1], mz = ni[2] + nj[2], ml = Math.hypot(mx, my, mz);
		return Math.abs(dx * mx + dy * my + dz * mz) / ml <= planeDistance;
	}
	return (ni[0] - nj[0]) * dx + (ni[1] - nj[1]) * dy + (ni[2] - nj[2]) * dz > 0;
}

// points grouped by a label (1 ... m; 0 left out): { start, order }, label L's points order[start[L] .. start[L + 1])
function groupBy(label, m) {
	var n = label.length, start = new Uint32Array(m + 2), i;
	for (i = 0; i < n; i++) if (label[i]) start[label[i] + 1]++;
	for (i = 1; i <= m + 1; i++) start[i] += start[i - 1];
	var at = start.slice(), order = new Uint32Array(start[m + 1]);
	for (i = 0; i < n; i++) if (label[i]) order[at[label[i]]++] = i;
	return { start: start, order: order };
}

/**
 * Split a muckpile scan into fragments (rocks): facets merged across convex edges.
 * @param {object} cols - point columns (x / y / z or a k = 3 positions column), in any frame; every result
 *   is in the columns' frame.
 * @param {{maxDistance: number, k?: number, normals?: object, onProgress?: function(number, number),
 *   facetOptions?: object, concaveAngle?: number, surfaceDistance?: number, viewpoint?: number[],
 *   fill?: boolean, fillDistance?: number, minPoints?: number}} options - maxDistance required (rock-face
 *   scale, a few point spacings); k 16; facetOptions over { maxAngle: 20, minArea: 0, minPoints: 10 };
 *   concaveAngle 10; surfaceDistance a quarter of the cloud's longest side (at least 10 x maxDistance); viewpoint: a point on the open side; fill true;
 *   fillDistance maxDistance; minPoints 50.
 * @returns {{fragment: Uint32Array, fragments: Array<{id: number, count: number, centroid: number[], normal: number[],
 *   axes: number[], size: number, area: number, outline: Float64Array, facets: number[]}>, facets: object,
 *   surfaceArea: number, unassignedArea: number, planeDistance: number}}
 * @throws {LasError} INVALID_ARGUMENT naming the bad option.
 */
export function findFragments(cols, opts) {
	var o = options(cols, opts), n = cols.count;
	var total = (o.normals ? 0 : n) + 2 * n, last = -1;
	function tick(done) { if (o.onProgress && done > last && (done === total || done - last >= Math.max(1, total / 100))) { last = done; o.onProgress(done, total); } }
	if (!n) {
		var none = findFacets(cols, Object.assign({}, o.face, { onProgress: undefined }));
		if (o.onProgress) o.onProgress(0, 0);
		return { fragment: new Uint32Array(0), fragments: [], facets: none, surfaceArea: 0, unassignedArea: 0, planeDistance: none.planeDistance };
	}
	var co = coordsOf(cols, "findFragments"), X = co.x, Y = co.y, Z = co.z, st = co.stride, i, j, k;

	// 1-3. rock-face normals, the pile's direction, the faces
	var off = 0;
	var nm = o.normals || pointNormals(cols, { k: o.k, maxDistance: o.maxDistance, onProgress: function (d) { tick(d); } });
	if (!o.normals) off = n;
	// the pile's scale must be well above a rock's: by default a quarter of the cloud's longest side, at least 10 x maxDistance
	var sd = o.surfaceDistance;
	if (sd === undefined) {
		var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		for (i = 0; i < n; i++) {
			var ob = i * st, pv = [X[ob], Y[ob], Z[ob]];
			for (k = 0; k < 3; k++) { if (pv[k] < lo[k]) lo[k] = pv[k]; if (pv[k] > hi[k]) hi[k] = pv[k]; }
		}
		sd = Math.max(10 * o.maxDistance, Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 4);
	}
	var pile = pileNormals(cols, { cellSize: sd, viewpoint: o.viewpoint }), PN = pile.normal, cellOf = pile.cellOf;
	var ff = findFacets(cols, Object.assign({}, o.face, { normals: nm, onProgress: function (d) { tick(off + d); } }));
	var facet = ff.facet, F = ff.facets.length, pd = ff.planeDistance;
	off += n;
	// each facet's outward normal, against the sum of its points' pile normals
	var sum = new Float64Array(3 * (F + 1));
	for (i = 0; i < n; i++) if (facet[i]) { var c = cellOf[i], f = facet[i]; sum[3 * f] += PN[3 * c]; sum[3 * f + 1] += PN[3 * c + 1]; sum[3 * f + 2] += PN[3 * c + 2]; }
	var FN = new Float64Array(3 * (F + 1)), edgeOn = new Uint8Array(F + 1);
	for (f = 1; f <= F; f++) {
		var pn = poleOf(ff.facets[f - 1].normal), sl = Math.hypot(sum[3 * f], sum[3 * f + 1], sum[3 * f + 2]);   // never 0 in practice; 0 gives NaN: the pole kept, not edge-on
		var dot = (pn[0] * sum[3 * f] + pn[1] * sum[3 * f + 1] + pn[2] * sum[3 * f + 2]) / sl;
		var sg = dot < 0 ? -1 : 1;
		FN[3 * f] = sg * pn[0]; FN[3 * f + 1] = sg * pn[1]; FN[3 * f + 2] = sg * pn[2];
		if (Math.abs(dot) < EDGE_ON) edgeOn[f] = 1;
	}

	// 4-5, 7. contacts and their votes; the fill's nearest facet point; a spacing sample
	var tree = buildKdTree(cols, "findFragments"), Pn = new Uint32Array(o.k), Dd = new Float64Array(o.k);
	var maxD2 = o.maxDistance * o.maxDistance, fillD2 = o.fillDistance * o.fillDistance;
	var votes = new Map(), edgeOnPairs = new Map(), fillFrom = new Uint32Array(n), spacing = new Float64Array(SPACING_SAMPLE), ns = 0;
	var a3 = [0, 0, 0], b3 = [0, 0, 0], na = [0, 0, 0], nb = [0, 0, 0];
	for (i = 0; i < n; i++) {
		var fi = facet[i], oi = i * st;
		var m = kdNearest(tree, X[oi], Y[oi], Z[oi], o.k, fi ? maxD2 : (o.fill ? fillD2 : maxD2), i, Pn, Dd);
		if (m && ns < SPACING_SAMPLE) spacing[ns++] = Math.sqrt(Dd[0]);
		if (!fi) {
			if (o.fill) for (j = 0; j < m; j++) if (facet[Pn[j]]) { fillFrom[i] = facet[Pn[j]]; break; }
		} else {
			for (j = 0; j < m; j++) {
				var q = Pn[j], fj = facet[q];
				if (!fj || fj === fi) continue;
				if (edgeOn[fi] || edgeOn[fj]) {
					if (edgeOn[fi] && !edgeOn[fj]) { var ek = fi * (F + 1) + fj; edgeOnPairs.set(ek, (edgeOnPairs.get(ek) || 0) + 1); }
					if (edgeOn[fj] && !edgeOn[fi]) { var ek2 = fj * (F + 1) + fi; edgeOnPairs.set(ek2, (edgeOnPairs.get(ek2) || 0) + 1); }
					continue;
				}
				var oq = q * st;
				a3[0] = X[oi]; a3[1] = Y[oi]; a3[2] = Z[oi]; b3[0] = X[oq]; b3[1] = Y[oq]; b3[2] = Z[oq];
				na[0] = FN[3 * fi]; na[1] = FN[3 * fi + 1]; na[2] = FN[3 * fi + 2]; nb[0] = FN[3 * fj]; nb[1] = FN[3 * fj + 1]; nb[2] = FN[3 * fj + 2];
				var key = fi < fj ? fi * (F + 1) + fj : fj * (F + 1) + fi, v = votes.get(key);
				if (!v) { v = [0, 0]; votes.set(key, v); }
				v[0]++;
				if (convexVote(na, nb, a3, b3, o.cosFlat, pd)) v[1]++;
			}
		}
		tick(Math.min(total - 1, off + i + 1));
	}

	// 6. union-find along convex edges (union by lower id), then the edge-on facets
	var parent = new Uint32Array(F + 1);
	for (f = 0; f <= F; f++) parent[f] = f;
	function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
	var members = [];   // each root's facets
	for (f = 0; f <= F; f++) members.push([f]);
	function union(x, y) {
		x = find(x); y = find(y);
		if (x === y) return;
		var lo = x < y ? x : y, hi = x < y ? y : x;
		parent[hi] = lo; members[lo] = members[lo].concat(members[hi]); members[hi] = null;
	}
	// a rock is convex: every member facet's centroid lies behind every other member's plane
	var C = new Float64Array(3 * (F + 1)), tau = 2 * pd;
	for (f = 1; f <= F; f++) { var fc0 = ff.facets[f - 1].centroid; C[3 * f] = fc0[0]; C[3 * f + 1] = fc0[1]; C[3 * f + 2] = fc0[2]; }
	// a sliver's plane is too loose to judge by, so only facets of 3 x the facet minPoints give planes
	var planeMin = 3 * o.faceMinPoints;
	function behind(f1, f2) { return ff.facets[f1 - 1].count < planeMin || FN[3 * f1] * (C[3 * f2] - C[3 * f1]) + FN[3 * f1 + 1] * (C[3 * f2 + 1] - C[3 * f1 + 1]) + FN[3 * f1 + 2] * (C[3 * f2 + 2] - C[3 * f1 + 2]) <= tau; }
	function staysConvex(x, y) {
		var A = members[find(x)], B = members[find(y)];
		for (var u = 0; u < A.length; u++) for (var w = 0; w < B.length; w++) if (!behind(A[u], B[w]) || !behind(B[w], A[u])) return false;
		return true;
	}
	// convex edges, strongest first (share of convex votes, then pairs, then facet ids)
	var edges = [];
	votes.forEach(function (v, key) { if (v[0] >= MIN_PAIRS && 2 * v[1] > v[0]) edges.push([key, v[1] / v[0], v[0]]); });
	edges.sort(function (p, q) { return q[1] - p[1] || q[2] - p[2] || p[0] - q[0]; });
	edges.forEach(function (e) {
		var x = Math.floor(e[0] / (F + 1)), y = e[0] % (F + 1);
		if (find(x) !== find(y) && staysConvex(x, y)) union(x, y);
	});
	var join = [];
	for (f = 1; f <= F; f++) if (edgeOn[f]) join.push(f);
	if (join.length) {
		var perRoot = new Map();
		Array.from(edgeOnPairs.keys()).sort(function (p, q) { return p - q; }).forEach(function (key) {
			var e = Math.floor(key / (F + 1)), r = find(key % (F + 1)), mk = e * (F + 1) + r;
			perRoot.set(mk, (perRoot.get(mk) || 0) + edgeOnPairs.get(key));
		});
		// each joins the touching fragment it stays convex with for one of its two sides (most pairs first)
		var cands = new Map();
		perRoot.forEach(function (cnt, mk) {
			var e = Math.floor(mk / (F + 1));
			(cands.get(e) || cands.set(e, []).get(e)).push([mk % (F + 1), cnt]);
		});
		join.forEach(function (e) {
			var list = (cands.get(e) || []).sort(function (p, q) { return q[1] - p[1] || p[0] - q[0]; });
			for (var c2 = 0; c2 < list.length; c2++) {
				var r2 = find(list[c2][0]);
				if (r2 === find(e)) break;
				if (staysConvex(e, r2)) { union(e, r2); break; }
				FN[3 * e] = -FN[3 * e]; FN[3 * e + 1] = -FN[3 * e + 1]; FN[3 * e + 2] = -FN[3 * e + 2];
				if (staysConvex(e, r2)) { union(e, r2); break; }
				FN[3 * e] = -FN[3 * e]; FN[3 * e + 1] = -FN[3 * e + 1]; FN[3 * e + 2] = -FN[3 * e + 2];
			}
		});
	}

	// 7-8. fragment per point (root facet), tidy, measure
	var raw = new Uint32Array(n);
	for (i = 0; i < n; i++) { var src = facet[i] || fillFrom[i]; if (src) raw[i] = find(src); }
	var g = groupBy(raw, F), sp = spacing.slice(0, ns).sort();
	var cell = o.outlineCell || 2 * (ns ? sp[(ns - 1) >> 1] : o.maxDistance / 2) || o.maxDistance;
	var found = [], facetsOf = [];
	for (f = 1; f <= F; f++) { var rf = find(f); (facetsOf[rf] = facetsOf[rf] || []).push(f); }
	for (var r0 = 1; r0 <= F; r0++) {
		var cnt = g.start[r0 + 1] - g.start[r0];
		if (!cnt || cnt < o.minPoints) continue;
		var members = g.order.subarray(g.start[r0], g.start[r0 + 1]);
		var ax = fragmentAxes(X, Y, Z, st, members), sx = 0, sy = 0, sz = 0;
		for (k = 0; k < cnt; k++) { var pc = cellOf[members[k]]; sx += PN[3 * pc]; sy += PN[3 * pc + 1]; sz += PN[3 * pc + 2]; }
		var nrm = ax.smallest, sgn = nrm[0] * sx + nrm[1] * sy + nrm[2] * sz < 0 ? -1 : 1;
		nrm = [sgn * nrm[0], sgn * nrm[1], sgn * nrm[2]];
		var shape = facetOutline(X, Y, Z, st, members, ax.centroid, nrm, cell);
		found.push({ root: r0, first: members[0], count: cnt, centroid: ax.centroid, normal: nrm, axes: ax.axes, size: ax.axes[1], area: shape.area, outline: shape.outline, facets: facetsOf[r0] });
	}
	found.sort(function (p, q) { return q.size - p.size || q.count - p.count || p.first - q.first; });
	var idOf = new Uint32Array(F + 1);
	var fragments = found.map(function (x, w) {
		idOf[x.root] = w + 1;
		return { id: w + 1, count: x.count, centroid: x.centroid, normal: x.normal, axes: x.axes, size: x.size, area: x.area, outline: x.outline, facets: x.facets };
	});
	var fragment = new Uint32Array(n);
	for (i = 0; i < n; i++) if (raw[i]) fragment[i] = idOf[raw[i]];

	// 9. the surface's area per coarse cell on its plane; the part in no fragment as the cell's share of
	// points at 0 (scattered points would each fill a whole grid cell)
	var byCell = groupBy(Uint32Array.from(cellOf, function (cc) { return cc + 1; }), pile.cells), surfaceArea = 0, unassignedArea = 0;
	for (var cc = 0; cc < pile.cells; cc++) {
		var pts = byCell.order.subarray(byCell.start[cc + 1], byCell.start[cc + 2]), cen = [pile.centroid[3 * cc], pile.centroid[3 * cc + 1], pile.centroid[3 * cc + 2]];
		var nc = [PN[3 * cc], PN[3 * cc + 1], PN[3 * cc + 2]], z0 = 0;
		for (k = 0; k < pts.length; k++) if (!fragment[pts[k]]) z0++;
		var ca = facetOutline(X, Y, Z, st, pts, cen, nc, cell).area;
		surfaceArea += ca; unassignedArea += ca * z0 / pts.length;
	}
	tick(total);
	return { fragment: fragment, fragments: fragments, facets: ff, surfaceArea: surfaceArea, unassignedArea: unassignedArea, planeDistance: pd };
}
