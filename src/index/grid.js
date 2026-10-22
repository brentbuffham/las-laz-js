// src/index/grid.js
//==========================================================
// The voxel neighbour index: a sorted voxel grid on flat typed
// arrays. Point numbers are counting-sorted by cell into `order`
// (stable, so a cell's points stay ascending); an open-addressing
// hash table (linear probing, power-of-two capacity) maps each
// occupied cell's key to its `start` and `length` in `order`.
// Coordinates are referenced, not copied: x / y / z columns, or a
// k = 3 positions column (Kirra's kadCloud layout) read with a
// stride of 3. About 6 bytes per point at 16 points per cell.
// The grid only prunes: queries (query.js) distance-check every
// candidate in Float64, so their results are exact.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { columnsOf, countOf } from "../ops/columns.js";

var MAX_POINTS = 4294967295;
var MAX_CELLS = 9007199254740992;   // 2^53: keys stay exact integers
var EMPTY = -1;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

/**
 * The coordinates of point columns: x / y / z (stride 1), else a k = 3
 * positions column (stride 3, y and z as offset views of it).
 * Point i's x is coords.x[i * coords.stride].
 * @param {object} cols - point columns.
 * @param {string} fn - the calling function's name, for the message.
 * @returns {{x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>, stride: number}}
 */
export function coordsOf(cols, fn) {
	var count = countOf(cols);
	var k = Object.create(null);
	columnsOf(cols).forEach(function (c) { k[c.name] = c.k; });
	if (k.x === 1 && k.y === 1 && k.z === 1) return { x: cols.x, y: cols.y, z: cols.z, stride: 1 };
	if (k.positions === 3 || (count === 0 && k.positions === 1)) {
		var p = cols.positions;
		return { x: p, y: p.subarray(1), z: p.subarray(2), stride: 3 };
	}
	throw bad(fn + " needs x, y, z columns or a k = 3 positions column");
}

/**
 * Refuse a point count the index cannot number (order is a Uint32Array).
 * @param {number} n
 */
export function checkPointCount(n) {
	if (n > MAX_POINTS) throw new LasError(ERROR_CODES.TOO_MANY_POINTS, "the neighbour index takes at most 4,294,967,295 points, not " + n);
}

function hashKey(key, mask) {
	var lo = key % 4294967296, hi = (key - lo) / 4294967296;
	return (Math.imul(lo ^ Math.imul(hi, 0x85EBCA6B), 0x9E3779B1) >>> 0) & mask;
}

function nextPow2(n) {
	var p = 16;
	while (p < n) p *= 2;
	return p;
}

/**
 * Build the grid over coordinates.
 * @param {{x, y, z, stride}} coords - from coordsOf.
 * @param {number} count - points.
 * @param {number} [cellSize] - cell edge; omitted: about 16 points per cell.
 * @param {boolean} [xy] - ignore Z (nz = 1).
 * @returns {object} PointIndex
 */
