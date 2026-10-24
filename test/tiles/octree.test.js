// test/tiles/octree.test.js
//==========================================================
// The octree core on raw records: keys and octants; the grid sample
// (one point per occupied 128³ cell, nearest the centre) against an
// oracle written here; chunk octrees keep every point once, in its
// node's box, leaves within tilePoints; duplicates and small boxes
// stop splitting; the same input gives the same bytes.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyOf, parseKey, childKey, octantOf, nodeBox, sampleParent, buildChunkOctree, SAMPLE_GRID, MAX_DEPTH, MIN_EDGE } from "../../src/tiles/octree.js";
import { rawRecords, pointsOf, randomRaw } from "../helpers/tileClouds.js";

var LEN = 20;
var OPTS = { tilePoints: 5000, maxDepth: MAX_DEPTH, minEdge: MIN_EDGE };
function sortedIds(records) { return pointsOf(records, LEN).map(function (p) { return p[3]; }).sort(function (a, b) { return a - b; }); }
function inBox(p, b) { return p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2]; }

test("constants", function () {
	assert.equal(SAMPLE_GRID, 128); assert.equal(MAX_DEPTH, 20); assert.equal(MIN_EDGE, 100);
});

test("keys: child, parse, octant, box", function () {
	assert.equal(keyOf(2, 3, 0, 1), "2-3-0-1");
	assert.deepEqual(parseKey("2-3-0-1"), [2, 3, 0, 1]);
	assert.equal(childKey("0-0-0-0", 5), "1-1-0-1");
	assert.equal(childKey("1-1-0-1", 2), "2-2-1-2");
	var cube = { min: [1000, 2000, 3000], edge: 800 };
	assert.equal(octantOf(cube, "0-0-0-0", 1800, 2800, 3800), 7);   // the max face: the last cell
	assert.equal(octantOf(cube, "0-0-0-0", 1000, 2000, 3000), 0);
	assert.equal(octantOf(cube, "0-0-0-0", 1400, 2000, 3399), 1);
	assert.equal(octantOf(cube, "1-1-0-0", 1799, 2399, 3000), 3);
	assert.deepEqual(nodeBox(cube, "1-1-0-1"), { min: [1400, 2000, 3400], max: [1800, 2400, 3800] });
});

test("sampleParent keeps one point per occupied cell, the nearest the centre", function () {
	var cube = { min: [0, 0, 0], edge: 1280 }, key = "0-0-0-0";
	var pts = randomRaw(2000, 7, 0, 1281);
	var groups = [[], [], [], [], [], [], [], []];
	pts.forEach(function (p) { groups[octantOf(cube, key, p[0], p[1], p[2])].push(p); });
	var all = rawRecords(pts, LEN), byId = pointsOf(all, LEN);
	var children = groups.map(function (g, o) {
		var ids = g.map(function (p) { return pts.indexOf(p); });
		var recs = new Uint8Array(ids.length * LEN);
		ids.forEach(function (id, j) { recs.set(all.subarray(id * LEN, id * LEN + LEN), j * LEN); });
		return { key: childKey(key, o), records: recs };
	}).filter(function (c) { return c.records.length; });
	// oracle: gather order, a 128³ grid of 10-unit cells, nearest the cell centre, ties to the earlier
	var best = new Map();
	children.forEach(function (c) {
		pointsOf(c.records, LEN).forEach(function (p) {
			var cx = Math.min(127, Math.floor(p[0] / 10)), cy = Math.min(127, Math.floor(p[1] / 10)), cz = Math.min(127, Math.floor(p[2] / 10));
			var d = Math.pow(p[0] - (cx + 0.5) * 10, 2) + Math.pow(p[1] - (cy + 0.5) * 10, 2) + Math.pow(p[2] - (cz + 0.5) * 10, 2);
			var k = cx + 128 * (cy + 128 * cz), b = best.get(k);
			if (!b || d < b.d) best.set(k, { d: d, id: p[3] });
		});
	});
	var chosen = new Set(Array.from(best.values()).map(function (b) { return b.id; }));
	var order = [];
	children.forEach(function (c) { pointsOf(c.records, LEN).forEach(function (p) { if (chosen.has(p[3])) order.push(p[3]); }); });
	var out = sampleParent(cube, key, children, LEN);
	assert.deepEqual(pointsOf(out.parent, LEN).map(function (p) { return p[3]; }), order);
	out.children.forEach(function (c, j) {
		assert.equal(c.key, children[j].key);
		var left = pointsOf(children[j].records, LEN).filter(function (p) { return !chosen.has(p[3]); }).map(function (p) { return p[3]; });
		assert.deepEqual(pointsOf(c.records, LEN).map(function (p) { return p[3]; }), left);
	});
	assert.ok(byId.length === 2000);
});

