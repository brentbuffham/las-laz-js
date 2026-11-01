// src/index/tileJobs.js
//==========================================================
// The jobs a tile of a parallel run on a cloud in memory can be given
// (src/ops/parallel.js): each takes the tile's point columns (x, y, z,
// with the ring of points around its core), its parameters and a
// progress callback, and returns typed arrays for the tile's points in
// their order. They run on a pool worker (src/laz/chunkWorker.js, op
// "tile") or on the calling thread.
//==========================================================

import { meanDistances } from "../ops/outliers.js";
import { selectSparse } from "../ops/sparse.js";
import { pointNormals, estimateNoise } from "../ops/normals.js";
import { denoisePoints } from "../ops/denoise.js";
import { doubleLayerStats } from "../ops/doubleLayer.js";

export var TILE_JOBS = {
	// each point's mean distance to its k nearest (NaN when the tile holds no more than k points)
	outliers: function (cols, p, on) {
		return { means: cols.count > p.k ? meanDistances(cols, p.k, on).means : new Float64Array(cols.count).fill(NaN) };
	},
	// the tile's sparse points, their numbers in the tile
	sparse: function (cols, p, on) {
		return { sel: cols.count ? selectSparse(cols, { radius: p.radius, minNeighbours: p.minNeighbours, xy: p.xy, onProgress: on }) : new Uint32Array(0) };
	},
	// pointNormals' normal (3 a point) and residual
	normals: function (cols, p, on) {
		var r = pointNormals(cols, { k: p.k, maxDistance: p.maxDistance, onProgress: on });
		return { normal: r.normal, residual: r.residual };
	},
	// doubleLayerStats of the tile, flat: points and area, the cells counted for each cell size, and their gap histograms back to back
	doubleStats: function (cols, p, on) {
		var r = doubleLayerStats(cols, { onProgress: on }), bins = r.hist[0].length, hist = new Uint32Array(r.hist.length * bins);
		r.hist.forEach(function (h, i) { hist.set(h, i * bins); });
		return { head: Float64Array.of(r.points, r.area), cells: Float64Array.from(r.cells), hist: hist };
	},
	// the tile's noise level, one number
	noise: function (cols, p, on) {
		return { value: Float64Array.of(estimateNoise(cols, { k: p.k, maxDistance: p.maxDistance, onProgress: on })) };
	},
	// denoisePoints on the tile: the new x, y, z of its points (the input's type), and normals when asked
	denoise: function (cols, p, on) {
		var r = denoisePoints(cols, Object.assign({}, p, { onProgress: on }));
		var out = { x: r.x, y: r.y, z: r.z };
		if (r.normal) out.normal = r.normal;
		return out;
	}
};
