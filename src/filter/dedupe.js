// src/filter/dedupe.js
//==========================================================
// Drop points within `tolerance` of a point already kept — Kirra's
// PointDeduplication rule (first point wins, spatial hash grid of
// tolerance-sized cells, neighbours checked), ported from point
// objects to columns. XY by default (one Z per XY location, as a
// 2.5D surface wants); { z: true } compares in 3D.
// Every column follows the kept points (k values per point).
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { columnsOf, gather, sameType } from "../ops/columns.js";

/**
 * @param {object} cols - PointColumns ({ count, x, y, z?, ... }).
 * @param {number} tolerance - distance below which points merge (> 0).
 * @param {{z?: boolean}} [opts]
 * @returns {object} PointColumns with only the kept points
 */
export function dedupe(cols, tolerance, opts) {
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

	// Each cell is a linked list through next[] (Map: key -> most recent point)
	var head = new Map();
	var next = new Int32Array(n);
	var kept = new Uint32Array(n);
	var nKept = 0;
	for (var i = 0; i < n; i++) {
		var cx = Math.floor(x[i] / tolerance) - lo[0] + 1, cy = Math.floor(y[i] / tolerance) - lo[1] + 1;
		var cz = use3d ? Math.floor(z[i] / tolerance) - lo[2] + 1 : 1;
		var dup = false;
		for (var dx = -1; dx <= 1 && !dup; dx++) {
			for (var dy = -1; dy <= 1 && !dup; dy++) {
				for (var dz = -dzRange; dz <= dzRange && !dup; dz++) {
					var k = head.get(key(cx + dx, cy + dy, cz + dz));
					while (k !== undefined && k >= 0) {
						var ex = x[k] - x[i], ey = y[k] - y[i];
						var ez = use3d ? z[k] - z[i] : 0;
						if (ex * ex + ey * ey + ez * ez <= tol2) { dup = true; break; }
						k = next[k];
					}
				}
			}
		}
		if (dup) continue;
		var own = key(cx, cy, cz);
		var prev = head.get(own);
		next[i] = prev === undefined ? -1 : prev;
		head.set(own, i);
		kept[nKept++] = i;
	}

	// Every column (k values per point) follows the kept points; anything else passes through
	var sel = kept.subarray(0, nKept);
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
