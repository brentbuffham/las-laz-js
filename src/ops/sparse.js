// src/ops/sparse.js
//==========================================================
// The sparse-point (dust) filter: select the points that have fewer
// than minNeighbours other points within radius (inclusive), for
// removePoints. A private grid with cells one radius wide is built
// and dropped. Each cell looks up its 27 neighbour cells once (9 in
// 2D); a point near enough to a cell face that rounding could reach
// two cells away gets its own lookup instead, so the count is exact.
// Counting stops at minNeighbours: a point on a dense surface
// usually gets there inside its own cell.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { coordsOf, buildGrid, lookup, checkPointCount } from "../index/grid.js";
import { cellRange, visitBox, decode } from "../index/query.js";

var FACE = 2e-6;   // in cells: nearer a face than this, a point gets its own cell lookup

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/**
 * The points with fewer than minNeighbours other points within radius.
 * minNeighbours 1 keeps any point with one neighbour inside the radius, so thin
 * sparse features (a line of points down a scanned blasthole) survive; clumped
 * dust survives too, and a higher minNeighbours removes small clumps at the
 * cost of thin features.
 * @param {object} cols - point columns with x, y, z, or a k = 3 positions column.
 * @param {{radius: number, minNeighbours?: number, xy?: boolean}} opts - radius in the columns' units (required); minNeighbours default 1; xy: count in 2D.
 * @returns {Uint32Array} selection of the sparse points
 */
export function selectSparse(cols, opts) {
	var radius = opts ? opts.radius : undefined;
	if (!(typeof radius === "number" && radius > 0 && isFinite(radius))) throw bad("selectSparse radius must be a positive finite number, not " + String(radius));
	var minN = opts.minNeighbours === undefined ? 1 : opts.minNeighbours;
	if (!(Number.isInteger(minN) && minN >= 1)) throw bad("selectSparse minNeighbours must be a whole number >= 1, not " + String(minN));
	var xy = !!opts.xy;
	var coords = coordsOf(cols, "selectSparse"), n = cols.count;
	checkPointCount(n);
	if (n === 0) return new Uint32Array(0);

	var g = buildGrid(coords, n, radius, xy);
	var X = coords.x, Y = coords.y, Z = coords.z, st = coords.stride, order = g.order, start = g.start, length = g.length;
	var r2 = radius * radius, sparse = new Uint8Array(n), nSparse = 0;
	var dz = xy ? 0 : 1;

	// Count p's other points within radius over a list of slots, stopping at minN
	function enough(p, slots) {
		var o = p * st, px = X[o], py = Y[o], pz = xy ? 0 : Z[o], k = 0;
		for (var a = 0; a < slots.length; a++) {
			var s = slots[a];
			for (var j = start[s], e = j + length[s]; j < e; j++) {
				var q = order[j];
				if (q === p) continue;
				var w = q * st, ex = X[w] - px, ey = Y[w] - py, ez = xy ? 0 : Z[w] - pz;
				if (ex * ex + ey * ey + ez * ez <= r2 && ++k >= minN) return true;
			}
		}
		return false;
	}

	// A point on a cell face: the cells its own radius box covers, its own cell first
	function slotsAround(o, own) {
		var rx = cellRange(g, 0, X[o] - radius, X[o] + radius), ry = cellRange(g, 1, Y[o] - radius, Y[o] + radius);
		var rz = xy ? [0, 0] : cellRange(g, 2, Z[o] - radius, Z[o] + radius), out = [own];
		visitBox(g, [rx[0], ry[0], rz[0]], [rx[1], ry[1], rz[1]], function (u) { if (u !== own) out.push(u); });
		return out;
	}

	var keys = g.keys, inv = 1 / g.cellSize, x0 = g.min[0], y0 = g.min[1], z0 = g.min[2];
	for (var s = 0; s < keys.length; s++) {
		if (keys[s] < 0) continue;
		var c = decode(g, keys[s]);
		var near = [s];   // own cell first
		for (var ix = c[0] - 1; ix <= c[0] + 1; ix++) {
			for (var iy = c[1] - 1; iy <= c[1] + 1; iy++) {
				for (var iz = c[2] - dz; iz <= c[2] + dz; iz++) {
					if (ix === c[0] && iy === c[1] && iz === c[2]) continue;
					var t = lookup(g, ix, iy, iz);
					if (t >= 0) near.push(t);
				}
			}
		}
		for (var j = start[s], e = j + length[s]; j < e; j++) {
			var p = order[j], o = p * st;
			// Where p sits in its cell (0 to 1 per axis): away from the faces, every point
			// within one radius (= one cell) is in the 27 cells around
			var fx = (X[o] - x0) * inv - c[0], fy = (Y[o] - y0) * inv - c[1], fz = xy ? 0.5 : (Z[o] - z0) * inv - c[2];
			var slots = near;
			if (fx < FACE || fx > 1 - FACE || fy < FACE || fy > 1 - FACE || fz < FACE || fz > 1 - FACE) slots = slotsAround(o, s);
			if (!enough(p, slots)) { sparse[p] = 1; nSparse++; }
		}
	}

	var out = new Uint32Array(nSparse);
	for (var i = 0, w = 0; i < n; i++) if (sparse[i]) out[w++] = i;
	return out;
}
