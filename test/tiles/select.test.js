// test/tiles/select.test.js
//==========================================================
// selectTiles against a brute force written here (all nodes, the
// same rule: the largest on screen among the visible children of
// taken nodes, taken while it fits the budget): ortho and perspective
// cameras, culling, a box across the near plane, the camera inside
// the cloud with a local origin, budget 0, bad views.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { buildTiles } from "../../src/tiles/build.js";
import { selectTiles } from "../../src/tiles/select.js";
import { parseKey } from "../../src/tiles/octree.js";
import { tileLas } from "../helpers/tileFiles.js";
import { rng } from "../helpers/clouds.js";
import { perspective, orthographic, lookAt, multiply } from "../helpers/cameras.js";

// a surface, as scans are: about 16,000 points a node (a sparse volume puts nearly every point in the root)
var bytes = tileLas({ n: 100000, seed: 31, span: 400, flatZ: 300 });
var STORE = await buildTiles(await openLas(bytes), { where: { memory: true }, tilePoints: 500 });
var M = STORE.manifest;
var CX = 478200, CY = 6772200, CZ = 300;

function parentOf(key) { var k = parseKey(key); return k[0] ? (k[0] - 1) + "-" + Math.floor(k[1] / 2) + "-" + Math.floor(k[2] / 2) + "-" + Math.floor(k[3] / 2) : null; }
function keyLess(a, b) { var p = parseKey(a), q = parseKey(b); for (var i = 0; i < 4; i++) if (p[i] !== q[i]) return p[i] < q[i]; return false; }

// the oracle: corners through the matrix, outside = all 8 corners outside one clip plane
function measure(view, box) {
	var m = view.viewProjection, o = view.localOrigin || { x: 0, y: 0, z: 0 }, xs = [], ys = [], inside = [0, 0, 0, 0, 0, 0], infinite = false;
	for (var i = 0; i < 8; i++) {
		var x = (i % 2 ? box[3] : box[0]) - o.x, y = (Math.floor(i / 2) % 2 ? box[4] : box[1]) - o.y, z = (Math.floor(i / 4) ? box[5] : box[2]) - o.z;
		var cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cz = m[2] * x + m[6] * y + m[10] * z + m[14], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
		[cw + cx, cw - cx, cw + cy, cw - cy, cw + cz, cw - cz].forEach(function (d, j) { if (d >= 0) inside[j]++; });
		if (cw <= 0) infinite = true;
		else { xs.push((cx / cw + 1) / 2 * view.width); ys.push((cy / cw + 1) / 2 * view.height); }
	}
	var visible = inside.every(function (c) { return c > 0; });
	var size = infinite ? Infinity : Math.hypot(Math.max.apply(null, xs) - Math.min.apply(null, xs), Math.max.apply(null, ys) - Math.min.apply(null, ys));
	return { visible: visible, size: size };
}

// a node's box and every box below it (descendants found by their key, not the library's tables)
function subtreeBox(manifest, key) {
	var p = parseKey(key), out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	Object.keys(manifest.nodes).forEach(function (k) {
		var q = parseKey(k), f = Math.pow(2, q[0] - p[0]), b = manifest.nodes[k].box;
		if (q[0] < p[0] || !b || Math.floor(q[1] / f) !== p[1] || Math.floor(q[2] / f) !== p[2] || Math.floor(q[3] / f) !== p[3]) return;
		for (var a = 0; a < 3; a++) { out[a] = Math.min(out[a], b[a]); out[3 + a] = Math.max(out[3 + a], b[3 + a]); }
	});
	return out;
}

function brute(manifest, view) {
	var budget = view.pointBudget === undefined ? 10e6 : view.pointBudget, minPx = view.minPixels === undefined ? 100 : view.minPixels;
	var keys = Object.keys(manifest.nodes), taken = new Map(), rejected = new Set(), out = [], used = 0;
	var m = {};
	keys.forEach(function (k) { m[k] = measure(view, subtreeBox(manifest, k)); });
	taken.set("0-0-0-0", true); out.push("0-0-0-0"); used = manifest.nodes["0-0-0-0"].count;
	for (;;) {
		var best = null;
		keys.forEach(function (k) {
			var p = parentOf(k);
			if (!p || taken.has(k) || rejected.has(k) || !taken.has(p) || m[p].size < minPx || !m[k].visible) return;
			if (!best || m[k].size > m[best].size || (m[k].size === m[best].size && keyLess(k, best))) best = k;
		});
		if (!best) break;
		if (used + manifest.nodes[best].count <= budget) { taken.set(best, true); out.push(best); used += manifest.nodes[best].count; } else rejected.add(best);
	}
	return out;
}

