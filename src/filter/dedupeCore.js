// src/filter/dedupeCore.js
//==========================================================
// The sweep behind dedupe: first point wins. Points are taken in order,
// and a point is dropped when a point kept before it lies within
// tolerance. Kept points sit in a hash of cells 2 x tolerance wide (a
// point's tolerance box meets 4 cells in plan, 8 in 3D: a third of the
// look-ups of cells one tolerance wide), each cell a list through
// next[] with its newest point in an open-addressing table.
// The sweep is shared by dedupe (this thread) and by the pool's tiles
// (src/filter/dedupeParallel.js). A tile can be given points whose
// outcome is already known (frozen: 1 kept, 2 dropped), which then
// stand in the grid without being tested.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { hash32 } from "../index/grid.js";

var MARGIN = 1.001;      // the box searched is a little wider than tolerance (candidates are still distance-checked)
export var TICK = 65536; // points between onTick calls
var MIN_FACTOR = 2, MAX_FACTOR = 8, CELL_POINTS = 3;   // a cell's side in tolerances: at least 2 (a box meets 2 cells an axis), at most 8
var DENSITY_GRID = 256, DENSITY_SAMPLE = 500000;

// Points a unit area on the cloud's plan (its two widest axes): the points over the area of the coarse grid cells a
// sample of them falls in. Duplicates count, so it is never below the density of the points kept.
function density(x, y, z, n, lo, hi) {
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
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @param {ArrayLike<number>|null} z - null for a plan (XY) comparison
 * @param {number} n - points
 * @param {number} tolerance - > 0
 * @param {{frozen?: Uint8Array, onTick?: function(number, number)}} [o] - frozen: per point 0 decide, 1 kept, 2 dropped;
 *   onTick(done, n) every TICK points (may throw to stop)
 * @returns {{kept: Uint32Array, nearest: function(number): number}} the kept points, ascending (frozen kept ones too);
 *   nearest(i): the kept point within tolerance of point i that is nearest (lowest number on a tie), or -1
 */
export function dedupeSweep(x, y, z, n, tolerance, o) {
	o = o || {};
	var use3d = !!z, frozen = o.frozen || null, tick = o.onTick || null, tol2 = tolerance * tolerance;
	var t = tolerance * MARGIN;
	var p, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
	for (p = 0; p < n; p++) {
		var u = x[p], v = y[p];
		if (u < minX) minX = u; if (u > maxX) maxX = u;
		if (v < minY) minY = v; if (v > maxY) maxY = v;
	}
	if (use3d) for (p = 0; p < n; p++) { var w = z[p]; if (w < minZ) minZ = w; if (w > maxZ) maxZ = w; }
	if (!n) return { kept: new Uint32Array(0), nearest: function () { return -1; } };
	var dens = density(x, y, z, n, [minX, minY, minZ], [maxX, maxY, maxZ]);   // points a square metre on the cloud's plan
	// cells f x tolerance wide, f from the density so a cell holds about 3 points: fewer, longer lists than one
	// tolerance wide cost fewer cache misses until a list is long (measured: 3 x 3 x 3 look-ups of one-tolerance
	// cells took 2 to 3 times as long)
	var f = dens > 0 ? Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, Math.sqrt(CELL_POINTS / (dens * tolerance * tolerance)))) : MIN_FACTOR;
	var ic = 1 / (f * t), perCell = dens * f * f * tolerance * tolerance;
	var lox = Math.floor((minX - t) * ic), loy = Math.floor((minY - t) * ic), loz = use3d ? Math.floor((minZ - t) * ic) : 0;
	var SX = Math.floor((maxX + t) * ic) - lox + 1, SY = Math.floor((maxY + t) * ic) - loy + 1, SZ = use3d ? Math.floor((maxZ + t) * ic) - loz + 1 : 1;
	// A dense numeric key when the cell count fits 2^53; else a hashed one: two cells may then share a key,
	// which only adds candidates (each is distance-checked), so the result is exact either way
	var dense = SX * SY * SZ <= 9007199254740992;
	function key(i, j, k) { return dense ? (i * SY + j) * SZ + k : (i * 73856093 + j * 19349663 + k * 83492791) % 9007199254740881; }
	function cellKey(q) {
		return key(Math.floor(x[q] * ic) - lox, Math.floor(y[q] * ic) - loy, use3d ? Math.floor(z[q] * ic) - loz : 0);
	}

	// Each cell is a linked list of kept points through next[]; its newest point sits in an open-addressing table
	// (linear probing, power-of-two capacity, at most half full). A slot holds the point number and an 8-bit tag of
	// its key's hash; the key itself is recomputed from the point's cell, only when the tag matches. 5 bytes a slot.
	var cells = SX * SY * SZ, cap = 16, want = Math.min(n, cells) / Math.max(1, perCell);
	while (cap < want) cap *= 2;
	var mask = cap - 1, used = 0, table = new Int32Array(cap).fill(-1), tags = new Uint8Array(cap), tag = 0;
	// The slot of cell key c: its newest kept point, or -1 (the free slot c would take)
	function find(c) {
		var g = hash32(c), h = g & mask;
		tag = Math.imul(g, 0x9E3779B1) >>> 24;   // top bits of a multiply mix every bit of g
		while (table[h] >= 0 && (tags[h] !== tag || cellKey(table[h]) !== c)) h = (h + 1) & mask;
		return h;
	}
	function grow() {
		var old = table, oldTags = tags;
		cap *= 2; mask = cap - 1; table = new Int32Array(cap).fill(-1); tags = new Uint8Array(cap);
		for (var s = 0; s < old.length; s++) {
			if (old[s] < 0) continue;
			var h = hash32(cellKey(old[s])) & mask;
			while (table[h] >= 0) h = (h + 1) & mask;
			table[h] = old[s]; tags[h] = oldTags[s];
		}
	}
	var next = new Int32Array(n), kept = new Uint32Array(n), nKept = 0;
	for (var i = 0; i < n; i++) {
		if (tick && (i & (TICK - 1)) === 0) tick(i, n);
		var f = frozen ? frozen[i] : 0;
		if (f === 2) continue;
		var xi = x[i], yi = y[i], zi = use3d ? z[i] : 0;
		var ox = Math.floor(xi * ic) - lox, oy = Math.floor(yi * ic) - loy, oz = use3d ? Math.floor(zi * ic) - loz : 0;
		if (f !== 1) {
			var ax0 = Math.floor((xi - t) * ic) - lox, ax1 = Math.floor((xi + t) * ic) - lox;
			var ay0 = Math.floor((yi - t) * ic) - loy, ay1 = Math.floor((yi + t) * ic) - loy;
			var az0 = use3d ? Math.floor((zi - t) * ic) - loz : 0, az1 = use3d ? Math.floor((zi + t) * ic) - loz : 0;
			var dup = false;
			for (var cx = ax0; cx <= ax1 && !dup; cx++) {
				for (var cy = ay0; cy <= ay1 && !dup; cy++) {
					for (var cz = az0; cz <= az1 && !dup; cz++) {
						var k = table[find(key(cx, cy, cz))];
						while (k >= 0) {
							var ex = x[k] - xi, ey = y[k] - yi, ez = use3d ? z[k] - zi : 0;
							if (ex * ex + ey * ey + ez * ez <= tol2) { dup = true; break; }
							k = next[k];
						}
					}
				}
			}
			if (dup) continue;
		}
		var own = key(ox, oy, oz), h = find(own);
		if (table[h] < 0) {
			if (2 * (used + 1) > cap) { grow(); h = find(own); }
			used++;
			tags[h] = tag;
		}
		next[i] = table[h];
		table[h] = i;
		kept[nKept++] = i;
	}

	// The nearest kept point within tolerance of point i (lowest number on a tie); the cell lists hold kept points only
	function nearest(i) {
		var xi = x[i], yi = y[i], zi = use3d ? z[i] : 0, best = -1, bd = Infinity;
		var ax0 = Math.floor((xi - t) * ic) - lox, ax1 = Math.floor((xi + t) * ic) - lox;
		var ay0 = Math.floor((yi - t) * ic) - loy, ay1 = Math.floor((yi + t) * ic) - loy;
		var az0 = use3d ? Math.floor((zi - t) * ic) - loz : 0, az1 = use3d ? Math.floor((zi + t) * ic) - loz : 0;
		for (var cx = ax0; cx <= ax1; cx++) {
			for (var cy = ay0; cy <= ay1; cy++) {
				for (var cz = az0; cz <= az1; cz++) {
					var k = table[find(key(cx, cy, cz))];
					while (k >= 0) {
						var ex = x[k] - xi, ey = y[k] - yi, ez = use3d ? z[k] - zi : 0;
						var d = ex * ex + ey * ey + ez * ez;
						if (d <= tol2 && (d < bd || (d === bd && k < best))) { bd = d; best = k; }
						k = next[k];
					}
				}
			}
		}
		return best;
	}
	return { kept: kept.slice(0, nKept), nearest: nearest };
}

/** The error a stopped run raises. */
export function stoppedDedupe() { return new LasError(ERROR_CODES.ABORTED, "the run was stopped"); }
