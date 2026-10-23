// src/facets/jointSets.js
//==========================================================
// Joint sets: facets grouped by orientation. Poles are axial (a pole
// and its opposite are one set) and weighted by facet area.
// Automatic (default): mean-shift on the sphere from every pole (or an
// even 2,000 of them) with a window of maxAngle; modes within maxAngle / 2
// merge; a mode is a set when it gathers at least minFacets facets; each
// facet joins the nearest set within maxAngle, else 0. count: the count
// largest modes refined by spherical k-means, every facet in one. windows:
// the user's own sets, a facet joining the nearest window that holds it.
// Each set's Fisher statistics come from its members (orientation.js).
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { poleOf, orientationOf, poleFromOrientation, fisherStats } from "./orientation.js";
import { thinSelection } from "../ops/select.js";

var D = Math.PI / 180, SEEDS = 2000, STEPS = 50;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function num(v) { return typeof v === "number" && isFinite(v); }

function options(facets, opts) {
	if (!Array.isArray(facets)) throw bad("jointSets needs facets: the list findFacets returns (each with normal and area)");
	facets.forEach(function (f, i) {
		if (!f || !f.normal || f.normal.length !== 3 || !(Math.hypot(f.normal[0], f.normal[1], f.normal[2]) > 0)) throw bad("facets[" + i + "] needs a normal [x, y, z]");
	});
	var o = opts === undefined ? {} : opts;
	if (o === null || typeof o !== "object") throw bad("options must be an object");
	var maxAngle = o.maxAngle === undefined ? 15 : o.maxAngle;
	if (!num(maxAngle) || !(maxAngle > 0 && maxAngle < 90)) throw bad("maxAngle must be degrees above 0 and below 90, not " + JSON.stringify(maxAngle));
	var minFacets = o.minFacets === undefined ? 3 : o.minFacets;
	if (!Number.isInteger(minFacets) || minFacets < 1) throw bad("minFacets must be a whole number >= 1, not " + minFacets);
	if (o.count !== undefined && o.windows !== undefined) throw bad("give count or windows, not both");
	if (o.count !== undefined && (!Number.isInteger(o.count) || o.count < 1)) throw bad("count must be a whole number >= 1, not " + o.count);
	if (o.windows !== undefined) {
		if (!Array.isArray(o.windows)) throw bad("windows must be a list of { dip, dipDirection, angle }");
		o.windows.forEach(function (w, i) {
			if (!w || !num(w.dip) || w.dip < 0 || w.dip > 90) throw bad("windows[" + i + "].dip must be 0-90 degrees");
			if (!num(w.dipDirection) || w.dipDirection < 0 || w.dipDirection > 360) throw bad("windows[" + i + "].dipDirection must be 0-360 degrees");
			if (!num(w.angle) || !(w.angle > 0 && w.angle <= 90)) throw bad("windows[" + i + "].angle must be above 0 and at most 90 degrees");
		});
	}
	return { maxAngle: maxAngle, minFacets: minFacets, count: o.count, windows: o.windows };
}

function dot(P, i, m) { return P[3 * i] * m[0] + P[3 * i + 1] * m[1] + P[3 * i + 2] * m[2]; }

// mean-shift from m: the axial weighted mean of the poles within the window, until it settles
function shift(P, W, n, m, cosT) {
	for (var step = 0; step < STEPS; step++) {
		var sx = 0, sy = 0, sz = 0;
		for (var i = 0; i < n; i++) {
			var c = dot(P, i, m);
			if (Math.abs(c) < cosT) continue;
			var w = c < 0 ? -W[i] : W[i];
			sx += w * P[3 * i]; sy += w * P[3 * i + 1]; sz += w * P[3 * i + 2];
		}
		var l = Math.hypot(sx, sy, sz);
		if (!(l > 0)) return m;
		var next = [sx / l, sy / l, sz / l], moved = Math.acos(Math.min(1, Math.abs(next[0] * m[0] + next[1] * m[1] + next[2] * m[2])));
		m = next;
		if (moved < 1e-6) break;
	}
	return m;
}

// each pole to its nearest mean within cosT (axial); -1 for none
function assign(P, n, means, cosT, out) {
	var changed = false;
	for (var i = 0; i < n; i++) {
		var best = -1, bestC = cosT;
		for (var k = 0; k < means.length; k++) {
			var c = Math.abs(dot(P, i, means[k]));
			if (c >= bestC && (best < 0 || c > bestC)) { bestC = c; best = k; }
		}
		if (out[i] !== best + 1) { out[i] = best + 1; changed = true; }
	}
	return changed;
}

/**
 * Group facets into joint sets by orientation.
 * @param {Array<{normal: number[], area?: number}>} facets - findFacets' list (area 1 when absent).
 * @param {{maxAngle?: number, minFacets?: number, count?: number, windows?: Array<{dip: number, dipDirection: number, angle: number}>}} [options]
 *   automatic by default (maxAngle 15 degrees, minFacets 3); count: that many sets, every facet in
 *   one; windows: the user's sets (not with count).
 * @returns {{family: Uint32Array, families: Array<{id: number, normal: number[], dip: number, dipDirection: number,
 *   fisherK: number, cone95: number, facets: number, area: number}>, pointFamily: function(Uint32Array): Uint32Array}}
 *   family: per facet (by position), 0 = none; families by area (windows: in the windows' order)
 * @throws {LasError} INVALID_ARGUMENT naming the bad option.
 */