function cameras() {
	var r = rng(5), list = [];
	for (var i = 0; i < 40; i++) {
		var eye = [CX + (r() - 0.5) * 1200, CY + (r() - 0.5) * 1200, CZ + 50 + r() * 600], target = [CX + (r() - 0.5) * 300, CY + (r() - 0.5) * 300, CZ];
		var proj = i % 2 ? perspective(30 + r() * 50, 1.6, 1, 5000) : orthographic(-100 - r() * 300, 100 + r() * 300, 80 + r() * 200, -80 - r() * 200, 0.1, 10000);
		list.push({ viewProjection: multiply(proj, lookAt(eye, target)), width: 1600, height: 1000, pointBudget: 17000 + Math.floor(r() * 60000), minPixels: 20 + r() * 200 });
	}
	return list;
}

test("selectTiles equals a brute force", function () {
	var deep = 0;
	cameras().forEach(function (view, i) {
		var got = selectTiles(STORE, view), want = brute(M, view);
		assert.deepEqual(got.map(function (n) { return n.key; }), want, "camera " + i);
		if (got.length > 5) deep++;
		var sum = got.reduce(function (s, n) { return s + n.count; }, 0);
		assert.ok(sum <= view.pointBudget || got.length === 1, "camera " + i + " over budget");
		var seen = new Set();
		got.forEach(function (n) { var p = parentOf(n.key); assert.ok(!p || seen.has(p), n.key + " before its parent"); seen.add(n.key); assert.equal(n.depth, parseKey(n.key)[0]); assert.equal(n.count, M.nodes[n.key].count); });
	});
	assert.ok(deep >= 20, "only " + deep + " of 40 cameras went past the first levels");
});

test("culling: looking away gives the root only; the near plane counts as infinitely large", function () {
	var away = multiply(perspective(45, 1.6, 1, 5000), lookAt([CX, CY, CZ + 300], [CX, CY, CZ + 1000], [0, 1, 0]));
	assert.deepEqual(selectTiles(STORE, { viewProjection: away, width: 1600, height: 1000 }).map(function (n) { return n.key; }), ["0-0-0-0"]);
	var low = multiply(perspective(60, 1.6, 1, 5000), lookAt([CX - 150, CY - 150, CZ + 20], [CX + 100, CY + 100, CZ], [0, 0, 1]));
	var view = { viewProjection: low, width: 1600, height: 1000, pointBudget: 30000 };
	var got = selectTiles(STORE, view);
	assert.deepEqual(got.map(function (n) { return n.key; }), brute(M, view));
	assert.ok(got.length > 1);
});

test("the camera inside the cloud, Kirra's orthographic camera, a local origin", function () {
	var origin = { x: 478000, y: 6772000, z: 0 };
	var vp = multiply(orthographic(-100, 100, 50, -50, 0.1, 10000), lookAt([CX - origin.x, CY - origin.y, CZ - origin.z], [CX - origin.x + 10, CY - origin.y + 5, CZ - origin.z - 10], [0, 0, 1]));
	var view = { viewProjection: vp, width: 1200, height: 600, pointBudget: 40000, localOrigin: origin };
	var got = selectTiles(STORE, view);
	assert.deepEqual(got.map(function (n) { return n.key; }), brute(M, view));
	got.forEach(function (n) { Object.keys(n.box).forEach(function (k) { assert.ok(isFinite(n.box[k]), n.key + " box " + k); }); });
	assert.ok(got[0].box.minX < 1000, "boxes are in the view's coordinates (minus the local origin)");
});

test("budget 0 gives the root; the manifest alone gives the same result", function () {
	var view = cameras()[3];
	assert.deepEqual(selectTiles(STORE, Object.assign({}, view, { pointBudget: 0 })).map(function (n) { return n.key; }), ["0-0-0-0"]);
	assert.deepEqual(selectTiles(JSON.parse(JSON.stringify(M)), view), selectTiles(STORE, view));
});

