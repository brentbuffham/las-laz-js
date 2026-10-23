// src/facets/outline.js
//==========================================================
// A facet's area and outline from an in-plane grid. The facet's points
// are projected onto its plane (an orthonormal basis u, v with u x v =
// the normal) and binned into cells from the facet's lowest corner (so
// a small cluster is not split across cells); area = filled cells x cell^2, so it
// does not depend on point density. The outline is the outer boundary
// of the largest 4-connected patch of filled cells: each filled cell's
// sides facing an empty cell become directed edges, anticlockwise round
// the cell, chained into rings (at a corner where the patch touches
// itself the walk turns right, so the outer ring stays one ring); the
// ring of largest signed area is the outer one (holes run clockwise and
// are not traced). Collinear vertices are dropped and the ring is mapped
// back to 3D on the plane: anticlockwise seen from the side the normal
// points to.
//==========================================================

var DENSE = 1 << 24;   // grids up to this many cells use a flat byte array, larger ones a Set

/**
 * Area and outline of a facet. Internal; not exported from the package entry.
 * @param {ArrayLike<number>} X
 * @param {ArrayLike<number>} Y
 * @param {ArrayLike<number>} Z
 * @param {number} stride - 1 for x / y / z columns, 3 for a positions column.
 * @param {Uint32Array} points - the facet's point numbers.
 * @param {number[]} centroid - a point on the plane.
 * @param {number[]} normal - the plane's normal (any length).
 * @param {number} cell - the grid's cell size.
 * @returns {{area: number, outline: Float64Array}} outline: x, y, z per vertex, not closed by a repeat
 */
