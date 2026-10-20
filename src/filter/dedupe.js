// src/filter/dedupe.js
//==========================================================
// Drop points within `tolerance` of a point already kept — Kirra's
// PointDeduplication rule (first point wins, spatial hash grid of
// tolerance-sized cells, neighbours checked), ported from point
// objects to columns. XY by default (one Z per XY location, as a
// 2.5D surface wants); { z: true } compares in 3D.
// Every column follows the kept points.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

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
	var grid = new Map();
	var kept = new Uint32Array(cols.count);
	var nKept = 0;
	var x = cols.x, y = cols.y, z = cols.z;
	var dzRange = use3d ? 1 : 0;

	for (var i = 0; i < cols.count; i++) {
		var cx = Math.floor(x[i] / tolerance), cy = Math.floor(y[i] / tolerance);
		var cz = use3d ? Math.floor(z[i] / tolerance) : 0;
		var dup = false;
		for (var dx = -1; dx <= 1 && !dup; dx++) {
			for (var dy = -1; dy <= 1 && !dup; dy++) {
				for (var dz = -dzRange; dz <= dzRange && !dup; dz++) {
					var cell = grid.get((cx + dx) + "_" + (cy + dy) + "_" + (cz + dz));
					if (!cell) continue;
					for (var j = 0; j < cell.length; j++) {
						var k = cell[j];
						var ex = x[k] - x[i], ey = y[k] - y[i];
						var ez = use3d ? z[k] - z[i] : 0;
						if (ex * ex + ey * ey + ez * ez <= tol2) { dup = true; break; }
					}
				}
			}
		}
		if (dup) continue;
		var key = cx + "_" + cy + "_" + cz;
		var own = grid.get(key);
		if (!own) { own = []; grid.set(key, own); }
		own.push(i);
		kept[nKept++] = i;
	}

	var out = { count: nKept };
	Object.keys(cols).forEach(function (name) {
		var col = cols[name];
		if (!ArrayBuffer.isView(col) || col.length !== cols.count) { if (name !== "count") out[name] = col; return; }
		var c = new col.constructor(nKept);
		for (var q = 0; q < nKept; q++) c[q] = col[kept[q]];
		out[name] = c;
	});
	return out;
}
