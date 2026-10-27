// src/tiles/region.js
//==========================================================
// A plan region of a tile store, for the parallel runs on a store
// (findFragmentsParallel / findFacetsParallel given a TileStore): the
// nodes whose world box meets a box on two axes, and their points
// inside it, at full density (an additive octree keeps each point in
// one node, so every node that meets the box is read), each with its
// node's place in the key order and its index in the node. Positions
// are minus localOrigin, Float32. Nodes decode on this thread: the
// runs call it inside a worker.
//==========================================================

import { nodeWorldBox } from "./select.js";

var AXES = ["x", "y", "z"], MIN = ["minX", "minY", "minZ"], MAX = ["maxX", "maxY", "maxZ"];

/**
 * The store's nodes in key order (the order every region's node numbers refer to), with their world boxes.
 * @param {object} manifest
 * @returns {{keys: string[], boxes: Array<object>, counts: number[]}}
 */
export function storeNodes(manifest) {
	var keys = Object.keys(manifest.nodes).filter(function (k) { return manifest.nodes[k].count > 0; }).sort();
	return { keys: keys, boxes: keys.map(function (k) { return nodeWorldBox(manifest, k); }), counts: keys.map(function (k) { return manifest.nodes[k].count; }) };
}

/**
 * The nodes meeting a box on two axes (world coordinates).
 * @param {{boxes: Array<object>}} nodes - storeNodes' result.
 * @param {number[]} axes - two of 0, 1, 2 (x, y, z).
 * @param {number[]} box - [u0, u1, v0, v1] on those axes, world.
 * @returns {number[]} node numbers (places in nodes.keys)
 */
export function nodesMeeting(nodes, axes, box) {
	var out = [];
	nodes.boxes.forEach(function (b, i) {
		if (b[MAX[axes[0]]] >= box[0] && b[MIN[axes[0]]] <= box[1] && b[MAX[axes[1]]] >= box[2] && b[MIN[axes[1]]] <= box[3]) out.push(i);
	});
	return out;
}

/**
 * Every point of the listed nodes inside the box, read at full density.
 * @param {object} store - an open TileStore.
 * @param {string[]} keys - storeNodes' keys.
 * @param {number[]} which - the node numbers to read (nodesMeeting).
 * @param {number[]} axes - the box's two axes.
 * @param {number[]} box - [u0, u1, v0, v1], world.
 * @param {{x: number, y: number, z: number}} origin - subtracted from every position.
 * @returns {Promise<{count: number, x: Float32Array, y: Float32Array, z: Float32Array, node: Uint32Array, index: Uint32Array}>}
 */
export async function readRegion(store, keys, which, axes, box, origin) {
	var parts = [], total = 0, o = [origin.x, origin.y, origin.z];
	var lo0 = box[0] - o[axes[0]], hi0 = box[1] - o[axes[0]], lo1 = box[2] - o[axes[1]], hi1 = box[3] - o[axes[1]];
	for (var w = 0; w < which.length; w++) {
		var pts = await store.readTile(keys[which[w]], { fields: ["x", "y", "z"], localOrigin: origin, float32: true });
		var U = pts[AXES[axes[0]]], V = pts[AXES[axes[1]]], keep = [];
		for (var i = 0; i < pts.count; i++) if (U[i] >= lo0 && U[i] <= hi0 && V[i] >= lo1 && V[i] <= hi1) keep.push(i);
		if (keep.length) { parts.push({ node: which[w], pts: pts, keep: keep }); total += keep.length; }
	}
	var x = new Float32Array(total), y = new Float32Array(total), z = new Float32Array(total), node = new Uint32Array(total), index = new Uint32Array(total), q = 0;
	parts.forEach(function (p) {
		for (var j = 0; j < p.keep.length; j++, q++) { var i = p.keep[j]; x[q] = p.pts.x[i]; y[q] = p.pts.y[i]; z[q] = p.pts.z[i]; node[q] = p.node; index[q] = i; }
	});
	return { count: total, x: x, y: y, z: z, node: node, index: index };
}