export function facetOutline(X, Y, Z, stride, points, centroid, normal, cell) {
	var nl = Math.hypot(normal[0], normal[1], normal[2]);
	var n = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
	var e = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
	var u = [n[1] * e[2] - n[2] * e[1], n[2] * e[0] - n[0] * e[2], n[0] * e[1] - n[1] * e[0]];
	var ul = Math.hypot(u[0], u[1], u[2]);
	u = [u[0] / ul, u[1] / ul, u[2] / ul];
	var v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
	var m = points.length, k, o, dx, dy, dz;
	if (!m) return { area: 0, outline: new Float64Array(0) };
	// the in-plane coordinates are recomputed in each pass rather than stored (no per-point arrays)
	function along(p, w) { o = points[p] * stride; dx = X[o] - centroid[0]; dy = Y[o] - centroid[1]; dz = Z[o] - centroid[2]; return dx * w[0] + dy * w[1] + dz * w[2]; }
	var amin = Infinity, bmin = Infinity;
	for (k = 0; k < m; k++) { var a0 = along(k, u), b0 = along(k, v); if (a0 < amin) amin = a0; if (b0 < bmin) bmin = b0; }
	// 0.382 of a cell (the golden ratio's fraction) before the lowest point: a boundary then never
	// falls on points of a regular grid (spacing cell / n), where rounding would decide their cell
	amin -= 0.381966 * cell; bmin -= 0.381966 * cell;
	function ci(p) { return Math.floor((along(p, u) - amin) / cell); }
	function cj(p) { return Math.floor((along(p, v) - bmin) / cell); }
	var imin = 0, imax = 0, jmin = 0, jmax = 0;
	for (k = 0; k < m; k++) { var ik = ci(k), jk = cj(k); if (ik > imax) imax = ik; if (jk > jmax) jmax = jk; }
	// cells keyed (i - imin + 1) * H + (j - jmin + 1), with a one-cell empty margin
	var H = jmax - jmin + 3, W = imax - imin + 3, total = W * H;
	function key(i, j) { return (i - imin + 1) * H + (j - jmin + 1); }
	// The filled cells. Dense: a byte per cell of the grid, a cell's slot is its key. Sparse (a grid
	// past DENSE cells: a facet spread thin over a huge extent): the filled keys sorted, a cell's slot
	// its position, found by binary search - memory follows the points, not the extent
	var dense = null, keys = null, count = 0;
	if (total <= DENSE) {
		dense = new Uint8Array(total);
		for (k = 0; k < m; k++) { var kd = key(ci(k), cj(k)); if (!dense[kd]) { dense[kd] = 1; count++; } }
	} else {
		keys = new Float64Array(m);
		for (k = 0; k < m; k++) keys[k] = key(ci(k), cj(k));
		keys.sort();
		for (k = 0; k < m; k++) if (!count || keys[k] !== keys[count - 1]) keys[count++] = keys[k];
		keys = keys.slice(0, count);
	}
	function slot(kk) {
		if (dense) return kk >= 0 && kk < total && dense[kk] ? kk : -1;
		var lo = 0, hi = count - 1;
		while (lo <= hi) { var mid = (lo + hi) >> 1; if (keys[mid] < kk) lo = mid + 1; else if (keys[mid] > kk) hi = mid - 1; else return mid; }
		return -1;
	}
	function eachFilled(fn) {
		if (dense) { for (var c = 0; c < total; c++) if (dense[c]) fn(c); }
		else for (var q = 0; q < count; q++) fn(keys[q]);
	}
	var area = count * cell * cell;

	// the largest 4-connected component
	var seen = new Uint8Array(dense ? total : count), best = null;
	eachFilled(function (start) {
		if (seen[slot(start)]) return;
		var comp = [], stack = [start];
		seen[slot(start)] = 1;
		while (stack.length) {
			var c = stack.pop();
			comp.push(c);
			[c + H, c - H, c + 1, c - 1].forEach(function (nb) { var sn = slot(nb); if (sn >= 0 && !seen[sn]) { seen[sn] = 1; stack.push(nb); } });
		}
		if (!best || comp.length > best.length) best = comp;
	});
	var inComp = new Uint8Array(dense ? total : count);
	best.forEach(function (c) { inComp[slot(c)] = 1; });
	function inside(c) { var sc = slot(c); return sc >= 0 && inComp[sc] === 1; }

	// directed boundary edges, anticlockwise round each cell; vertices are grid corners
	// (vertex (a, b) = the corner at cell indices (a, b), keyed a * (H + 1) + b, local to the margin)
	var VH = H + 1, from = [], to = [], out = new Map();
	function edge(a0, b0, a1, b1) {
		var f = a0 * VH + b0;
		from.push(f); to.push(a1 * VH + b1);
		var l = out.get(f);
		if (l) l.push(from.length - 1); else out.set(f, [from.length - 1]);
	}
	best.forEach(function (c) {
		var a = Math.floor(c / H), b = c - a * H;
		if (!inside(c - 1)) edge(a, b, a + 1, b);             // bottom
		if (!inside(c + H)) edge(a + 1, b, a + 1, b + 1);     // right
		if (!inside(c + 1)) edge(a + 1, b + 1, a, b + 1);     // top
		if (!inside(c - H)) edge(a, b + 1, a, b);             // left
	});
	// chain into rings; at a vertex with two ways out, turn right
	var used = new Uint8Array(from.length), rings = [];
	for (var s = 0; s < from.length; s++) {
		if (used[s]) continue;
		var ring = [], cur = s;
		while (!used[cur]) {
			used[cur] = 1;
			ring.push(from[cur]);
			var nexts = out.get(to[cur]), pick = -1, bestTurn = Infinity;
			var ax = Math.floor(to[cur] / VH) - Math.floor(from[cur] / VH), ay = (to[cur] % VH) - (from[cur] % VH);
			for (var q = 0; q < nexts.length; q++) {
				var ed = nexts[q];
				// the ring's first edge is a candidate too: back at a pinch vertex the right turn may be
				// to close the ring there, not to walk on into the other loop (a hole)
				if (used[ed] && ed !== s) continue;
				var bx = Math.floor(to[ed] / VH) - Math.floor(from[ed] / VH), by = (to[ed] % VH) - (from[ed] % VH);
				var turn = ax * by - ay * bx;   // < 0 right, 0 straight, > 0 left
				if (turn < bestTurn) { bestTurn = turn; pick = ed; }
			}
			if (pick < 0) break;
			cur = pick;
		}
		rings.push(ring);
	}
	// the outer ring: the largest signed (anticlockwise) area
	var outer = null, outerArea = -Infinity;
	rings.forEach(function (r) {
		var sa = 0;
		for (var t = 0; t < r.length; t++) {
			var p0 = r[t], p1 = r[(t + 1) % r.length];
			sa += Math.floor(p0 / VH) * (p1 % VH) - Math.floor(p1 / VH) * (p0 % VH);
		}
		if (sa > outerArea) { outerArea = sa; outer = r; }
	});
	// drop collinear vertices, then back to 3D on the plane
	var keep = [];
	for (var t = 0; t < outer.length; t++) {
		var pa = outer[(t + outer.length - 1) % outer.length], pb = outer[t], pc = outer[(t + 1) % outer.length];
		var x1 = Math.floor(pb / VH) - Math.floor(pa / VH), y1 = (pb % VH) - (pa % VH);
		var x2 = Math.floor(pc / VH) - Math.floor(pb / VH), y2 = (pc % VH) - (pb % VH);
		if (x1 * y2 - y1 * x2 !== 0) keep.push(pb);
	}
	var outline = new Float64Array(keep.length * 3);
	keep.forEach(function (p, w) {
		var a = amin + (Math.floor(p / VH) + imin - 1) * cell, b = bmin + (p % VH + jmin - 1) * cell;
		outline[3 * w] = centroid[0] + a * u[0] + b * v[0];
		outline[3 * w + 1] = centroid[1] + a * u[1] + b * v[1];
		outline[3 * w + 2] = centroid[2] + a * u[2] + b * v[2];
	});
	return { area: area, outline: outline };
}
