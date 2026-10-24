// src/tiles/octree.js
//==========================================================
// The octree core, pure, on raw LAS records (int32 X / Y / Z at bytes
// 0 / 4 / 8 of every point format), so it never meets scale / offset
// rounding. A cube is { min: [X, Y, Z], edge } in raw units; node
// "D-X-Y-Z" is cell (X, Y, Z) of the 2^D grid over it; a node's max
// face is inclusive. Additive (Potree-style): a parent keeps a grid
// sample of its children's points, moved up from them, so every
// point is stored once.
// Octant bits: x 1, y 2, z 4.
//==========================================================

/** Cells per node edge in the sampling grid. */
export var SAMPLE_GRID = 128;
/** No node splits below this depth. */
export var MAX_DEPTH = 20;
/** No node splits once its edge is under 2 × this many raw units. */
export var MIN_EDGE = 100;

/** @returns {string} "d-x-y-z" */
export function keyOf(d, x, y, z) { return d + "-" + x + "-" + y + "-" + z; }

/** @returns {number[]} [d, x, y, z] */
export function parseKey(key) { return key.split("-").map(Number); }

/** The key of a node's child in octant o (0-7). */
export function childKey(key, o) {
	var k = parseKey(key);
	return keyOf(k[0] + 1, 2 * k[1] + o % 2, 2 * k[2] + Math.floor(o / 2) % 2, 2 * k[3] + Math.floor(o / 4));
}

function edgeAt(cube, d) { return cube.edge / Math.pow(2, d); }

function clampCell(c, n) { return c < 0 ? 0 : c >= n ? n - 1 : c; }

/**
 * The child octant of node `key` that a raw point falls in.
 * @returns {number} 0-7
 */
export function octantOf(cube, key, X, Y, Z) {
	var k = parseKey(key), n = Math.pow(2, k[0] + 1), e = edgeAt(cube, k[0] + 1);
	var cx = clampCell(Math.floor((X - cube.min[0]) / e), n) - 2 * k[1];
	var cy = clampCell(Math.floor((Y - cube.min[1]) / e), n) - 2 * k[2];
	var cz = clampCell(Math.floor((Z - cube.min[2]) / e), n) - 2 * k[3];
	return (cx > 0 ? 1 : 0) + (cy > 0 ? 2 : 0) + (cz > 0 ? 4 : 0);
}

/**
 * A node's box in raw units (max inclusive).
 * @returns {{min: number[], max: number[]}}
 */
export function nodeBox(cube, key) {
	var k = parseKey(key), e = edgeAt(cube, k[0]);
	var min = [cube.min[0] + k[1] * e, cube.min[1] + k[2] * e, cube.min[2] + k[3] * e];
	return { min: min, max: [min[0] + e, min[1] + e, min[2] + e] };
}

/**
 * Move a grid sample of the children's points up into their parent: per cell of a
 * SAMPLE_GRID³ grid over the parent's box, the candidate nearest the cell centre (ties to
 * the earlier in gather order: children as given, each child's points in order).
 * @param {object} cube
 * @param {string} parentKey
 * @param {Array<{key: string, records: Uint8Array}>} children - in octant order
 * @param {number} recordLength
 * @returns {{parent: Uint8Array, children: Array<{key: string, records: Uint8Array}>}}
 */
export function sampleParent(cube, parentKey, children, recordLength) {
	var box = nodeBox(cube, parentKey), cell = (box.max[0] - box.min[0]) / SAMPLE_GRID;
	var best = new Map(), flags = [];
	children.forEach(function (c, ci) {
		var r = c.records, v = new DataView(r.buffer, r.byteOffset, r.byteLength), n = r.length / recordLength;
		flags.push(new Uint8Array(n));
		for (var i = 0; i < n; i++) {
			var p = i * recordLength;
			var X = v.getInt32(p, true), Y = v.getInt32(p + 4, true), Z = v.getInt32(p + 8, true);
			var cx = clampCell(Math.floor((X - box.min[0]) / cell), SAMPLE_GRID);
			var cy = clampCell(Math.floor((Y - box.min[1]) / cell), SAMPLE_GRID);
			var cz = clampCell(Math.floor((Z - box.min[2]) / cell), SAMPLE_GRID);
			var dx = X - (box.min[0] + (cx + 0.5) * cell), dy = Y - (box.min[1] + (cy + 0.5) * cell), dz = Z - (box.min[2] + (cz + 0.5) * cell);
			var d2 = dx * dx + dy * dy + dz * dz, k = cx + SAMPLE_GRID * (cy + SAMPLE_GRID * cz), b = best.get(k);
			if (b === undefined || d2 < b[2]) best.set(k, [ci, i, d2]);
		}
	});
	best.forEach(function (b) { flags[b[0]][b[1]] = 1; });
	var parent = new Uint8Array(best.size * recordLength), o = 0;
	var rest = children.map(function (c, ci) {
		var f = flags[ci], kept = new Uint8Array(c.records.length - countOf(f) * recordLength), q = 0;
		for (var i = 0; i < f.length; i++) {
			var rec = c.records.subarray(i * recordLength, (i + 1) * recordLength);
			if (f[i]) { parent.set(rec, o); o += recordLength; } else { kept.set(rec, q); q += recordLength; }
		}
		return { key: c.key, records: kept };
	});
	return { parent: parent, children: rest };
}