export function jointSets(facets, opts) {
	var o = options(facets, opts), n = facets.length, cosT = Math.cos(o.maxAngle * D), i, k;
	var P = new Float64Array(3 * n), W = new Float64Array(n);
	for (i = 0; i < n; i++) {
		var p = poleOf(facets[i].normal);
		P[3 * i] = p[0]; P[3 * i + 1] = p[1]; P[3 * i + 2] = p[2];
		W[i] = num(facets[i].area) && facets[i].area > 0 ? facets[i].area : 1;
	}
	var family = new Uint32Array(n), means = [];
	if (o.windows) {
		var cosW = o.windows.map(function (w) { return Math.cos(w.angle * D); });
		means = o.windows.map(function (w) { return poleFromOrientation(w.dip, w.dipDirection); });
		for (i = 0; i < n; i++) {
			var bw = -1, bc = -1;
			for (k = 0; k < means.length; k++) {
				var cw = Math.abs(dot(P, i, means[k]));
				if (cw >= cosW[k] && cw > bc) { bc = cw; bw = k; }
			}
			family[i] = bw + 1;
		}
	} else if (n) {
		// modes by mean-shift, merged within maxAngle / 2, ranked by the area they gather
		var seeds = n > SEEDS ? thinSelection(n, SEEDS) : null, modes = [], cosHalf = Math.cos(o.maxAngle * D / 2);
		for (var s = 0; s < (seeds ? seeds.length : n); s++) {
			var at = seeds ? seeds[s] : s;
			var mode = shift(P, W, n, [P[3 * at], P[3 * at + 1], P[3 * at + 2]], cosT);
			if (modes.some(function (q) { return Math.abs(q[0] * mode[0] + q[1] * mode[1] + q[2] * mode[2]) >= cosHalf; })) continue;
			modes.push(mode);
		}
		var ranked = modes.map(function (m) {
			var cnt = 0, area = 0;
			for (var j = 0; j < n; j++) if (Math.abs(dot(P, j, m)) >= cosT) { cnt++; area += W[j]; }
			return { m: m, count: cnt, area: area };
		}).filter(function (r) { return o.count !== undefined || r.count >= o.minFacets; }).sort(function (a, b) { return b.area - a.area; });
		if (o.count !== undefined) {
			means = ranked.slice(0, o.count).map(function (r) { return r.m; });
			// spherical k-means: every facet to its nearest mean, means refitted, until stable
			for (var round = 0; round < STEPS; round++) {
				var changed = assign(P, n, means, -1, family);
				means = means.map(function (m, q) { return memberMean(q + 1) || m; });
				if (!changed) break;
			}
		} else {
			means = ranked.map(function (r) { return r.m; });
			assign(P, n, means, cosT, family);
		}
	}
	function memberMean(id) {
		var ps = [], ws = [];
		for (var j = 0; j < n; j++) if (family[j] === id) { ps.push(P[3 * j], P[3 * j + 1], P[3 * j + 2]); ws.push(W[j]); }
		return ps.length ? fisherStats(Float64Array.from(ps), Float64Array.from(ws)).normal : null;
	}
	// statistics per set; automatic and count drop empty sets and order by area
	var families = means.map(function (m, q) {
		var ps = [], ws = [], area = 0;
		for (var j = 0; j < n; j++) if (family[j] === q + 1) { ps.push(P[3 * j], P[3 * j + 1], P[3 * j + 2]); ws.push(W[j]); area += W[j]; }
		var st = ps.length ? fisherStats(Float64Array.from(ps), Float64Array.from(ws)) : { normal: poleOf(m), fisherK: NaN, cone95: NaN, N: 0 };
		var or = orientationOf(st.normal);
		return { old: q + 1, normal: st.normal, dip: or.dip, dipDirection: or.dipDirection, fisherK: st.fisherK, cone95: st.cone95, facets: st.N, area: area };
	});
	if (!o.windows) families = families.filter(function (f) { return f.facets > 0; }).sort(function (a, b) { return b.area - a.area || a.old - b.old; });
	var remap = new Uint32Array(means.length + 1);
	families = families.map(function (f, w) {
		remap[f.old] = w + 1;
		return { id: w + 1, normal: f.normal, dip: f.dip, dipDirection: f.dipDirection, fisherK: f.fisherK, cone95: f.cone95, facets: f.facets, area: f.area };
	});
	for (i = 0; i < n; i++) family[i] = remap[family[i]];
	return {
		family: family,
		families: families,
		pointFamily: function (facetColumn) {
			var out = new Uint32Array(facetColumn.length);
			for (var j = 0; j < facetColumn.length; j++) { var f = facetColumn[j]; out[j] = f && f <= n ? family[f - 1] : 0; }
			return out;
		}
	};
}
