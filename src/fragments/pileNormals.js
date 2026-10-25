// src/fragments/pileNormals.js
//==========================================================
// The pile's own outward direction, at a scale well above a rock's: a
// coarse voxel grid (index/grid.js) of cellSize; each occupied cell's
// centroid; each cell's plane from the centroids of the occupied cells
// among its 27 (when there are at least 3 and they spread in two
// directions; else, as for a pile one cell wide, the direction towards
// the viewpoint, or up, square to the line the centroids lie on). A fitted plane has no
// inside or outside, so the orientation spreads breadth-first over the
// occupied neighbour cells, each flipped to agree with the cell it was
// reached from; a cell with no plane of its own takes that cell's
// normal. The first cell of each connected part: with a viewpoint (any
// point on the open side - the scanner, the camera), the cell nearest
// it, facing it; without, the cell whose plane is most horizontal,
// facing up. A part with no plane at all faces up (0, 0, 1). The k
// nearest of a dense cloud never reach far enough for a pile-scale
// normal, hence the grid.
//==========================================================

import { coordsOf, buildGrid, lookup } from "../index/grid.js";
import { smallestEigen } from "../ops/normals.js";
import { symmetricEigen } from "../register/eigen4.js";

var FLAT = 0.03;   // a spread whose middle axis is under 3 % of its longest is a line, not a plane

/**
 * Outward normals of the pile, one per coarse grid cell.
 * @param {object} cols - point columns (x / y / z or a k = 3 positions column).
 * @param {{cellSize: number, viewpoint?: number[]}} opts - the grid's cell size; viewpoint, a point on the
 *   open side, in the columns' frame.
 * @returns {{cellOf: Uint32Array, cells: number, centroid: Float64Array, normal: Float64Array}} cellOf: each
 *   point's cell number; centroid and normal: 3 per cell, normal unit.
 */
