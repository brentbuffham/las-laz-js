// src/ops/doubleLayer.js
//==========================================================
// Double layers: a surface scanned or matched twice, so a second sheet
// lies a little above or below the real one (ODM does it where two image
// sets disagree). The points go into XY cells; in a cell the heights
// split into layers wherever they jump by more than minGap, and a layer
// of at least minPoints points counts. A cell with two or more layers
// keeps one (the larger, the upper or the lower) and the others are
// ghosts. The offset from the kept layer is each cell's weighted mean,
// smoothed over the cells around it, so a sheet that drifts away is
// followed. snapToLayer then moves the ghost points by it.
// A ghost is a sheet over an area, not a rock: a double cell counts only
// when it joins its neighbours into a patch of at least minArea square
// metres, and two neighbours join only when their offsets agree within
// coherence. A sparse ghost leaves holes in its sheet, so double cells up
// to bridge metres apart join too (the offsets may then differ by
// coherence for every cell of the way). A boulder's top is a double cell on
// its own, and boulders beside each other stand at different heights, so
// neither forms a patch.
// Layers are vertical: this is for terrain, benches and floors, not for
// a face that stands near upright.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf, checkPointCount } from "../index/grid.js";
import { countOf, columnsOf } from "./columns.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

var HALF = 33554432;       // 2^25: a cell index is kept within +-HALF
var SPAN = 67108864;       // 2^26: the key's second part

function positive(v, name) {
	if (!(typeof v === "number" && v > 0 && isFinite(v))) throw bad("selectDoubleLayer " + name + " must be a positive finite number, not " + String(v));
}

function percentile(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))] : NaN; }

/**
 * Find the ghost layer of a surface scanned twice.
 * @param {object} cols - point columns with x, y, z, or a k = 3 positions column.
 * @param {{cell: number, minGap: number, maxGap?: number, keep?: string, minPoints?: number, smooth?: number,
 *   anchor?: {x: number, y: number}, minArea?: number, coherence?: number, bridge?: number}} opts - cell: XY cell size (required, about 1-2 point spacings); minGap: the
 *   vertical jump that starts a new layer (required); maxGap (default no limit): a layer further than this from the
 *   kept one is not a ghost (a real overhang); keep: "auto" (default; the layer with most points, the upper on a tie),
 *   "upper" or "lower"; minPoints (default 5): a smaller layer is ignored; smooth (default 1): rings of cells the offset
 *   is averaged over (0: none); anchor: the grid's corner, so separate runs share one grid (default the data's minimum);
 *   minArea (default 0, off): a patch of double cells smaller than this many square metres is not a ghost (rocks, single
 *   cells); coherence (default minGap / 4): the most two neighbouring double cells' offsets may differ and still be one
 *   patch (a sheet follows the surface at a steady offset; rocks do not); bridge (default 0: touching cells only): double
 *   cells up to this many metres apart join into one patch, for a ghost whose sheet has holes (the offsets of two such
 *   cells may differ by coherence for each cell of the distance).
 * @returns {{selection: Uint32Array, dz: Float64Array, dominantZ: Float64Array, partner: {selection: Uint32Array, dz: Float64Array},
 *   stats: object}} selection: the ghost points; dz: what to add to each one's z to land on the kept layer;
 *   dominantZ: the kept layer's median height in each one's cell; partner: the kept-layer points in cells that have a
 *   ghost, with dz the offset from the ghost to them (for the average mode of snapToLayer, which moves them too);
 *   stats: selected, kept, cellsTotal, cellsDouble, cellsDropped (double cells in patches under minArea), and min, p05, median, p95, max of dz.
 */
