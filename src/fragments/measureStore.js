// src/fragments/measureStore.js
//==========================================================
// measureFragmentsOnStore: measureFragments for a fragments run on a
// tile store (findFragmentsParallel(store, { column })), reading only
// the nodes an edit needs and never the whole cloud. The labels are
// the store's column as the run (or the last edit) left it; changes are
// the edit, applied here in memory (0 fines, FRAGMENT_REMOVED out of the
// analysis, else a rock id): measure first, then write the same changes
// to the column. box is the plan region the edit lives in: every point
// of the asked rocks, before and after, and every changed point (the
// runs give each rock its box; add the edit shape's). The nodes meeting
// it, widened to whole cells of the run's grid, are read once: the
// asked rocks' points are measured as the run measures (watershed rocks
// facing up on 2 cells, facet rocks facing out of the pile of the
// points round them, on the run's outline cell), and the areas move by
// what the edit does to those cells (each cell before and after: holding
// a kept point, holding a rock point), from the areas passed in. Rocks
// not asked are taken as rocks; an asked one under minPoints comes back
// small and counts as fines. Without box (and without areas) the whole
// store is read, a node at a time, and the areas counted afresh.
// Positions are in the run's frame (measure.origin), Float32, as the
// run's tiles read them.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { storeNodes, nodesMeeting } from "../tiles/region.js";
import { fragmentAxes } from "./axes.js";
import { facetOutline } from "../facets/outline.js";
import { pileNormals } from "./pileNormals.js";
import { SHEET_CB } from "./resolution.js";
import { FRAGMENT_REMOVED } from "./measure.js";

var METHODS = { facets: 1, watershed: 1, hybrid: 1 }, AXES = ["x", "y", "z"], EDGE = 0.5;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function pos(v) { return typeof v === "number" && v > 0 && isFinite(v); }
function removed(v) { return v === FRAGMENT_REMOVED; }

/**
 * Measure an edit of a store run's labels as the run measures (see the banner).
 * @param {object} store - the open TileStore the run labelled.
 * @param {{column: string, measure: object, ids: number[], changes?: Array<{selection: {tiles: object}, label: number}>,
 *   box?: number[], areas?: {surfaceArea: number, unassignedArea: number}, from?: object|Map|function(number): string,
 *   onProgress?: function(number, number), signal?: AbortSignal}} opts - column: the run's label column; measure: the
 *   run result's; ids: the rocks to measure; changes: the edit, each a store selection ({ tiles: { key: indices } }, as
 *   selectPolygon gives) and the label its points take, in order, on the column's labels; box: [u0, u1, v0, v1], world,
 *   on measure.areas.axes, holding every point of the asked rocks before and after and every changed point; areas: the
 *   run's (or the last edit's) surfaceArea and unassignedArea, needed with box; from: each rock's kind in a hybrid
 *   ("watershed", the default, or "facets"); onProgress(done, total); signal (rejects with ABORTED).
 * @returns {Promise<{fragments: object[], gone: number[], tooSmall: number[], surfaceArea: number, unassignedArea: number}>}
 *   fragments: per asked id holding points, in the order asked, as measureFragments gives them plus box ([u0, u1, v0, v1],
 *   world); gone: asked ids holding no point (in box); tooSmall: asked ids under minPoints; the areas after the edit.
 * @throws {LasError} INVALID_ARGUMENT naming the bad input (a changed point outside box among them); ABORTED.
 */
