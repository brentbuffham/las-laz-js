// src/tiles/chunkNodes.js
//==========================================================
// One build chunk's nodes, ready to write: buildChunkOctree, each
// node's raw box (int32 min / max of its records), and, for a
// compressed store, every node but the chunk root packed as one LAZ
// chunk right away (the root is sampled again by the levels above,
// so it stays raw until the end). Runs on the build's thread or in a
// pool worker (src/laz/chunkWorker.js, op "octree").
//==========================================================

import { buildChunkOctree } from "./octree.js";
import { createChunkCompressor } from "../laz/compressChunk.js";

/** [minX, minY, minZ, maxX, maxY, maxZ] of raw records' int32 X / Y / Z, or null for none. */
export function rawBox(records, recordLength) {
	if (!records.length) return null;
	var v = new DataView(records.buffer, records.byteOffset, records.byteLength), b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (var p = 0; p < records.length; p += recordLength) {
		for (var a = 0; a < 3; a++) {
			var r = v.getInt32(p + 4 * a, true);
			if (r < b[a]) b[a] = r;
			if (r > b[3 + a]) b[3 + a] = r;
		}
	}
	return b;
}

/**
 * @param {Uint8Array} records - the chunk's raw records
 * @param {number} recordLength
 * @param {object} cube
 * @param {string} rootKey
 * @param {object} opts - buildChunkOctree's
 * @param {object|null} laz - the store's LAZ VLR, or null
 * @returns {Array<{key: string, count: number, records: Uint8Array, packed: boolean, box: number[]|null}>}
 */
export function chunkNodes(records, recordLength, cube, rootKey, opts, laz) {
	var pack = laz ? createChunkCompressor(laz, recordLength) : null;
	return buildChunkOctree(records, recordLength, cube, rootKey, opts).map(function (n) {
		var packed = !!pack && n.key !== rootKey;
		return { key: n.key, count: n.count, records: packed ? pack(n.records, 0, n.count) : n.records, packed: packed, box: rawBox(n.records, recordLength) };
	});
}