export function buildGrid(coords, count, cellSize, xy) {
	if (cellSize !== undefined && !(typeof cellSize === "number" && cellSize > 0 && isFinite(cellSize))) throw bad("cellSize must be a positive finite number, not " + String(cellSize));
	var X = coords.x, Y = coords.y, Z = coords.z, st = coords.stride;

	// 1. Bounds
	var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (var i = 0, o = 0; i < count; i++, o += st) {
		var a = X[o], b = Y[o], c = xy ? 0 : Z[o];
		if (a < lo[0]) lo[0] = a; if (a > hi[0]) hi[0] = a;
		if (b < lo[1]) lo[1] = b; if (b > hi[1]) hi[1] = b;
		if (c < lo[2]) lo[2] = c; if (c > hi[2]) hi[2] = c;
	}
	if (count === 0) { lo = [0, 0, 0]; hi = [0, 0, 0]; }
	var ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
	if (cellSize === undefined) {
		var prod = 1, d = 0;
		ext.forEach(function (e) { if (e > 0) { prod *= e; d++; } });
		cellSize = d === 0 ? 1 : Math.pow(16 * prod / count, 1 / d);
	}
	var nx = Math.floor(ext[0] / cellSize) + 1, ny = Math.floor(ext[1] / cellSize) + 1, nz = Math.floor(ext[2] / cellSize) + 1;
	if (nx * ny * nz > MAX_CELLS) throw bad("cellSize too small for this extent: " + nx + " × " + ny + " × " + nz + " cells is more than 2^53");
	var inv = 1 / cellSize, x0 = lo[0], y0 = lo[1], z0 = lo[2];
	function keyOf(o) {
		var cx = Math.floor((X[o] - x0) * inv); if (cx >= nx) cx = nx - 1;
		var cy = Math.floor((Y[o] - y0) * inv); if (cy >= ny) cy = ny - 1;
		var cz = 0;
		if (!xy) { cz = Math.floor((Z[o] - z0) * inv); if (cz >= nz) cz = nz - 1; }
		return (cx * ny + cy) * nz + cz;
	}

	// 2. Count points per cell into the hash table
	var cap = nextPow2(2 * Math.min(nx * ny * nz, Math.ceil(count / 16)));
	var mask = cap - 1, used = 0;
	var keys = new Float64Array(cap).fill(EMPTY), length = new Uint32Array(cap);
	function grow() {
		var oldK = keys, oldL = length;
		cap *= 2; mask = cap - 1;
		keys = new Float64Array(cap).fill(EMPTY); length = new Uint32Array(cap);
		for (var s = 0; s < oldK.length; s++) {
			if (oldK[s] === EMPTY) continue;
			var h = hashKey(oldK[s], mask);
			while (keys[h] !== EMPTY) h = (h + 1) & mask;
			keys[h] = oldK[s]; length[h] = oldL[s];
		}
	}
	for (i = 0, o = 0; i < count; i++, o += st) {
		var key = keyOf(o), h = hashKey(key, mask);
		while (keys[h] !== EMPTY && keys[h] !== key) h = (h + 1) & mask;
		if (keys[h] === EMPTY) {
			if (2 * (used + 1) > cap) {
				grow();
				h = hashKey(key, mask);
				while (keys[h] !== EMPTY) h = (h + 1) & mask;
			}
			keys[h] = key; used++;
		}
		length[h]++;
	}

	// 3. Prefix sums give each cell's start; place point numbers (stable)
	var start = new Uint32Array(cap), run = 0;
	for (var s = 0; s < cap; s++) { start[s] = run; run += length[s]; }
	var order = new Uint32Array(count);
	for (i = 0, o = 0; i < count; i++, o += st) {
		var k2 = keyOf(o), h2 = hashKey(k2, mask);
		while (keys[h2] !== k2) h2 = (h2 + 1) & mask;
		order[start[h2]++] = i;
	}
	for (s = 0; s < cap; s++) start[s] -= length[s];

	return { count: count, cellSize: cellSize, min: [x0, y0, z0], nx: nx, ny: ny, nz: nz, order: order, keys: keys, start: start, length: length, mask: mask, coords: coords };
}

/**
 * Build a neighbour index over point columns.
 * @param {object} cols - point columns with x, y, z, or a k = 3 positions column.
 * @param {{cellSize?: number}} [opts] - cellSize omitted: about 16 points per cell.
 * @returns {object} PointIndex { count, cellSize, min, nx, ny, nz, order, keys, start, length, mask, coords }
 */
export function buildIndex(cols, opts) {
	var coords = coordsOf(cols, "buildIndex");
	checkPointCount(cols.count);
	return buildGrid(coords, cols.count, opts ? opts.cellSize : undefined, false);
}

/**
 * The hash-table slot of cell (ix, iy, iz), or -1 when the cell is empty or outside the grid.
 * @param {object} index - PointIndex.
 * @returns {number}
 */
export function lookup(index, ix, iy, iz) {
	if (ix < 0 || iy < 0 || iz < 0 || ix >= index.nx || iy >= index.ny || iz >= index.nz) return -1;
	var key = (ix * index.ny + iy) * index.nz + iz, keys = index.keys, mask = index.mask;
	var h = hashKey(key, mask);
	while (keys[h] !== EMPTY) {
		if (keys[h] === key) return h;
		h = (h + 1) & mask;
	}
	return -1;
}

/**
 * Refuse an index that is not self-consistent.
 * @param {object} index - PointIndex.
 * @param {string} fn - the calling function's name, for the message.
 */
export function checkIndex(index, fn) {
	var ok = index !== null && typeof index === "object" && index.order instanceof Uint32Array && index.order.length === index.count && index.coords;
	if (ok && index.count > 0) {
		var need = (index.count - 1) * index.coords.stride + 1;
		ok = index.coords.x.length >= need && index.coords.y.length >= need && index.coords.z.length >= need;
	}
	if (!ok) throw bad(fn + ": index is not self-consistent (rebuild it with buildIndex)");
}
