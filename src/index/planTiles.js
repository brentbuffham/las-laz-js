// src/index/planTiles.js
//==========================================================
// Work tiles for the parallel runs (findFragmentsParallel,
// findFacetsParallel): the cloud's box cut on its two widest axes into
// square cores of side T, each grown by M on every side, and each
// tile's points (a point is in every tile whose grown box holds it).
// runTiles hands each tile's points (copied, transferred) to the LAZ
// worker pool, or runs them here one by one; results in tile order.
//==========================================================

import { coordsOf } from "./grid.js";
import { createLazPool } from "../laz/pool.js";

/**
 * @param {object} cols - point columns.
 * @param {number|function(number, number): number} T - a core's side, or a function of the box's two widths giving it.
 * @param {number} M - the overlap each side.
 * @param {string} name - the caller, for errors.
 * @returns {{co: object, st: number, n: number, order: number[], U: ArrayLike<number>, V: ArrayLike<number>, u0: number,
 *   v0: number, NU: number, NV: number, NT: number, T: number, M: number, members: Uint32Array[],
 *   coreTile: function(number): number, inCore: function(number, number, number): boolean}}
 */
export function planTiles(cols, T, M, name) {
	var co = coordsOf(cols, name), n = cols.count, st = co.stride, C = [co.x, co.y, co.z], i, a;
	var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (i = 0; i < n; i++) for (a = 0; a < 3; a++) { var v = C[a][i * st]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
	var order = [0, 1, 2].sort(function (p, q) { return (hi[q] - lo[q]) - (hi[p] - lo[p]); }), U = C[order[0]], V = C[order[1]];
	var u0 = lo[order[0]], v0 = lo[order[1]], du = hi[order[0]] - u0, dv = hi[order[1]] - v0;
	if (typeof T === "function") T = T(du, dv);
	var NU = Math.max(1, Math.ceil(du / T)), NV = Math.max(1, Math.ceil(dv / T)), NT = NU * NV;
	function span(t, d0, N) { return [Math.max(0, Math.floor((t - d0 - M) / T)), Math.min(N - 1, Math.floor((t - d0 + M) / T))]; }
	var counts = new Uint32Array(NT), members = [], b, t;
	for (i = 0; i < n; i++) {
		var su = span(U[i * st], u0, NU), sv = span(V[i * st], v0, NV);
		for (b = sv[0]; b <= sv[1]; b++) for (a = su[0]; a <= su[1]; a++) counts[b * NU + a]++;
	}
	for (t = 0; t < NT; t++) members.push(new Uint32Array(counts[t]));
	counts.fill(0);
	for (i = 0; i < n; i++) {
		var pu = span(U[i * st], u0, NU), pv = span(V[i * st], v0, NV);
		for (b = pv[0]; b <= pv[1]; b++) for (a = pu[0]; a <= pu[1]; a++) { t = b * NU + a; members[t][counts[t]++] = i; }
	}
	function cell(x, x0, N) { return Math.min(N - 1, Math.max(0, Math.floor((x - x0) / T))); }
	return {
		co: co, st: st, n: n, order: order, U: U, V: V, u0: u0, v0: v0, du: du, dv: dv, NU: NU, NV: NV, NT: NT, T: T, M: M, members: members,
		// the tile whose core holds point i (the edge tiles' cores reach to the box's edge)
		coreTile: function (i) { return cell(V[i * st], v0, NV) * NU + cell(U[i * st], u0, NU); },
		// whether tile t's core holds the position (u, v) on the tiles' axes
		inCore: function (t, u, v) { return cell(u, u0, NU) === t % NU && cell(v, v0, NV) === Math.floor(t / NU); }
	};
}

/**
 * Run every tile: in the pool when threads > 1 (and it starts), else here.
 * @param {object} plan - planTiles' result.
 * @param {number} threads
 * @param {function(object, object): Promise<object>} remote - (pool, task) to a result; task {count, x, y, z, f32}.
 * @param {function(object): object} local - the tile's columns to a result.
 * @param {function(number, number)} [onProgress] - (tiles done, tiles).
 * @returns {Promise<{results: Array<object|null>, threads: number}>} null for a tile under 9 points.
 */
export async function runTiles(plan, threads, remote, local, onProgress) {
	var co = plan.co, st = plan.st, Arr = co.x instanceof Float32Array ? Float32Array : Float64Array, done = 0;
	function columns(idx) {
		var m = idx.length, x = new Arr(m), y = new Arr(m), z = new Arr(m);
		for (var j = 0; j < m; j++) { var o = idx[j] * st; x[j] = co.x[o]; y[j] = co.y[o]; z[j] = co.z[o]; }
		return { count: m, x: x, y: y, z: z };
	}
	var pool = threads > 1 ? await createLazPool(Math.min(threads, plan.NT)) : null;
	try {
		var results = await Promise.all(plan.members.map(function (idx) {
			if (idx.length < 9) return Promise.resolve(null);
			var tc = columns(idx);
			var job = pool ? remote(pool, { count: tc.count, x: tc.x.buffer, y: tc.y.buffer, z: tc.z.buffer, f32: Arr === Float32Array })
				: Promise.resolve().then(function () { return local(tc); });
			return job.then(function (r) { done++; if (onProgress) onProgress(done, plan.NT); return r; });
		}));
		return { results: results, threads: pool ? Math.min(threads, plan.NT) : 1 };
	} finally {
		if (pool) pool.close();
	}
}