export function selectDoubleLayer(cols, opts) {
	var o = opts || {};
	positive(o.cell, "cell"); positive(o.minGap, "minGap");
	var maxGap = o.maxGap === undefined ? Infinity : o.maxGap;
	if (!(typeof maxGap === "number" && maxGap >= o.minGap)) throw bad("selectDoubleLayer maxGap must be a number >= minGap, not " + String(o.maxGap));
	var keep = o.keep === undefined ? "auto" : o.keep;
	if (keep !== "auto" && keep !== "upper" && keep !== "lower") throw bad("selectDoubleLayer keep must be \"auto\", \"upper\" or \"lower\", not " + JSON.stringify(o.keep));
	var minPoints = o.minPoints === undefined ? 5 : o.minPoints;
	if (!(Number.isInteger(minPoints) && minPoints >= 1)) throw bad("selectDoubleLayer minPoints must be a whole number >= 1, not " + String(o.minPoints));
	var smooth = o.smooth === undefined ? 1 : o.smooth;
	if (!(Number.isInteger(smooth) && smooth >= 0)) throw bad("selectDoubleLayer smooth must be a whole number >= 0, not " + String(o.smooth));
	if (o.anchor !== undefined && !(o.anchor && isFinite(o.anchor.x) && isFinite(o.anchor.y))) throw bad("selectDoubleLayer anchor must be { x, y }");
	var minArea = o.minArea === undefined ? 0 : o.minArea;
	if (!(typeof minArea === "number" && minArea >= 0 && isFinite(minArea))) throw bad("selectDoubleLayer minArea must be a number >= 0 (square metres), not " + String(o.minArea));
	var coherence = o.coherence === undefined ? o.minGap / 4 : o.coherence;
	if (!(typeof coherence === "number" && coherence > 0 && isFinite(coherence))) throw bad("selectDoubleLayer coherence must be a positive finite number, not " + String(o.coherence));

	var bridge = o.bridge === undefined ? 0 : o.bridge;
	if (!(typeof bridge === "number" && bridge >= 0 && isFinite(bridge))) throw bad("selectDoubleLayer bridge must be a number >= 0 (metres), not " + String(o.bridge));

	var coords = coordsOf(cols, "selectDoubleLayer"), n = cols.count;
	checkPointCount(n);
	var X = coords.x, Y = coords.y, Z = coords.z, st = coords.stride, cell = o.cell, inv = 1 / cell;
	var empty = { selection: new Uint32Array(0), dz: new Float64Array(0), dominantZ: new Float64Array(0),
		partner: { selection: new Uint32Array(0), dz: new Float64Array(0) },
		stats: { selected: 0, kept: 0, cellsTotal: 0, cellsDouble: 0, cellsDropped: 0, min: NaN, p05: NaN, median: NaN, p95: NaN, max: NaN } };
	if (n === 0) return empty;

	var x0, y0, i;
	if (o.anchor) { x0 = o.anchor.x; y0 = o.anchor.y; }
	else {
		x0 = Infinity; y0 = Infinity;
		for (i = 0; i < n; i++) { var qx = X[i * st], qy = Y[i * st]; if (qx < x0) x0 = qx; if (qy < y0) y0 = qy; }
	}

	// a cell for every point
	var slotOf = new Int32Array(n), map = new Map(), counts = [], cxs = [], cys = [];
	for (i = 0; i < n; i++) {
		var cx = Math.floor((X[i * st] - x0) * inv), cy = Math.floor((Y[i * st] - y0) * inv);
		if (!(cx > -HALF && cx < HALF && cy > -HALF && cy < HALF)) throw bad("selectDoubleLayer cell " + cell + " is too small for the extent of the points");
		var key = (cx + HALF) * SPAN + (cy + HALF), s = map.get(key);
		if (s === undefined) { s = counts.length; map.set(key, s); counts.push(0); cxs.push(cx); cys.push(cy); }
		slotOf[i] = s; counts[s]++;
	}
	var cells = counts.length, start = new Uint32Array(cells + 1);
	for (var c = 0; c < cells; c++) start[c + 1] = start[c] + counts[c];
	var fill = start.slice(0, cells), order = new Uint32Array(n);
	for (i = 0; i < n; i++) order[fill[slotOf[i]]++] = i;

	var roles = new Uint8Array(n);                         // 1 ghost, 2 kept layer of a double cell
	var off = new Float64Array(cells).fill(NaN), weight = new Float64Array(cells), keptZ = new Float64Array(cells).fill(NaN);
	var cellsDouble = 0, byZ = function (p, q) { return Z[p * st] - Z[q * st]; };
	for (var s2 = 0; s2 < cells; s2++) {
		var a = start[s2], b = start[s2 + 1];
		if (b - a < 2 * minPoints) continue;
		var seg = order.subarray(a, b);
		seg.sort(byZ);
		var layers = [], lo = 0;                           // [lo, hi) of seg, with its median
		for (var j = 1; j <= seg.length; j++) {
			if (j === seg.length || Z[seg[j] * st] - Z[seg[j - 1] * st] > o.minGap) {
				if (j - lo >= minPoints) layers.push({ lo: lo, hi: j, med: Z[seg[(lo + j) >> 1] * st] });
				lo = j;
			}
		}
		if (layers.length < 2) continue;
		var kept = 0;
		if (keep === "upper") kept = layers.length - 1;
		else if (keep === "auto") for (var l = 1; l < layers.length; l++) if (layers[l].hi - layers[l].lo >= layers[kept].hi - layers[kept].lo) kept = l;
		var K = layers[kept], sum = 0, w = 0;
		for (var g = 0; g < layers.length; g++) {
			if (g === kept || Math.abs(K.med - layers[g].med) > maxGap) continue;
			var wg = layers[g].hi - layers[g].lo;
			sum += (K.med - layers[g].med) * wg; w += wg;
			for (var p = layers[g].lo; p < layers[g].hi; p++) roles[seg[p]] = 1;
		}
		if (!w) continue;
		for (var q = K.lo; q < K.hi; q++) roles[seg[q]] = 2;
		off[s2] = sum / w; weight[s2] = w; keptZ[s2] = K.med; cellsDouble++;
	}

	// a ghost is a sheet over an area: drop the double cells whose patch (joined across bridge, offsets within coherence) is too small
	var cellsDropped = 0, reach = Math.max(1, Math.ceil(bridge / cell - 1e-9));
	if (minArea > 0 && cellsDouble > 0) {
		var seen = new Uint8Array(cells), area = cell * cell, stack = [], members = [];
		for (var s0 = 0; s0 < cells; s0++) {
			if (seen[s0] || off[s0] !== off[s0]) continue;
			members.length = 0; stack.length = 0; stack.push(s0); seen[s0] = 1;
			while (stack.length) {
				var cur = stack.pop();
				members.push(cur);
				for (var ex = -reach; ex <= reach; ex++) {
					for (var ey = -reach; ey <= reach; ey++) {
						if (!ex && !ey) continue;
						var nb = map.get((cxs[cur] + ex + HALF) * SPAN + (cys[cur] + ey + HALF));
						if (nb === undefined || seen[nb] || off[nb] !== off[nb] || Math.abs(off[nb] - off[cur]) > coherence * Math.max(Math.abs(ex), Math.abs(ey))) continue;
						seen[nb] = 1; stack.push(nb);
					}
				}
			}
			if (members.length * area >= minArea) continue;
			for (var mi = 0; mi < members.length; mi++) {
				var dead = members[mi];
				off[dead] = NaN; cellsDouble--; cellsDropped++;
				for (var pp = start[dead]; pp < start[dead + 1]; pp++) roles[order[pp]] = 0;
			}
		}
	}

	// each double cell's offset, averaged with the double cells around it (by their ghost points)
	var field = off;
	if (smooth > 0 && cellsDouble > 1) {
		field = new Float64Array(cells).fill(NaN);
		for (var s3 = 0; s3 < cells; s3++) {
			if (off[s3] !== off[s3]) continue;
			var num = 0, den = 0;
			for (var dx = -smooth; dx <= smooth; dx++) {
				for (var dy = -smooth; dy <= smooth; dy++) {
					var t = map.get((cxs[s3] + dx + HALF) * SPAN + (cys[s3] + dy + HALF));
					if (t === undefined || off[t] !== off[t]) continue;
					num += off[t] * weight[t]; den += weight[t];
				}
			}
			field[s3] = num / den;
		}
	}

	var nGhost = 0, nKept = 0;
	for (i = 0; i < n; i++) { if (roles[i] === 1) nGhost++; else if (roles[i] === 2) nKept++; }
	var sel = new Uint32Array(nGhost), dz = new Float64Array(nGhost), dom = new Float64Array(nGhost);
	var psel = new Uint32Array(nKept), pdz = new Float64Array(nKept);
	for (i = 0, g = 0, q = 0; i < n; i++) {
		var r = roles[i];
		if (r === 1) { sel[g] = i; dz[g] = field[slotOf[i]]; dom[g] = keptZ[slotOf[i]]; g++; }
		else if (r === 2) { psel[q] = i; pdz[q] = field[slotOf[i]]; q++; }
	}
	var sorted = Float64Array.from(dz).sort();
	return { selection: sel, dz: dz, dominantZ: dom, partner: { selection: psel, dz: pdz },
		stats: { selected: nGhost, kept: nKept, cellsTotal: cells, cellsDouble: cellsDouble, cellsDropped: cellsDropped,
			min: sorted.length ? sorted[0] : NaN, p05: percentile(sorted, 0.05), median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95),
			max: sorted.length ? sorted[sorted.length - 1] : NaN } };
}

