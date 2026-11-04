// src/fragments/measure.js
//==========================================================
// measureFragments: measure a labelling of a cloud's points as the run
// that made it measured its fragments, so a rock edited by hand (made,
// split, merged, sent to fines or taken out of the analysis) is sized
// exactly as a found one. Every findFragments / findFragmentsParallel
// result carries `measure`, the few numbers its measuring used; pass it
// back with the labels (0 fines, FRAGMENT_REMOVED out of the analysis,
// any other value a rock id, kept as given).
//
// A rock is measured as its kind was in the run: a watershed rock
// (method watershed, or from "watershed" in a hybrid) by its PCA spans
// with the normal facing up and its outline on a grid of 2 cells; a
// facet rock with the normal facing out of the pile (pileNormals at the
// run's surfaceDistance and viewpoint; in a hybrid, the pile of the
// points in no watershed rock, as the run took it) and its outline on
// the run's outlineCell. The areas are the run's: per pile cell on its
// plane for the facets method, else plan cells of the run's grid.
// Removed points count in neither area, but stay in the pile's shape.
// A rock under the run's minPoints comes back measured and small: true,
// and counts as fines in the areas.
//
// Exact on findFragments: measuring a run's own labelling gives back its
// fragments and areas. On findFragmentsParallel the areas and watershed
// rocks are exact; each tile measured its own facet rocks (its own pile
// and outline cell), so a facet rock re-measured on the whole cloud
// agrees closely, not to the last digit.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf } from "../index/grid.js";
import { fragmentAxes } from "./axes.js";
import { facetOutline } from "../facets/outline.js";
import { pileNormals } from "./pileNormals.js";
import { SHEET_CB } from "./resolution.js";

/** The label of a point taken out of the analysis: in no rock and in neither area. */
export var FRAGMENT_REMOVED = 4294967295;

var METHODS = { facets: 1, watershed: 1, hybrid: 1 }, CHECK = 65536;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function pos(v) { return typeof v === "number" && v > 0 && isFinite(v); }

/**
 * Measure a labelling as the run that `measure` came from measures its fragments.
 * @param {object} cols - the run's point columns (the same points, in the same order).
 * @param {ArrayLike<number>} label - per point: 0 fines, FRAGMENT_REMOVED (or -1) out of the analysis, else a rock id
 *   (a whole number, kept as given).
 * @param {{measure: object, ids?: number[], from?: object|Map|function(number): string,
 *   onProgress?: function(number, number), signal?: AbortSignal}} opts - measure: the run result's measure field;
 *   ids: the rocks to measure (default every id in label); from: each rock's kind in a hybrid, "watershed" or
 *   "facets" (an object or Map by id, or a function; default "watershed"); every rock's kind matters for the
 *   pile when a facet rock is measured. onProgress(done, total); signal: an AbortSignal (rejects with ABORTED).
 * @returns {{fragments: object[], gone: number[], tooSmall: number[], surfaceArea: number, unassignedArea: number}}
 *   fragments: per asked id holding points, in the order asked, { id, count, centroid, normal, axes, size, area,
 *   outline, sheet, small } (and from in a hybrid); gone: asked ids holding no point; tooSmall: asked ids under
 *   minPoints; the areas for the whole labelling, every rock under minPoints (asked or not) counted as fines.
 * @throws {LasError} INVALID_ARGUMENT naming the bad input; ABORTED when the signal fires.
 */