test("buildChunkOctree: every point once, in its node's box, leaves within tilePoints", function () {
	var cube = { min: [-500000, 200000, 0], edge: 1000000 };
	var pts = randomRaw(200000, 3, 0, 1000000).map(function (p) { return [p[0] - 500000, p[1] + 200000, Math.floor(p[2] / 50)]; });
	var nodes = buildChunkOctree(rawRecords(pts, LEN), LEN, cube, "0-0-0-0", OPTS);
	var ids = [], keys = new Set(nodes.map(function (n) { return n.key; }));
	nodes.forEach(function (n) {
		assert.equal(n.count * LEN, n.records.length);
		var box = nodeBox(cube, n.key);
		pointsOf(n.records, LEN).forEach(function (p) { assert.ok(inBox(p, box), "point " + p[3] + " outside " + n.key); ids.push(p[3]); });
		var hasChild = [0, 1, 2, 3, 4, 5, 6, 7].some(function (o) { return keys.has(childKey(n.key, o)); });
		if (!hasChild) assert.ok(n.count <= 5000, "leaf " + n.key + " holds " + n.count);
		else assert.ok(n.count >= 1, "parent " + n.key + " is empty");
		if (n.key !== "0-0-0-0") assert.ok(n.count > 0 || hasChild, n.key + " is empty with no children");
	});
	ids.sort(function (a, b) { return a - b; });
	assert.equal(ids.length, 200000);
	ids.forEach(function (id, i) { assert.equal(id, i); });
	var sorted = nodes.map(function (n) { return parseKey(n.key); });
	for (var i = 1; i < sorted.length; i++) {
		var a = sorted[i - 1], b = sorted[i];
		assert.ok(a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && (a[2] < b[2] || (a[2] === b[2] && a[3] < b[3]))))), "key order at " + i);
	}
});

test("buildChunkOctree: stacked duplicates stop at the depth limit", function () {
	var pts = []; for (var i = 0; i < 60000; i++) pts.push([12345, 6789, 10]);
	var cube = { min: [0, 0, 0], edge: 1 << 26 };
	var nodes = buildChunkOctree(rawRecords(pts, LEN), LEN, cube, "0-0-0-0", OPTS);
	var total = nodes.reduce(function (s, n) { return s + n.count; }, 0);
	assert.equal(total, 60000);
	nodes.forEach(function (n) { assert.ok(parseKey(n.key)[0] <= MAX_DEPTH); });
	assert.ok(nodes.some(function (n) { return n.count > 5000; }), "one leaf holds the stack");
});

test("buildChunkOctree: a node under 2 × MIN_EDGE does not split", function () {
	var cube = { min: [0, 0, 0], edge: 1000 };
	var pts = randomRaw(3000, 9, 0, 150);
	var nodes = buildChunkOctree(rawRecords(pts, LEN), LEN, cube, "0-0-0-0", { tilePoints: 10, maxDepth: MAX_DEPTH, minEdge: MIN_EDGE });
	var keys = new Set(nodes.map(function (n) { return n.key; }));
	nodes.forEach(function (n) {
		var edge = 1000 / Math.pow(2, parseKey(n.key)[0]);
		if (edge < 200) [0, 1, 2, 3, 4, 5, 6, 7].forEach(function (o) { assert.ok(!keys.has(childKey(n.key, o)), n.key + " split at edge " + edge); });
	});
	assert.equal(Math.max.apply(null, nodes.map(function (n) { return parseKey(n.key)[0]; })), 3);
	assert.equal(nodes.reduce(function (s, n) { return s + n.count; }, 0), 3000);
});

test("buildChunkOctree is deterministic", function () {
	var cube = { min: [0, 0, 0], edge: 100000 };
	var recs = rawRecords(randomRaw(30000, 5, 0, 100000), LEN);
	var a = buildChunkOctree(recs, LEN, cube, "0-0-0-0", { tilePoints: 1000, maxDepth: MAX_DEPTH, minEdge: MIN_EDGE });
	var b = buildChunkOctree(recs.slice(), LEN, cube, "0-0-0-0", { tilePoints: 1000, maxDepth: MAX_DEPTH, minEdge: MIN_EDGE });
	assert.deepEqual(a.map(function (n) { return n.key; }), b.map(function (n) { return n.key; }));
	a.forEach(function (n, i) { assert.deepEqual(n.records, b[i].records); });
	assert.ok(sortedIds(recs).length === 30000);
});

test("buildChunkOctree under a deeper root key", function () {
	var cube = { min: [0, 0, 0], edge: 1 << 20 };
	var pts = randomRaw(20000, 11, 0, 1 << 17).map(function (p) { return [p[0] + (1 << 19), p[1], p[2]]; });   // inside 3-4-0-0
	var nodes = buildChunkOctree(rawRecords(pts, LEN), LEN, cube, "3-4-0-0", { tilePoints: 2000, maxDepth: MAX_DEPTH, minEdge: MIN_EDGE });
	assert.equal(nodes[0].key, "3-4-0-0");
	nodes.forEach(function (n) { assert.ok(parseKey(n.key)[0] >= 3); pointsOf(n.records, LEN).forEach(function (p) { assert.ok(inBox(p, nodeBox(cube, n.key))); }); });
	assert.equal(nodes.reduce(function (s, n) { return s + n.count; }, 0), 20000);
});