export async function measureFragmentsOnStore(store, opts) {
	if (!store || !store.manifest || typeof store.readTile !== "function") throw bad("measureFragmentsOnStore needs an open tile store");
	if (!opts || typeof opts !== "object") throw bad("measureFragmentsOnStore needs options: { column, measure, ids, … }");
	var ms = opts.measure, G = ms && ms.areas;
	if (!ms || typeof ms !== "object" || !METHODS[ms.method]) throw bad("measure must be the store run result's measure field ({ method, … })");
	if (!G || !G.world || !ms.origin) throw bad("measure is from a run on columns in memory: use measureFragments");
	var col = opts.column;
	if (typeof col !== "string" || !store.manifest.columns.some(function (c) { return c.name === col && c.type === "u32"; })) throw bad("column must name the run's u32 label column, not " + JSON.stringify(col));
	if (!Array.isArray(opts.ids) && !ArrayBuffer.isView(opts.ids)) throw bad("ids must be an array of the rock ids to measure");
	var ids = [], seen = new Set();
	Array.from(opts.ids).forEach(function (id) {
		if (!(Number.isInteger(id) && id > 0) || removed(id)) throw bad("ids must be rock ids (whole numbers above 0), not " + JSON.stringify(id));
		if (!seen.has(id)) { seen.add(id); ids.push(id); }
	});
	var prev = opts.areas;
	if (prev !== undefined && !(prev && isFinite(prev.surfaceArea) && isFinite(prev.unassignedArea))) throw bad("areas must be { surfaceArea, unassignedArea }: the run's or the last edit's");
	if (opts.box !== undefined && prev === undefined) throw bad("areas (the run's or the last edit's) are needed with box: only the cells in box are counted");
	if (opts.onProgress !== undefined && typeof opts.onProgress !== "function") throw bad("onProgress must be a function");
	var signal = opts.signal, prog = opts.onProgress, method = ms.method, minPoints = ms.minPoints;
	function stop() { if (signal && signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "the measuring was stopped"); }
	stop();
	function kindOf(id) {
		if (method !== "hybrid") return method === "facets" ? "facets" : "watershed";
		var f = opts.from, v = typeof f === "function" ? f(id) : f instanceof Map ? f.get(id) : f ? f[id] : undefined;
		if (v === undefined || v === null) return "watershed";
		if (v !== "watershed" && v !== "facets") throw bad("from must say \"watershed\" or \"facets\" for rock " + id + ", not " + JSON.stringify(v));
		return v;
	}

	// the cells read: box widened to whole cells, or the whole grid
	var px = G.px, ax = G.axes, o = [ms.origin.x, ms.origin.y, ms.origin.z], ou = o[ax[0]], ov = o[ax[1]];
	var cu0 = 0, cu1 = G.W - 1, cv0 = 0, cv1 = G.H - 1, b = opts.box;
	if (b !== undefined) {
		if (!(Array.isArray(b) && b.length === 4 && b.every(function (v) { return typeof v === "number" && isFinite(v); }) && b[1] >= b[0] && b[3] >= b[2])) throw bad("box must be [u0, u1, v0, v1], world, on measure.areas.axes, not " + JSON.stringify(b));
		cu0 = Math.max(0, Math.floor((b[0] - G.u0) / px)); cu1 = Math.min(G.W - 1, Math.floor((b[1] - G.u0) / px));
		cv0 = Math.max(0, Math.floor((b[2] - G.v0) / px)); cv1 = Math.min(G.H - 1, Math.floor((b[3] - G.v0) / px));
	}
	var WW = Math.max(0, cu1 - cu0 + 1), WH = Math.max(0, cv1 - cv0 + 1);
	var ebox = [G.u0 + cu0 * px, G.u0 + (cu1 + 1) * px, G.v0 + cv0 * px, G.v0 + (cv1 + 1) * px];
	var nodes = storeNodes(store.manifest), which = [], i;
	if (b !== undefined) which = WW && WH ? nodesMeeting(nodes, ax, ebox) : [];
	else for (i = 0; i < nodes.keys.length; i++) which.push(i);

	// the edit, by node: its points' new labels, in order
	var change = new Map(), place = new Map();
	nodes.keys.forEach(function (k, q) { place.set(k, q); });
	(opts.changes || []).forEach(function (c, ci) {
		if (!c || !c.selection || !c.selection.tiles || typeof c.selection.tiles !== "object") throw bad("changes[" + ci + "] must be { selection: { tiles: { key: indices } }, label }");
		var lab = c.label;
		if (!(Number.isInteger(lab) && lab >= 0 && lab <= FRAGMENT_REMOVED)) throw bad("changes[" + ci + "].label must be 0, FRAGMENT_REMOVED or a rock id, not " + JSON.stringify(lab));
		Object.keys(c.selection.tiles).forEach(function (k) {
			if (!place.has(k)) throw bad("changes[" + ci + "] names node " + k + ", not one of the store's");
			(change.get(k) || change.set(k, []).get(k)).push([c.selection.tiles[k], lab]);
		});
	});
	var reading = new Set(which.map(function (q) { return nodes.keys[q]; }));
	change.forEach(function (list, k) { if (!reading.has(k)) throw bad("a changed point (node " + k + ") is outside box: box must hold every changed point"); });

	var total = 0, done = 0, last = -1;
	which.forEach(function (q) { total += nodes.counts[q]; });
	function tick(d) { if (prog && (d >= total || d - last >= Math.max(1, total / 100))) { last = d; prog(Math.min(d, total), total); } }
	tick(0);

	// each node read once: the cells' states before and after (bits: 1 kept point before, 2 rock point before, 4 kept
	// point after, 8 rock point after), and the asked rocks' points
	var st = new Uint8Array(WW * WH), want = new Map();
	ids.forEach(function (id) { want.set(id, { x: [], y: [], z: [], cell: [], node: [], index: [] }); });
	function labelsOf(k, lab) {
		var list = change.get(k);
		if (!list) return { after: lab, flag: null };
		var after = Uint32Array.from(lab), flag = new Uint8Array(lab.length);
		list.forEach(function (e) {
			var idx = e[0];
			for (var j = 0; j < idx.length; j++) { var p = idx[j]; if (!(p >= 0 && p < lab.length)) throw bad("a change names point " + p + " of node " + k + ", which holds " + lab.length); after[p] = e[1]; flag[p] = 1; }
		});
		return { after: after, flag: flag };
	}
	for (var w = 0; w < which.length; w++) {
		stop();
		var q = which[w], key = nodes.keys[q];
		var pts = await store.readTile(key, { fields: ["x", "y", "z", col], localOrigin: ms.origin, float32: true });
		var lab = pts[col], L = labelsOf(key, lab), after = L.after, flag = L.flag, U = pts[AXES[ax[0]]], V = pts[AXES[ax[1]]];
		for (i = 0; i < pts.count; i++) {
			var fu = (U[i] + ou - G.u0) / px, fv = (V[i] + ov - G.v0) / px, gu = Math.floor(fu), gv = Math.floor(fv);
			// a hair outside the grid (Float32) goes in the edge cell
			if (gu < 0 && fu >= -EDGE) gu = 0; else if (gu >= G.W && fu < G.W + EDGE) gu = G.W - 1;
			if (gv < 0 && fv >= -EDGE) gv = 0; else if (gv >= G.H && fv < G.H + EDGE) gv = G.H - 1;
			if (gu < cu0 || gu > cu1 || gv < cv0 || gv > cv1) {
				if (flag && flag[i]) throw bad("changed point " + i + " of node " + key + " is outside box: box must hold every changed point");
				continue;
			}
			var g = (gv - cv0) * WW + (gu - cu0), bl = lab[i], al = after[i];
			if (!removed(bl)) { st[g] |= 1; if (bl) st[g] |= 2; }
			if (!removed(al)) {
				st[g] |= 4;
				if (al) {
					var r = want.get(al);
					if (r) { r.x.push(pts.x[i]); r.y.push(pts.y[i]); r.z.push(pts.z[i]); r.cell.push(g); r.node.push(q); r.index.push(i); }
					else st[g] |= 8;
				}
			}
		}
		done += nodes.counts[q]; tick(done);
	}
	// an asked rock under minPoints is fines; else its cells hold a rock point
	ids.forEach(function (id) { var r = want.get(id); if (r.x.length >= minPoints) for (var j = 0; j < r.cell.length; j++) st[r.cell[j]] |= 8; });
	var bh = 0, bn = 0, ah = 0, an = 0;
	for (i = 0; i < st.length; i++) {
		var s = st[i];
		if (s & 1) { bh++; if (!(s & 2)) bn++; }
		if (s & 4) { ah++; if (!(s & 8)) an++; }
	}
	var surfaceArea, unassignedArea;
	if (prev) { surfaceArea = prev.surfaceArea + (ah - bh) * px * px; unassignedArea = prev.unassignedArea + (an - bn) * px * px; }
	else { surfaceArea = ah * px * px; unassignedArea = an * px * px; }

	// the facet rocks' pile: the points round them (2 pile cells), in no watershed rock for a hybrid
	var pile = null;
	async function pileOf(facetIds) {
		if (!pos(ms.surfaceDistance)) throw bad("measure.surfaceDistance is missing: measure is not from a run that found facet rocks");
		var sd = ms.surfaceDistance, pb = [Infinity, -Infinity, Infinity, -Infinity];
		facetIds.forEach(function (id) {
			var r = want.get(id), U2 = r[AXES[ax[0]]], V2 = r[AXES[ax[1]]];
			for (var j = 0; j < U2.length; j++) { var u = U2[j] + ou, v = V2[j] + ov; if (u < pb[0]) pb[0] = u; if (u > pb[1]) pb[1] = u; if (v < pb[2]) pb[2] = v; if (v > pb[3]) pb[3] = v; }
		});
		pb = [pb[0] - 2 * sd, pb[1] + 2 * sd, pb[2] - 2 * sd, pb[3] + 2 * sd];
		var kinds = new Map(), x = [], y = [], z = [], at = new Map();
		var near = nodesMeeting(nodes, ax, pb);
		for (var n2 = 0; n2 < near.length; n2++) {
			stop();
			var q2 = near[n2], k2 = nodes.keys[q2];
			var p2 = await store.readTile(k2, { fields: ["x", "y", "z", col], localOrigin: ms.origin, float32: true });
			var aft = labelsOf(k2, p2[col]).after, U3 = p2[AXES[ax[0]]], V3 = p2[AXES[ax[1]]], map = new Int32Array(p2.count).fill(-1);
			for (var j2 = 0; j2 < p2.count; j2++) {
				var u3 = U3[j2] + ou, v3 = V3[j2] + ov;
				if (u3 < pb[0] || u3 > pb[1] || v3 < pb[2] || v3 > pb[3]) continue;
				var l3 = aft[j2], keep = !l3 || removed(l3) || method !== "hybrid";
				if (!keep) { var kd = kinds.get(l3); if (kd === undefined) { kd = kindOf(l3); kinds.set(l3, kd); } keep = kd === "facets"; }
				if (!keep) continue;
				map[j2] = x.length; x.push(p2.x[j2]); y.push(p2.y[j2]); z.push(p2.z[j2]);
			}
			at.set(q2, map);
		}
		var rc = { count: x.length, x: Float32Array.from(x), y: Float32Array.from(y), z: Float32Array.from(z) };
		return { p: pileNormals(rc, { cellSize: sd, viewpoint: ms.viewpoint || undefined }), at: at };
	}

	// the asked rocks, measured
	var facetIds = ids.filter(function (id) { return want.get(id).x.length && kindOf(id) === "facets"; });
	if (facetIds.length) {
		ids.forEach(function (id) { var r = want.get(id); r.x = Float32Array.from(r.x); r.y = Float32Array.from(r.y); r.z = Float32Array.from(r.z); });
		pile = await pileOf(facetIds);
	}
	var fragments = [], gone = [];
	ids.forEach(function (id) {
		stop();
		var r = want.get(id), m = r.x.length;
		if (!m) { gone.push(id); return; }
		var X = r.x instanceof Float32Array ? r.x : Float32Array.from(r.x), Y = r.y instanceof Float32Array ? r.y : Float32Array.from(r.y), Z = r.z instanceof Float32Array ? r.z : Float32Array.from(r.z);
		var pts = new Uint32Array(m);
		for (var j = 0; j < m; j++) pts[j] = j;
		var axs = fragmentAxes(X, Y, Z, 1, pts), nrm = axs.smallest, kind = kindOf(id), cell;
		if (kind === "watershed") {
			if (!pos(ms.cell)) throw bad("measure.cell is missing: measure is not from a run with watershed rocks");
			if (nrm[2] < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
			cell = 2 * ms.cell;
		} else {
			if (!pos(ms.outlineCell)) throw bad("measure.outlineCell is missing: measure is not from a run with facet rocks");
			var PN = pile.p.normal, cellOf = pile.p.cellOf, sx = 0, sy = 0, sz = 0;
			for (j = 0; j < m; j++) {
				var map = pile.at.get(r.node[j]), pi = map ? map[r.index[j]] : -1;
				if (pi < 0) throw bad("rock " + id + " is a facet rock holding a point of a watershed rock");
				var pc = cellOf[pi]; sx += PN[3 * pc]; sy += PN[3 * pc + 1]; sz += PN[3 * pc + 2];
			}
			var sgn = nrm[0] * sx + nrm[1] * sy + nrm[2] * sz < 0 ? -1 : 1;
			nrm = [sgn * nrm[0], sgn * nrm[1], sgn * nrm[2]];
			cell = ms.outlineCell;
		}
		var shape = facetOutline(X, Y, Z, 1, pts, axs.centroid, nrm, cell);
		var U4 = [X, Y, Z][ax[0]], V4 = [X, Y, Z][ax[1]], bx = [Infinity, -Infinity, Infinity, -Infinity];
		for (j = 0; j < m; j++) { var u4 = U4[j] + ou, v4 = V4[j] + ov; if (u4 < bx[0]) bx[0] = u4; if (u4 > bx[1]) bx[1] = u4; if (v4 < bx[2]) bx[2] = v4; if (v4 > bx[3]) bx[3] = v4; }
		var f = { id: id, count: m, centroid: axs.centroid, normal: nrm, axes: axs.axes, size: axs.axes[1], area: shape.area, outline: shape.outline,
			sheet: !(axs.axes[1] > 0) || axs.axes[2] / axs.axes[1] < SHEET_CB, small: m < minPoints, box: bx };
		if (method === "hybrid") f.from = kind;
		fragments.push(f);
	});
	tick(total);
	var tooSmall = fragments.filter(function (f) { return f.small; }).map(function (f) { return f.id; });
	return { fragments: fragments, gone: gone, tooSmall: tooSmall, surfaceArea: surfaceArea, unassignedArea: unassignedArea };
}