test("a transformed store moves the boxes", function () {
	var shifted = JSON.parse(JSON.stringify(M));
	shifted.transform = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [1000, 0, 0] };
	var view = cameras()[1];
	var moved = JSON.parse(JSON.stringify(M));
	Object.keys(moved.nodes).forEach(function (k) { var b = moved.nodes[k].box; if (b) { b[0] += 1000; b[3] += 1000; } });
	assert.deepEqual(selectTiles(shifted, view), selectTiles(moved, view));
});

test("bad views are refused", function () {
	var good = cameras()[0];
	[{}, Object.assign({}, good, { viewProjection: [1, 2] }), Object.assign({}, good, { width: 0 }), Object.assign({}, good, { pointBudget: -1 }), Object.assign({}, good, { localOrigin: { x: "a" } })].forEach(function (v) {
		assert.throws(function () { selectTiles(STORE, v); }, function (e) { return e.code === "INVALID_ARGUMENT"; });
	});
});

test("clipBox: tiles wholly outside it are not picked, so the budget goes to what it shows", function () {
	var origin = { x: 478000, y: 6772000, z: 0 };
	var vp = multiply(orthographic(-250, 250, 150, -150, 0.1, 10000), lookAt([CX - origin.x, CY - origin.y, CZ - origin.z + 500], [CX - origin.x, CY - origin.y, CZ - origin.z], [0, 1, 0]));
	var base = { viewProjection: vp, width: 1600, height: 960, pointBudget: 40000, minPixels: 20, localOrigin: origin };
	var box = { minX: CX - origin.x - 40, maxX: CX - origin.x + 40, minY: CY - origin.y - 40, maxY: CY - origin.y + 40 };   // no Z limit
	function overlaps(key) {
		var b = subtreeBox(M, key);
		return !(b[3] - origin.x < box.minX || b[0] - origin.x > box.maxX || b[4] - origin.y < box.minY || b[1] - origin.y > box.maxY);
	}
	var plain = selectTiles(STORE, base), cropped = selectTiles(STORE, Object.assign({}, base, { clipBox: box }));
	cropped.forEach(function (n) { assert.ok(n.key === "0-0-0-0" || overlaps(n.key), n.key + " is outside the crop box"); });
	var inside = function (list) { return list.filter(function (n) { return overlaps(n.key); }).reduce(function (s, n) { return s + n.count; }, 0); };
	assert.ok(inside(cropped) > inside(plain), "the crop picked " + inside(cropped) + " points inside the box, no crop " + inside(plain));
	assert.ok(cropped.length > 1);
	// a box that holds everything changes nothing; one far away leaves the root only
	var all = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9, minZ: -1e9, maxZ: 1e9 };
	assert.deepEqual(selectTiles(STORE, Object.assign({}, base, { clipBox: all })), plain);
	assert.deepEqual(selectTiles(STORE, Object.assign({}, base, { clipBox: { minX: 1e7, maxX: 1e7 + 5 } })).map(function (n) { return n.key; }), ["0-0-0-0"]);
	// Z counts too
	var flat = selectTiles(STORE, Object.assign({}, base, { clipBox: Object.assign({}, box, { minZ: 5000, maxZ: 6000 }) }));
	assert.deepEqual(flat.map(function (n) { return n.key; }), ["0-0-0-0"]);
});

test("clipBox is checked", function () {
	var vp = multiply(orthographic(-250, 250, 150, -150, 0.1, 10000), lookAt([CX, CY, CZ + 500], [CX, CY, CZ], [0, 1, 0]));
	var v = { viewProjection: vp, width: 800, height: 400 };
	[{ minX: 5, maxX: 1 }, { minY: NaN }, { maxZ: "3" }, { minZ: 2, maxZ: 1 }].forEach(function (b) { assert.throws(function () { selectTiles(STORE, Object.assign({}, v, { clipBox: b })); }, { code: "INVALID_ARGUMENT" }); });
	assert.throws(function () { selectTiles(STORE, Object.assign({}, v, { clipBox: 5 })); }, { code: "INVALID_ARGUMENT" });
	assert.doesNotThrow(function () { selectTiles(STORE, Object.assign({}, v, { clipBox: {} })); });
	assert.doesNotThrow(function () { selectTiles(STORE, Object.assign({}, v, { clipBox: null })); });
});