/**
 * Move the ghost points of selectDoubleLayer onto the kept layer.
 * @param {object} cols - point columns with x, y, z (k = 1) - the ones selectDoubleLayer was run on.
 * @param {object} found - selectDoubleLayer's result.
 * @param {{mode?: string, blend?: number, inPlace?: boolean}} [opts] - mode "offset" (default): add dz, keeping the
 *   ghost's own relief; "surface": set z to the kept layer's height (flattens them); "average": the ghost moves
 *   (1 - blend) of the way and the kept layer in those cells blend of the way towards it (blend default 0.5: both meet
 *   half way; 0: as "offset"). inPlace: write into the input's z array.
 * @returns {object} { count, ... }: a new z, every other column shared; or, with inPlace, the input's z, changed.
 */
export function snapToLayer(cols, found, opts) {
	var o = opts || {}, mode = o.mode === undefined ? "offset" : o.mode;
	if (mode !== "offset" && mode !== "surface" && mode !== "average") throw bad("snapToLayer mode must be \"offset\", \"surface\" or \"average\", not " + JSON.stringify(o.mode));
	var blend = o.blend === undefined ? 0.5 : o.blend;
	if (!(typeof blend === "number" && blend >= 0 && blend <= 1)) throw bad("snapToLayer blend must be a number from 0 to 1, not " + String(o.blend));
	if (!found || !found.selection || !found.dz || !found.dominantZ || !found.partner) throw bad("snapToLayer needs the result of selectDoubleLayer");
	var n = countOf(cols), list = columnsOf(cols);
	var z = cols.z;
	if (!list.some(function (c) { return c.name === "z" && c.k === 1; }) || z instanceof BigInt64Array || z instanceof BigUint64Array) throw bad("snapToLayer needs a z column (k = 1, not BigInt)");
	var sel = found.selection, psel = found.partner.selection, i;
	if ((sel.length && sel[sel.length - 1] >= n) || (psel.length && psel[psel.length - 1] >= n)) throw bad("snapToLayer: the result is for a bigger cloud than this one");
	var out = o.inPlace ? z : z.slice();
	if (mode === "surface") for (i = 0; i < sel.length; i++) out[sel[i]] = found.dominantZ[i];
	else {
		var move = mode === "average" ? 1 - blend : 1;
		for (i = 0; i < sel.length; i++) out[sel[i]] = z[sel[i]] + found.dz[i] * move;
		if (mode === "average" && blend > 0) for (i = 0; i < psel.length; i++) out[psel[i]] = z[psel[i]] - found.partner.dz[i] * blend;
	}
	var res = { count: n };
	list.forEach(function (c) { Object.defineProperty(res, c.name, { value: c.name === "z" ? out : cols[c.name], enumerable: true, writable: true, configurable: true }); });
	return res;
}

