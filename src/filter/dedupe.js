// src/filter/dedupe.js
//==========================================================
// Drop points within `tolerance` of a point already kept — Kirra's
// PointDeduplication rule (first point wins, spatial hash grid of
// tolerance-sized cells, neighbours checked), ported from point
// objects to columns. XY by default (one Z per XY location, as a
// 2.5D surface wants); { z: true } compares in 3D.
// Every column follows the kept points (k values per point).
// dedupeSelection gives the same keep as a selection, plus a map from
// every input point to the output point it merged into.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { columnsOf, gather, sameType } from "../ops/columns.js";
import { hashKey } from "../index/grid.js";

/**
 * The points dedupe keeps, and where every input point went.
 * map[i] is the output number (position in keep) of the kept point that point i
 * merged into: for a dropped point, the nearest kept point within tolerance
 * (lowest number on a tie); a kept point maps to itself.
 * @param {object} cols - PointColumns ({ count, x, y, z?, ... }).
 * @param {number} tolerance - distance below which points merge (> 0).
 * @param {{z?: boolean}} [opts] - z: compare in 3D.
 * @returns {{keep: Uint32Array, map: Uint32Array}}
 */
export function dedupeSelection(cols, tolerance, opts) {
	if (!(tolerance > 0)) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "dedupe tolerance must be > 0");
	var use3d = !!(opts && opts.z && cols.z);
	var tol2 = tolerance * tolerance;
	var n = cols.count;
	var x = cols.x, y = cols.y, z = cols.z;
	var dzRange = use3d ? 1 : 0;

	// Cell indices, shifted so every neighbour is >= 0
	var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (var p = 0; p < n; p++) {
		var a0 = Math.floor(x[p] / tolerance), a1 = Math.floor(y[p] / tolerance), a2 = use3d ? Math.floor(z[p] / tolerance) : 0;
		if (a0 < lo[0]) lo[0] = a0; if (a0 > hi[0]) hi[0] = a0;
		if (a1 < lo[1]) lo[1] = a1; if (a1 > hi[1]) hi[1] = a1;
		if (a2 < lo[2]) lo[2] = a2; if (a2 > hi[2]) hi[2] = a2;
	}
	var SY = hi[1] - lo[1] + 3, SZ = hi[2] - lo[2] + 3;
	// A dense numeric key when the cell count fits 2^53; else a hashed one —
	// two cells may then share a key, which only adds candidates: every
	// candidate is still distance-checked, so the result is exact either way
	var dense = (hi[0] - lo[0] + 3) * SY * SZ <= 9007199254740992;
	function key(i, j, k) { return dense ? (i * SY + j) * SZ + k : (i * 73856093 + j * 19349663 + k * 83492791) % 9007199254740881; }

	function cellKey(p) {
		return key(Math.floor(x[p] / tolerance) - lo[0] + 1, Math.floor(y[p] / tolerance) - lo[1] + 1, use3d ? Math.floor(z[p] / tolerance) - lo[2] + 1 : 1);
	}

	// Each cell is a linked list of kept points through next[]. Its newest point sits in
	// an open-addressing table (linear probing, power-of-two capacity, at most half
	// full); a slot holds only the point number and its key is recomputed from that
	// point's cell, so a slot costs 4 bytes. (A Map stops at 2^24 cells.)
	var cells = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
	var cap = 16;
	while (cap < Math.min(n, cells)) cap *= 2;
	var mask = cap - 1, used = 0, table = new Int32Array(cap).fill(-1);
	// The slot of cell key c: its newest kept point, or -1 (the free slot c would take)
	function find(c) {
		var h = hashKey(c, mask);
		while (table[h] >= 0 && cellKey(table[h]) !== c) h = (h + 1) & mask;
		return h;
	}
	function grow() {
		var old = table;
		cap *= 2; mask = cap - 1; table = new Int32Array(cap).fill(-1);
		for (var s = 0; s < old.length; s++) {
			if (old[s] < 0) continue;
			var h = hashKey(cellKey(old[s]), mask);
			while (table[h] >= 0) h = (h + 1) & mask;
			table[h] = old[s];
		}
	}
	var next = new Int32Array(n);
	var kept = new Uint32Array(n);
	var map = new Uint32Array(n);
	var nKept = 0;
	for (var i = 0; i < n; i++) {
		var cx = Math.floor(x[i] / tolerance) - lo[0] + 1, cy = Math.floor(y[i] / tolerance) - lo[1] + 1;
		var cz = use3d ? Math.floor(z[i] / tolerance) - lo[2] + 1 : 1;
		var dup = false;
		for (var dx = -1; dx <= 1 && !dup; dx++) {
			for (var dy = -1; dy <= 1 && !dup; dy++) {
				for (var dz = -dzRange; dz <= dzRange && !dup; dz++) {
					var k = table[find(key(cx + dx, cy + dy, cz + dz))];
					while (k >= 0) {
						var ex = x[k] - x[i], ey = y[k] - y[i];
						var ez = use3d ? z[k] - z[i] : 0;
						if (ex * ex + ey * ey + ez * ez <= tol2) { dup = true; break; }
						k = next[k];
					}
				}
			}
		}
		if (dup) continue;
		var own = key(cx, cy, cz), h = find(own);
		if (table[h] < 0) {
			if (2 * (used + 1) > cap) { grow(); h = find(own); }
			used++;
		}
		next[i] = table[h];
		table[h] = i;
		map[i] = nKept;
		kept[nKept++] = i;
	}

	// Each dropped point (every point not in kept) maps to its nearest kept point;
	// the cell lists hold kept points only
	for (i = 0, p = 0; i < n; i++) {
		if (p < nKept && kept[p] === i) { p++; continue; }
		var cx = Math.floor(x[i] / tolerance) - lo[0] + 1, cy = Math.floor(y[i] / tolerance) - lo[1] + 1;
		var cz = use3d ? Math.floor(z[i] / tolerance) - lo[2] + 1 : 1;
		var best = -1, bd = Infinity;
		for (var dx = -1; dx <= 1; dx++) {
			for (var dy = -1; dy <= 1; dy++) {
				for (var dz = -dzRange; dz <= dzRange; dz++) {
					var k = table[find(key(cx + dx, cy + dy, cz + dz))];
					while (k >= 0) {
						var ex = x[k] - x[i], ey = y[k] - y[i];
						var ez = use3d ? z[k] - z[i] : 0;
						var d = ex * ex + ey * ey + ez * ez;
						if (d <= tol2 && (d < bd || (d === bd && k < best))) { bd = d; best = k; }
						k = next[k];
					}
				}
			}
		}
		map[i] = map[best];
	}
	return { keep: kept.slice(0, nKept), map: map };
}

/**
 * @param {object} cols - PointColumns ({ count, x, y, z?, ... }).
 * @param {number} tolerance - distance below which points merge (> 0).
 * @param {{z?: boolean}} [opts]
 * @returns {object} PointColumns with only the kept points
 */
export function dedupe(cols, tolerance, opts) {
	var sel = dedupeSelection(cols, tolerance, opts).keep, nKept = sel.length;

	// Every column (k values per point) follows the kept points; anything else passes through
	var ks = Object.create(null);   // a column may be named like an Object.prototype member
	columnsOf(cols).forEach(function (c) { ks[c.name] = c.k; });
	var out = { count: nKept };
	Object.keys(cols).forEach(function (name) {
		if (name === "count") return;
		var col = cols[name];
		var v = col;
		if (Object.prototype.hasOwnProperty.call(ks, name)) {
			v = sameType(col, nKept * ks[name]);
			gather(col, v, ks[name], sel);
		}
		// defineProperty so a column named "__proto__" stays a column
		Object.defineProperty(out, name, { value: v, enumerable: true, writable: true, configurable: true });
	});
	return out;
}