export function pileNormals(cols, opts) {
	var coords = coordsOf(cols, "findFragments"), n = cols.count, X = coords.x, Y = coords.y, Z = coords.z, st = coords.stride;
	var g = buildGrid(coords, n, opts.cellSize, false), keys = g.keys, cap = keys.length, s, i, k;
	var slotCell = new Int32Array(cap).fill(-1), cells = 0;
	for (s = 0; s < cap; s++) if (keys[s] >= 0) slotCell[s] = cells++;
	var cellOf = new Uint32Array(n), centroid = new Float64Array(3 * cells), normal = new Float64Array(3 * cells);
	var ijk = new Int32Array(3 * cells), cellSlot = new Uint32Array(cells);
	// centroids on offsets from each cell's first point, so UTM-sized coordinates lose nothing
	for (s = 0; s < cap; s++) {
		var c = slotCell[s];
		if (c < 0) continue;
		cellSlot[c] = s;
		var key = keys[s], iz = key % g.nz, t = (key - iz) / g.nz, iy = t % g.ny;
		ijk[3 * c] = (t - iy) / g.ny; ijk[3 * c + 1] = iy; ijk[3 * c + 2] = iz;
		var o0 = g.order[g.start[s]] * st, x0 = X[o0], y0 = Y[o0], z0 = Z[o0], sx = 0, sy = 0, sz = 0, len = g.length[s];
		for (k = 0; k < len; k++) {
			var p = g.order[g.start[s] + k], o = p * st;
			cellOf[p] = c; sx += X[o] - x0; sy += Y[o] - y0; sz += Z[o] - z0;
		}
		centroid[3 * c] = x0 + sx / len; centroid[3 * c + 1] = y0 + sy / len; centroid[3 * c + 2] = z0 + sz / len;
	}

	// the occupied neighbour cells of cell c (itself included when self is true)
	var nb = new Int32Array(27);
	function neighbours(c, self) {
		var m = 0;
		for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
			if (!self && !dx && !dy && !dz) continue;
			var sl = lookup(g, ijk[3 * c] + dx, ijk[3 * c + 1] + dy, ijk[3 * c + 2] + dz);
			if (sl >= 0) nb[m++] = slotCell[sl];
		}
		return m;
	}

	// centroids on a line (a pile one cell wide) fix only that the normal is square to the line: take
	// the reference direction (towards the viewpoint, else up) square to it, into eig; false when the
	// line runs along the reference
	var vp0 = opts.viewpoint;
	function squareToLine(c) {
		var e = symmetricEigen([cov[0], cov[1], cov[2], cov[1], cov[3], cov[4], cov[2], cov[4], cov[5]], 3), big = 0;
		for (var a = 1; a < 3; a++) if (e.values[a] > e.values[big]) big = a;
		var u = [e.vectors[3 * big], e.vectors[3 * big + 1], e.vectors[3 * big + 2]];
		var r = vp0 ? [vp0[0] - centroid[3 * c], vp0[1] - centroid[3 * c + 1], vp0[2] - centroid[3 * c + 2]] : [0, 0, 1];
		var rl = Math.hypot(r[0], r[1], r[2]), d = (r[0] * u[0] + r[1] * u[1] + r[2] * u[2]) / rl;
		var v = [r[0] / rl - d * u[0], r[1] / rl - d * u[1], r[2] / rl - d * u[2]], vl = Math.hypot(v[0], v[1], v[2]);
		if (!(vl > 0.1)) return false;
		eig[0] = v[0] / vl; eig[1] = v[1] / vl; eig[2] = v[2] / vl;
		return true;
	}

	// each cell's plane from its neighbourhood's centroids
	var hasPlane = new Uint8Array(cells), cov = new Float64Array(6), eig = new Float64Array(5);
	for (c = 0; c < cells; c++) {
		var m = neighbours(c, true);
		if (m < 3) continue;
		cov.fill(0);
		var cx = centroid[3 * c], cy = centroid[3 * c + 1], cz = centroid[3 * c + 2], mx = 0, my = 0, mz = 0;
		for (k = 0; k < m; k++) { mx += centroid[3 * nb[k]] - cx; my += centroid[3 * nb[k] + 1] - cy; mz += centroid[3 * nb[k] + 2] - cz; }
		mx /= m; my /= m; mz /= m;
		for (k = 0; k < m; k++) {
			var dx = centroid[3 * nb[k]] - cx - mx, dy = centroid[3 * nb[k] + 1] - cy - my, dz = centroid[3 * nb[k] + 2] - cz - mz;
			cov[0] += dx * dx; cov[1] += dx * dy; cov[2] += dx * dz; cov[3] += dy * dy; cov[4] += dy * dz; cov[5] += dz * dz;
		}
		if (!smallestEigen(cov, eig)) continue;
		if (!(eig[4] >= FLAT * (cov[0] + cov[3] + cov[5] - eig[3] - eig[4])) && !squareToLine(c)) continue;
		hasPlane[c] = 1; normal[3 * c] = eig[0]; normal[3 * c + 1] = eig[1]; normal[3 * c + 2] = eig[2];
	}

	// first cells in order of preference: nearest the viewpoint, or most horizontal plane (ties: lowest cell)
	var vp = opts.viewpoint, seeds = [];
	for (c = 0; c < cells; c++) if (hasPlane[c]) seeds.push(c);
	var rank = new Float64Array(cells);
	for (i = 0; i < seeds.length; i++) {
		c = seeds[i];
		rank[c] = vp ? Math.hypot(centroid[3 * c] - vp[0], centroid[3 * c + 1] - vp[1], centroid[3 * c + 2] - vp[2]) : -Math.abs(normal[3 * c + 2]);
	}
	seeds.sort(function (a, b) { return rank[a] - rank[b] || a - b; });

	var seen = new Uint8Array(cells), queue = new Uint32Array(cells);
	function spread(first) {
		var head = 0, tail = 0;
		seen[first] = 1; queue[tail++] = first;
		while (head < tail) {
			var p = queue[head++], m = neighbours(p, false);
			for (var j = 0; j < m; j++) {
				var q = nb[j];
				if (seen[q]) continue;
				seen[q] = 1; queue[tail++] = q;
				if (!hasPlane[q]) { normal[3 * q] = normal[3 * p]; normal[3 * q + 1] = normal[3 * p + 1]; normal[3 * q + 2] = normal[3 * p + 2]; }
				else if (normal[3 * q] * normal[3 * p] + normal[3 * q + 1] * normal[3 * p + 1] + normal[3 * q + 2] * normal[3 * p + 2] < 0) {
					normal[3 * q] = -normal[3 * q]; normal[3 * q + 1] = -normal[3 * q + 1]; normal[3 * q + 2] = -normal[3 * q + 2];
				}
			}
		}
	}
	for (i = 0; i < seeds.length; i++) {
		c = seeds[i];
		if (seen[c]) continue;
		var facing = vp ? normal[3 * c] * (vp[0] - centroid[3 * c]) + normal[3 * c + 1] * (vp[1] - centroid[3 * c + 1]) + normal[3 * c + 2] * (vp[2] - centroid[3 * c + 2]) : normal[3 * c + 2];
		if (facing < 0) { normal[3 * c] = -normal[3 * c]; normal[3 * c + 1] = -normal[3 * c + 1]; normal[3 * c + 2] = -normal[3 * c + 2]; }
		spread(c);
	}
	// parts with no plane at all face up
	for (c = 0; c < cells; c++) if (!seen[c]) { normal[3 * c] = 0; normal[3 * c + 1] = 0; normal[3 * c + 2] = 1; }
	return { cellOf: cellOf, cells: cells, centroid: centroid, normal: normal };
}