// ---------------------------------------------------------------
// Settings from the points. Inside a cell the points of one surface sit
// within a few millimetres of each other in height, so the largest empty
// stretch of heights in a cell (with a few points either side of it) is
// small on a clean surface and about the ghost's offset where a second
// sheet lies on it. doubleLayerStats counts that largest stretch per cell
// at several cell sizes; suggestDoubleLayer picks the cell from the point
// density and the gap from how big the stretches are on the ordinary
// cells, so the same call suits a 1 cm photogrammetry cloud and a 10 cm one.
// ---------------------------------------------------------------

var STAT_CELLS = [0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1];
var GAP_BINS = 48, GAP_LO = 0.0005, GAP_RATIO = Math.pow(2 / GAP_LO, 1 / GAP_BINS);
var STAT_MIN_CELL = 12, STAT_SIDE = 3, POINTS_PER_CELL = 150;

function gapBin(g) { return g < GAP_LO ? 0 : Math.min(GAP_BINS - 1, 1 + Math.floor(Math.log(g / GAP_LO) / Math.log(GAP_RATIO))); }
function binValue(b) { return b === 0 ? GAP_LO / 2 : GAP_LO * Math.pow(GAP_RATIO, b - 0.5); }

/**
 * Count, per cell size, how large the biggest gap in heights is in each cell (see suggestDoubleLayer).
 * @param {object} cols - point columns with x, y, z, or a k = 3 positions column.
 * @returns {{points: number, area: number, cells: number[], hist: Uint32Array[]}} points; area: square metres the points occupy
 *   (0.5 m cells); cells[i], hist[i]: for cell size STAT_CELLS[i], the cells with enough points and a histogram of their biggest gaps.
 *   Several results add up (addStats), for a cloud read in pieces.
 */