function countOf(flags) { var n = 0; for (var i = 0; i < flags.length; i++) n += flags[i]; return n; }

// Split records into the eight children of `key`, each in the records' order
function partition(cube, key, records, recordLength) {
	var n = records.length / recordLength, oct = new Uint8Array(n), sizes = [0, 0, 0, 0, 0, 0, 0, 0];
	var v = new DataView(records.buffer, records.byteOffset, records.byteLength);
	for (var i = 0; i < n; i++) {
		var p = i * recordLength;
		oct[i] = octantOf(cube, key, v.getInt32(p, true), v.getInt32(p + 4, true), v.getInt32(p + 8, true));
		sizes[oct[i]]++;
	}
	var parts = sizes.map(function (s) { return new Uint8Array(s * recordLength); }), fill = [0, 0, 0, 0, 0, 0, 0, 0];
	for (var j = 0; j < n; j++) {
		parts[oct[j]].set(records.subarray(j * recordLength, (j + 1) * recordLength), fill[oct[j]]);
		fill[oct[j]] += recordLength;
	}
	return parts;
}

function keyOrder(a, b) {
	var p = parseKey(a.key), q = parseKey(b.key);
	for (var i = 0; i < 4; i++) if (p[i] !== q[i]) return p[i] - q[i];
	return 0;
}

/**
 * Build the octree under one node from its records: split while a node holds more than
 * tilePoints (below maxDepth, edge at least 2 × minEdge), then sample bottom-up.
 * @param {Uint8Array} records
 * @param {number} recordLength
 * @param {object} cube
 * @param {string} rootKey
 * @param {{tilePoints: number, maxDepth: number, minEdge: number}} opts
 * @returns {Array<{key: string, records: Uint8Array, count: number}>} in key order; empty
 *   nodes with no descendants left out (the root always kept)
 */
export function buildChunkOctree(records, recordLength, cube, rootKey, opts) {
	var out = [];
	function build(key, recs) {
		var d = parseKey(key)[0], n = recs.length / recordLength;
		if (n <= opts.tilePoints || d >= opts.maxDepth || edgeAt(cube, d) < 2 * opts.minEdge) {
			out.push({ key: key, records: recs });
			return out.length - 1;
		}
		var parts = partition(cube, key, recs, recordLength), kids = [];
		recs = null;
		parts.forEach(function (part, o) {
			if (part.length) kids.push(build(childKey(key, o), part));
			parts[o] = null;
		});
		var s = sampleParent(cube, key, kids.map(function (i) { return out[i]; }), recordLength);
		kids.forEach(function (i, j) { out[i].records = s.children[j].records; });
		out.push({ key: key, records: s.parent });
		return out.length - 1;
	}
	build(rootKey, records);
	// drop nodes left empty with nothing under them, deepest first
	out.sort(function (a, b) { return parseKey(b.key)[0] - parseKey(a.key)[0]; });
	var live = new Set();
	out = out.filter(function (node) {
		var under = [0, 1, 2, 3, 4, 5, 6, 7].some(function (o) { return live.has(childKey(node.key, o)); });
		if (node.records.length || under || node.key === rootKey) { live.add(node.key); return true; }
		return false;
	});
	out.forEach(function (node) { node.count = node.records.length / recordLength; });
	return out.sort(keyOrder);
}