export function measureFragments(cols, label, opts) {
	if (!opts || typeof opts !== "object") throw bad("measureFragments needs options: { measure } from the run's result");
	var ms = opts.measure;
	if (!ms || typeof ms !== "object" || !METHODS[ms.method]) throw bad("measure must be the run result's measure field ({ method, … })");
	var n = cols && cols.count;
	if (!Number.isInteger(n) || n < 0) throw bad("cols must be point columns with a count");
	if (!label || label.length !== n) throw bad("label must hold one value a point (" + n + "), not " + (label ? label.length : label));
	if (opts.onProgress !== undefined && typeof opts.onProgress !== "function") throw bad("onProgress must be a function");
	var signal = opts.signal, prog = opts.onProgress, method = ms.method, minPoints = ms.minPoints;
	var co = n ? coordsOf(cols, "measureFragments") : { x: [], y: [], z: [], stride: 1 }, X = co.x, Y = co.y, Z = co.z, st = co.stride, i, k;
	function stop() { if (signal && signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "the measuring was stopped"); }
	stop();
	function removed(v) { return v === FRAGMENT_REMOVED || v === -1; }
	function kindOf(id) {
		if (method !== "hybrid") return method === "facets" ? "facets" : "watershed";
		var f = opts.from, v = typeof f === "function" ? f(id) : f instanceof Map ? f.get(id) : f ? f[id] : undefined;
		if (v === undefined || v === null) return "watershed";
		if (v !== "watershed" && v !== "facets") throw bad("from must say \"watershed\" or \"facets\" for rock " + id + ", not " + JSON.stringify(v));
		return v;
	}

	// 1. each rock's points
	var count = new Map();
	for (i = 0; i < n; i++) {
		var v = label[i];
		if (!v || removed(v)) continue;
		if (!(Number.isInteger(v) && v > 0)) throw bad("label " + JSON.stringify(v) + " at point " + i + " is not 0, FRAGMENT_REMOVED or a rock id");
		count.set(v, (count.get(v) || 0) + 1);
		if ((i & (CHECK - 1)) === 0) stop();
	}
	var ids = opts.ids === undefined ? Array.from(count.keys()).sort(function (a, b) { return a - b; }) : opts.ids;
	if (!Array.isArray(ids) && !ArrayBuffer.isView(ids)) throw bad("ids must be an array of rock ids");
	var want = new Map(), gone = [], asked = [];
	Array.from(ids).forEach(function (id) {
		if (!(Number.isInteger(id) && id > 0) || removed(id)) throw bad("ids must be rock ids (whole numbers above 0), not " + JSON.stringify(id));
		if (want.has(id) || gone.indexOf(id) >= 0) return;
		var c = count.get(id) || 0;
		if (!c) { gone.push(id); return; }
		want.set(id, { pts: new Uint32Array(c), at: 0 }); asked.push(id);
	});
	var work = 0, total = n, last = -1;
	want.forEach(function (w) { total += w.pts.length; });
	total += n;
	function tick(d) { if (prog && (d === total || d - last >= Math.max(1, total / 100))) { last = d; prog(d, total); } }
	if (want.size) for (i = 0; i < n; i++) { var w0 = want.get(label[i]); if (w0) w0.pts[w0.at++] = i; }
	work = n; tick(work);

	// 2. the piles a facet rock is oriented by (built when one is measured, or for the facets method's areas)
	var pile = null;
	function pileOf() {
		if (pile) return pile;
		if (!pos(ms.surfaceDistance)) throw bad("measure.surfaceDistance is missing: measure is not from a findFragments run that found facet rocks");
		var vp = ms.viewpoint || undefined;
		if (method !== "hybrid") { pile = { p: pileNormals(cols, { cellSize: ms.surfaceDistance, viewpoint: vp }), at: null }; return pile; }
		// a hybrid's facet rocks face out of the pile of the points in no watershed rock
		var kinds = new Map(), rest = [];
		for (i = 0; i < n; i++) {
			var l = label[i], keep = !l || removed(l);
			if (!keep) { var kd = kinds.get(l); if (kd === undefined) { kd = kindOf(l); kinds.set(l, kd); } keep = kd === "facets"; }
			if (keep) rest.push(i);
		}
		var Arr = X instanceof Float32Array ? Float32Array : Float64Array, m = rest.length, rc = { count: m, x: new Arr(m), y: new Arr(m), z: new Arr(m) }, at = new Int32Array(n).fill(-1);
		for (var j = 0; j < m; j++) { var o = rest[j] * st; rc.x[j] = X[o]; rc.y[j] = Y[o]; rc.z[j] = Z[o]; at[rest[j]] = j; }
		pile = { p: pileNormals(rc, { cellSize: ms.surfaceDistance, viewpoint: vp }), at: at };
		return pile;
	}

	// 3. the rocks
	var fragments = asked.map(function (id) {
		stop();
		var pts = want.get(id).pts, ax = fragmentAxes(X, Y, Z, st, pts), nrm = ax.smallest, kind = kindOf(id), cell;
		if (kind === "watershed") {
			if (!pos(ms.cell)) throw bad("measure.cell is missing: measure is not from a run with watershed rocks");
			if (nrm[2] < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
			cell = 2 * ms.cell;
		} else {
			if (!pos(ms.outlineCell)) throw bad("measure.outlineCell is missing: measure is not from a run with facet rocks");
			var pl = pileOf(), PN = pl.p.normal, cellOf = pl.p.cellOf, sx = 0, sy = 0, sz = 0;
			for (k = 0; k < pts.length; k++) {
				var r = pl.at ? pl.at[pts[k]] : pts[k];
				if (r < 0) throw bad("rock " + id + " is a facet rock holding a point of a watershed rock");
				var pc = cellOf[r]; sx += PN[3 * pc]; sy += PN[3 * pc + 1]; sz += PN[3 * pc + 2];
			}
			var sgn = nrm[0] * sx + nrm[1] * sy + nrm[2] * sz < 0 ? -1 : 1;
			nrm = [sgn * nrm[0], sgn * nrm[1], sgn * nrm[2]];
			cell = ms.outlineCell;
		}
		var shape = facetOutline(X, Y, Z, st, pts, ax.centroid, nrm, cell);
		var f = { id: id, count: pts.length, centroid: ax.centroid, normal: nrm, axes: ax.axes, size: ax.axes[1], area: shape.area, outline: shape.outline,
			sheet: !(ax.axes[1] > 0) || ax.axes[2] / ax.axes[1] < SHEET_CB, small: pts.length < minPoints };
		if (method === "hybrid") f.from = kind;
		work += pts.length; tick(work);
		return f;
	});

	// 4. the areas: a rock under minPoints is fines; removed points count in neither
	function rock(v) { return v && !removed(v) && !(count.get(v) < minPoints); }
	var surfaceArea = 0, unassignedArea = 0, A = ms.areas;
	if (A === "pile") {
		var pp = pileOf().p, PN2 = pp.normal, cells = pp.cells, start = new Uint32Array(cells + 1), order = new Uint32Array(n), c;
		for (i = 0; i < n; i++) start[pp.cellOf[i] + 1]++;
		for (c = 0; c < cells; c++) start[c + 1] += start[c];
		var put = start.slice(0, cells);
		for (i = 0; i < n; i++) order[put[pp.cellOf[i]]++] = i;
		for (c = 0; c < cells; c++) {
			if ((c & 255) === 0) stop();
			var kept = [], z0 = 0;
			for (k = start[c]; k < start[c + 1]; k++) { var q = order[k]; if (removed(label[q])) continue; kept.push(q); if (!rock(label[q])) z0++; }
			if (!kept.length) continue;
			var ca = facetOutline(X, Y, Z, st, Uint32Array.from(kept), [pp.centroid[3 * c], pp.centroid[3 * c + 1], pp.centroid[3 * c + 2]], [PN2[3 * c], PN2[3 * c + 1], PN2[3 * c + 2]], ms.outlineCell).area;
			surfaceArea += ca; unassignedArea += ca * z0 / kept.length;
		}
	} else if (A && typeof A === "object") {
		var ax0 = A.axes || [0, 1], U = [X, Y, Z][ax0[0]], V = [X, Y, Z][ax0[1]], px = A.px, GW = A.W, GH = A.H;
		if (!pos(px) || !(GW > 0) || !(GH > 0)) throw bad("measure.areas must be the run's grid { px, u0, v0, W, H, axes }");
		var hit = new Uint8Array(GW * GH), held = new Uint8Array(GW * GH), nc = 0, none = 0;
		for (i = 0; i < n; i++) {
			if (removed(label[i])) continue;
			var gu = Math.floor((U[i * st] - A.u0) / px), gv = Math.floor((V[i * st] - A.v0) / px);
			if (gu < 0 || gu >= GW || gv < 0 || gv >= GH) throw bad("point " + i + " is outside the run's grid: these are not the run's points");
			var g = gv * GW + gu;
			hit[g] = 1; if (rock(label[i])) held[g] = 1;
			if ((i & (CHECK - 1)) === 0) stop();
		}
		for (k = 0; k < hit.length; k++) if (hit[k]) { nc++; if (!held[k]) none++; }
		surfaceArea = nc * px * px; unassignedArea = none * px * px;
	}
	tick(total);
	var tooSmall = fragments.filter(function (f) { return f.small; }).map(function (f) { return f.id; });
	return { fragments: fragments, gone: gone, tooSmall: tooSmall, surfaceArea: surfaceArea, unassignedArea: unassignedArea };
}