export function doubleLayerStats(cols) {
	var coords = coordsOf(cols, "doubleLayerStats"), n = cols.count;
	checkPointCount(n);
	var X = coords.x, Y = coords.y, Z = coords.z, st = coords.stride, i;
	var out = { points: n, area: 0, cells: STAT_CELLS.map(function () { return 0; }), hist: STAT_CELLS.map(function () { return new Uint32Array(GAP_BINS); }) };
	if (n === 0) return out;
	var x0 = Infinity, y0 = Infinity;
	for (i = 0; i < n; i++) { if (X[i * st] < x0) x0 = X[i * st]; if (Y[i * st] < y0) y0 = Y[i * st]; }
	var occ = new Set();
	for (i = 0; i < n; i++) occ.add(Math.floor((X[i * st] - x0) * 2) * 1048576 + Math.floor((Y[i * st] - y0) * 2));
	out.area = occ.size * 0.25;
	STAT_CELLS.forEach(function (cell, ci) {
		var inv = 1 / cell, map = new Map(), lists = [];
		for (var p = 0; p < n; p++) {
			var key = Math.floor((X[p * st] - x0) * inv) * 1048576 + Math.floor((Y[p * st] - y0) * inv), l = map.get(key);
			if (l === undefined) { l = []; map.set(key, l); lists.push(l); }
			l.push(Z[p * st]);
		}
		lists.forEach(function (zs) {
			if (zs.length < STAT_MIN_CELL) return;
			zs.sort(function (a, b) { return a - b; });
			var best = 0;
			for (var j = STAT_SIDE; j <= zs.length - STAT_SIDE; j++) { var g = zs[j] - zs[j - 1]; if (g > best) best = g; }
			out.cells[ci]++; out.hist[ci][gapBin(best)]++;
		});
	});
	return out;
}

/** Add doubleLayerStats results together (a cloud read in pieces). */
export function addDoubleLayerStats(list) {
	var out = { points: 0, area: 0, cells: STAT_CELLS.map(function () { return 0; }), hist: STAT_CELLS.map(function () { return new Uint32Array(GAP_BINS); }) };
	list.forEach(function (r) {
		out.points += r.points; out.area += r.area;
		r.cells.forEach(function (c, i) { out.cells[i] += c; for (var b = 0; b < GAP_BINS; b++) out.hist[i][b] += r.hist[i][b]; });
	});
	return out;
}

function histQuantile(h, total, q) {
	var need = q * total, run = 0;
	for (var b = 0; b < h.length; b++) { run += h[b]; if (run >= need) return binValue(b); }
	return binValue(h.length - 1);
}

