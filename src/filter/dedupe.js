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
import { dedupeSweep, stoppedDedupe } from "./dedupeCore.js";

/**
 * The points dedupe keeps, and where every input point went.
 * map[i] is the output number (position in keep) of the kept point that point i
 * merged into: for a dropped point, the nearest kept point within tolerance
 * (lowest number on a tie); a kept point maps to itself.
 * @param {object} cols - PointColumns ({ count, x, y, z?, ... }).
 * @param {number} tolerance - distance below which points merge (> 0).
 * @param {{z?: boolean, map?: boolean, onProgress?: function(number, number), signal?: AbortSignal}} [opts] - z: compare in 3D. map: false
 *   skips the map (the nearest-kept-point search for every dropped point, as costly as the keep itself on a
 *   cloud that thins to a third) and returns map: null; dedupe() needs only the keep. onProgress(done, total) in
 *   points, steadily (total is n, or 2 n with the map); signal is looked at as it ticks (ABORTED), for a caller
 *   that runs this in a place a stop can reach.
 * @returns {{keep: Uint32Array, map: (Uint32Array|null)}}
 */
export function dedupeSelection(cols, tolerance, opts) {
	if (!(tolerance > 0)) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "dedupe tolerance must be > 0");
	var o = opts || {}, use3d = !!(o.z && cols.z), wantMap = o.map !== false, n = cols.count, signal = o.signal, report = o.onProgress;
	var total = wantMap ? 2 * n : n;
	var swept = dedupeSweep(cols.x, cols.y, use3d ? cols.z : null, n, tolerance, {
		onTick: function (done) {
			if (signal && signal.aborted) throw stoppedDedupe();
			if (report) report(done, total);
		}
	});
	var kept = swept.kept, nKept = kept.length, map = null;
	if (wantMap) {
		// Each dropped point (every point not in kept) maps to its nearest kept point
		map = new Uint32Array(n);
		for (var q = 0; q < nKept; q++) map[kept[q]] = q;   // a kept point maps to itself (a dropped one may merge into a later kept point)
		for (var i = 0, p = 0; i < n; i++) {
			if (!(i & 65535)) {
				if (signal && signal.aborted) throw stoppedDedupe();
				if (report) report(n + i, total);
			}
			if (p < nKept && kept[p] === i) { map[i] = p++; continue; }
			map[i] = map[swept.nearest(i)];
		}
	}
	if (report) report(total, total);
	return { keep: kept, map: map };
}

/**
 * @param {object} cols - PointColumns ({ count, x, y, z?, ... }).
 * @param {number} tolerance - distance below which points merge (> 0).
 * @param {{z?: boolean, onProgress?: function(number, number), signal?: AbortSignal}} [opts] - onProgress(done, total) in
 *   points as the sweep goes (see dedupeSelection); dedupeParallel runs it on the worker pool
 * @returns {object} PointColumns with only the kept points
 */
export function dedupe(cols, tolerance, opts) {
	return keepColumns(cols, dedupeSelection(cols, tolerance, Object.assign({}, opts, { map: false })).keep);
}

/**
 * The columns of the points in sel (ascending): every column that holds k values a point follows them; anything else passes through.
 * @param {object} cols - PointColumns.
 * @param {Uint32Array} sel - the points to keep, ascending.
 * @returns {object} PointColumns with only those points
 */
export function keepColumns(cols, sel) {
	var nKept = sel.length;

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
