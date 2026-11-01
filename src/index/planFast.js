// src/index/planFast.js
//==========================================================
// Work tiles for the parallel runs on a cloud in memory
// (dedupeParallel, selectOutliersParallel, ...): the cloud's plan (its
// two widest axes, or x and y for a plan comparison) cut into square
// cores, each tile holding its own points and a ring of the points
// within M of its core, in the cloud's order. Two passes over the
// points, light ones: the owner of a point is one floor and a compare
// on each axis.
//==========================================================

var MAX_TILES = 4096;

/**
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @param {ArrayLike<number>|null} z
 * @param {number} n - points
 * @param {{dims: number, M: number, targetTiles: number, side?: number, minSide: number, near?: number}} o - dims 2: cut on x and y;
 *   3: on the two widest of x, y, z. M: the ring's width. targetTiles: about how many tiles (side not given). side: a core's side.
 *   minSide: a core is never narrower. near: also say which ring points lie within this distance of the core on each side it is outside (ringNear).
 * @returns {{NT: number, own: Uint16Array, members: Uint32Array[], ringAt: (number[][]|null), ringNear: (number[][]|null)}|null}
 *   members[t]: tile t's points, ascending (core and ring); own[p]: the tile whose core holds p; ringAt[t]: where its ring points sit in
 *   members[t]; ringNear[t]: 1 for each of those that is near the core. null for one tile.
 */
export function planFast(x, y, z, n, o) {
	var cols = [x, y, z], p, a, b, dims = o.dims, M = o.M;
	var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (p = 0; p < n; p++) for (a = 0; a < dims; a++) { var v = cols[a][p]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
	var axes = [0, 1, 2].slice(0, dims).sort(function (i, j) { return (hi[j] - lo[j]) - (hi[i] - lo[i]); });
	a = axes[0]; b = axes[1];
	var U = cols[a], V = cols[b], u0 = lo[a], v0 = lo[b], su = hi[a] - u0, sv = hi[b] - v0;
	var T = o.side !== undefined ? o.side : (su > 0 && sv > 0 ? Math.sqrt(su * sv / o.targetTiles) : Math.max(su, sv) / o.targetTiles);
	T = Math.max(T, o.minSide);
	var NU = Math.max(1, Math.ceil(su / T)), NV = Math.max(1, Math.ceil(sv / T));
	while (NU * NV > MAX_TILES) { T *= 2; NU = Math.max(1, Math.ceil(su / T)); NV = Math.max(1, Math.ceil(sv / T)); }
	var NT = NU * NV;
	if (NT < 2) return null;
	var iT = 1 / T, flags = o.near !== undefined, tin = o.near;
	var own = new Uint16Array(n), counts = new Uint32Array(NT);
	// pass 1: the owner of each point and how many points each tile will hold
	for (p = 0; p < n; p++) {
		var fu = Math.floor((U[p] - u0) * iT), fv = Math.floor((V[p] - v0) * iT);
		var ca = fu >= NU ? NU - 1 : fu < 0 ? 0 : fu, cb = fv >= NV ? NV - 1 : fv < 0 ? 0 : fv;
		var ru = U[p] - u0 - ca * T, rv = V[p] - v0 - cb * T, t0 = cb * NU + ca;
		own[p] = t0; counts[t0]++;
		var lu = ca > 0 && ru < M, hu = ca < NU - 1 && ru > T - M, lv = cb > 0 && rv < M, hv = cb < NV - 1 && rv > T - M;
		if (lu || hu || lv || hv) {
			for (var db = lv ? -1 : 0; db <= (hv ? 1 : 0); db++) for (var da = lu ? -1 : 0; da <= (hu ? 1 : 0); da++) if (da || db) counts[(cb + db) * NU + ca + da]++;
		}
	}
	var members = [], ringAt = flags ? [] : null, ringNear = flags ? [] : null, fill = new Uint32Array(NT), t;
	for (t = 0; t < NT; t++) { members.push(new Uint32Array(counts[t])); if (flags) { ringAt.push([]); ringNear.push([]); } }
	// pass 2: fill them in the cloud's order
	for (p = 0; p < n; p++) {
		var t1 = own[p], cu = t1 % NU, cv = (t1 - cu) / NU;
		var qu = U[p] - u0 - cu * T, qv = V[p] - v0 - cv * T;
		members[t1][fill[t1]++] = p;
		var l1 = cu > 0 && qu < M, h1 = cu < NU - 1 && qu > T - M, l2 = cv > 0 && qv < M, h2 = cv < NV - 1 && qv > T - M;
		if (l1 || h1 || l2 || h2) {
			for (var e2 = l2 ? -1 : 0; e2 <= (h2 ? 1 : 0); e2++) for (var e1 = l1 ? -1 : 0; e1 <= (h1 ? 1 : 0); e1++) {
				if (!e1 && !e2) continue;
				var t2 = (cv + e2) * NU + cu + e1, j = fill[t2]++;
				members[t2][j] = p;
				if (flags) {
					// near: within `near` of the core in each axis it lies outside (it can be a core point's neighbour)
					var near = (e1 === 0 || (e1 < 0 ? qu : T - qu) <= tin) && (e2 === 0 || (e2 < 0 ? qv : T - qv) <= tin);
					ringAt[t2].push(j); ringNear[t2].push(near ? 1 : 0);
				}
			}
		}
	}
	return { NT: NT, own: own, members: members, ringAt: ringAt, ringNear: ringNear };
}