/**
 * The selectDoubleLayer options for a cloud, worked out from its points.
 * @param {object|{points: number, area: number, cells: number[], hist: Uint32Array[]}} source - point columns, or doubleLayerStats' result
 *   (for a cloud read in pieces).
 * @param {{strength?: string}} [opts] - strength: "gentle" (a larger gap, 4 points, twice the area: only clear ghosts), "normal"
 *   (default), "thorough" (a smaller gap, 2 points, half the area: fainter ghosts, and a little real texture with them) or
 *   "aggressive" (half the gap, 2 points, a quarter of the area, a wider bridge and reach: the thin and scattered ghosts too,
 *   and more of the real texture with them; look at it with Show before fixing).
 * @returns {{ok: boolean, reason?: string, cell?: number, minGap?: number, minPoints?: number, minArea?: number, bridge?: number, maxGap?: number,
 *   density?: number, splitFraction?: number, texture?: {p25: number, p50: number, p95: number}}} ok false (with a reason) when the
 *   points are too few or too thin to say. cell: about 150 points to a cell (0.05 to 1 m); minGap: 12 times the lower quartile of
 *   the cells' biggest gaps (the ordinary surface), at least 0.06 and at most 0.15 m; minPoints 3; minArea the larger of 1 m2 and
 *   25 cells; bridge 3 cells; maxGap 0.5 m (a layer further off is structure, not a ghost). splitFraction: the share of cells
 *   whose biggest gap exceeds minGap (a clean surface has under 1%); texture: the biggest gap's quartile, median and 95th
 *   percentile over the cells, the roughness the gap has to clear.
 */
export function suggestDoubleLayer(source, opts) {
	var strength = opts && opts.strength !== undefined ? opts.strength : "normal";
	if (strength !== "gentle" && strength !== "normal" && strength !== "thorough" && strength !== "aggressive") throw bad("suggestDoubleLayer strength must be \"gentle\", \"normal\", \"thorough\" or \"aggressive\", not " + JSON.stringify(strength));
	var stats = source && source.hist ? source : doubleLayerStats(source);
	if (stats.points < 2000 || !(stats.area > 0)) return { ok: false, reason: "too few points to measure (" + stats.points + ")" };
	var density = stats.points / stats.area, ideal = Math.sqrt(POINTS_PER_CELL / density), ci = 0, i;
	for (i = 1; i < STAT_CELLS.length; i++) if (Math.abs(Math.log(STAT_CELLS[i] / ideal)) < Math.abs(Math.log(STAT_CELLS[ci] / ideal))) ci = i;
	var cell = STAT_CELLS[ci], total = stats.cells[ci];
	if (total < 30) return { ok: false, reason: "too few cells with enough points (" + total + " of " + cell + " m)", density: density };
	var h = stats.hist[ci], p25 = histQuantile(h, total, 0.25), p50 = histQuantile(h, total, 0.5), p95 = histQuantile(h, total, 0.95);
	var minGap = Math.min(0.15, Math.max(0.06, 12 * p25)), over = 0, minPoints = 3, minArea = Math.max(1, 25 * cell * cell), reach = 3, maxGap = 0.5;
	for (var b = 0; b < h.length; b++) if (binValue(b) > minGap) over += h[b];
	var splitFraction = over / total;
	if (strength === "gentle") { minGap = Math.min(0.2, minGap * 1.5); minPoints = 4; minArea *= 2; }
	else if (strength === "thorough") { minGap = Math.max(0.04, minGap * 0.75); minPoints = 2; minArea /= 2; }
	else if (strength === "aggressive") { minGap = Math.max(0.03, minGap * 0.5); minPoints = 2; minArea /= 4; reach = 5; maxGap = 1; }
	return { ok: true, cell: cell, minGap: Math.round(minGap * 1000) / 1000, minPoints: minPoints, minArea: Math.round(minArea * 100) / 100,
		bridge: Math.round(reach * cell * 1000) / 1000, maxGap: maxGap, density: density, splitFraction: splitFraction, texture: { p25: p25, p50: p50, p95: p95 } };
}
