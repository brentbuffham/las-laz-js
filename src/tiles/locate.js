// src/tiles/locate.js
//==========================================================
// Which build chunk a raw point goes to (makeLocator), and a window of
// raw records grouped by chunk (bucketRecords): the distribute pass of
// buildTiles, on the build's thread or in a pool worker
// (src/laz/chunkWorker.js, op "bucket").
//==========================================================

import { parseKey } from "./octree.js";

/** The count grid's levels below the root (128³). */
export var GRID_DEPTH = 7;

export var SUB = 3;   // a refinement counts an over-full chunk on an 8³ grid, three levels below it

// Which chunk a raw point goes to: a 128³ table over the cube, and below any cell holding deeper
// chunks an 8³ table of its own; an entry is a chunk index, -1 (no chunk), or -2 - r (table r)
export function makeLocator(cube, chunks) {
	var refs = [];
	function table(d, x, y, z, levels) {
		var n = Math.pow(2, levels);
		refs.push({ d: d, x: x, y: y, z: z, levels: levels, n: n, t: new Int32Array(n * n * n).fill(-1) });
		return refs.length - 1;
	}
	function place(r, k, ci) {
		var ref = refs[r], D = ref.d + ref.levels, n = ref.n;
		if (k[0] <= D) {
			var span = Math.pow(2, D - k[0]), x0 = k[1] * span - ref.x * n, y0 = k[2] * span - ref.y * n, z0 = k[3] * span - ref.z * n;
			for (var z = z0; z < z0 + span; z++) for (var y = y0; y < y0 + span; y++) for (var x = x0; x < x0 + span; x++) ref.t[x + n * (y + n * z)] = ci;
			return;
		}
		var f = Math.pow(2, k[0] - D), cx = Math.floor(k[1] / f), cy = Math.floor(k[2] / f), cz = Math.floor(k[3] / f);
		var at = (cx - ref.x * n) + n * ((cy - ref.y * n) + n * (cz - ref.z * n)), v = ref.t[at], sub;
		if (v <= -2) sub = -2 - v;
		else { sub = table(D, cx, cy, cz, SUB); ref.t[at] = -2 - sub; }
		place(sub, k, ci);
	}
	table(0, 0, 0, 0, GRID_DEPTH);
	chunks.forEach(function (c, ci) { place(0, parseKey(c.key), ci); });
	function cellOf(v, m, e, N) { var k = Math.floor((v - m) / e); return k < 0 ? 0 : k >= N ? N - 1 : k; }
	return function locate(X, Y, Z) {
		var ref = refs[0];
		for (;;) {
			var D = ref.d + ref.levels, N = Math.pow(2, D), e = cube.edge / N, n = ref.n;
			var v = ref.t[(cellOf(X, cube.min[0], e, N) - ref.x * n) + n * ((cellOf(Y, cube.min[1], e, N) - ref.y * n) + n * (cellOf(Z, cube.min[2], e, N) - ref.z * n))];
			if (v > -2) return v;
			ref = refs[-2 - v];
		}
	};
}

/**
 * Raw records grouped by chunk, in record order within each chunk.
 * @param {Uint8Array} records
 * @param {number} len - the record length
 * @param {function(number, number, number): number} locate - from makeLocator
 * @param {number} chunkCount
 * @returns {{bytes: Uint8Array, runs: number[]}} runs: [chunk, points, ...] by chunk, the non-empty ones
 */
export function bucketRecords(records, len, locate, chunkCount) {
	var n = records.length / len, v = new DataView(records.buffer, records.byteOffset, records.byteLength);
	var at = new Int32Array(n), counts = new Float64Array(chunkCount), i, p;
	for (i = 0, p = 0; i < n; i++, p += len) { at[i] = locate(v.getInt32(p, true), v.getInt32(p + 4, true), v.getInt32(p + 8, true)); counts[at[i]]++; }
	var start = new Float64Array(chunkCount), runs = [], o = 0;
	for (var c = 0; c < chunkCount; c++) { start[c] = o; if (counts[c]) { runs.push(c, counts[c]); o += counts[c] * len; } }
	var out = new Uint8Array(records.length);
	for (i = 0, p = 0; i < n; i++, p += len) {
		var d = start[at[i]];
		for (var b = 0; b < len; b++) out[d + b] = records[p + b];
		start[at[i]] = d + len;
	}
	return { bytes: out, runs: runs };
}
