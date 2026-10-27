// test/tiles/selectShape.test.js
//==========================================================
// Box, polygon and screen selections on a store, pruned by node box:
// the same points as the per-point rule on every node (read here,
// none skipped), and fewer nodes read (a node wholly inside is taken
// without reading it). Polygons concave, with tolerance and the
// "inside" boundary, Z limits, a rotated store; screen shapes through
// perspective and orthographic cameras, the camera inside the cloud;
// a top-down orthographic rectangle is the box below it. The screen
// rule checked against a projection written here; rectAgainstPolygon
// against points sampled in the rectangle.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { buildTiles } from "../../src/tiles/build.js";
import { selectBox, selectPolygon, selectScreen } from "../../src/ops/select.js";
import { makePolygonTest, rectAgainstPolygon } from "../../src/ops/polygon.js";
import { makeTransform } from "../../src/ops/transform.js";
import { tileLas } from "../helpers/tileFiles.js";
import { rng } from "../helpers/clouds.js";
import { perspective, orthographic, lookAt, multiply } from "../helpers/cameras.js";

var BYTES = tileLas({ pointFormat: 1, n: 60000, seed: 71, span: 400 });
var CX = 478200, CY = 6772200;
var LASSO = [478060, 6772050, 478330, 6772080, 478260, 6772190, 478350, 6772340, 478120, 6772300, 478180, 6772200];

async function build(extra) { return buildTiles(await openLas(BYTES), Object.assign({ where: { memory: new Map() }, tilePoints: 400 }, extra || {})); }
function id(g) { return Math.round(g * 1000); }

// counts the nodes a selection reads
function counting(store) {
	var read = { n: 0 }, inner = store.readTile.bind(store);
	store.readTile = function (key, opts) { read.n++; return inner(key, opts); };
	return read;
}

// the rule on every node, none skipped: ids, sorted
async function oracle(store, rule) {
	var out = [];
	for (var key of Object.keys(store.manifest.nodes)) {
		if (!store.manifest.nodes[key].count) continue;
		var t = await store.readTile(key, { fields: ["x", "y", "z", "gpsTime"] }), s = rule(t);
		for (var i = 0; i < s.length; i++) out.push(id(t.gpsTime[s[i]]));
	}
	return out.sort(function (a, b) { return a - b; });
}

async function idsOf(store, sel) {
	var out = [];
	for (var key of Object.keys(sel.tiles)) {
		var t = await store.readTile(key, { fields: ["gpsTime"] }), s = sel.tiles[key];
		for (var i = 0; i < s.length; i++) out.push(id(t.gpsTime[s[i]]));
	}
	return out.sort(function (a, b) { return a - b; });
}

function nodesWithPoints(store) { return Object.keys(store.manifest.nodes).filter(function (k) { return store.manifest.nodes[k].count; }).length; }

async function same(store, select, rule, label) {
	var read = counting(store), sel = await select(), reads = read.n;
	delete store.readTile;
	var got = await idsOf(store, sel), want = await oracle(store, rule);
	assert.equal(sel.count, want.length, label + ": count");
	assert.deepEqual(got, want, label + ": the same points");
	return reads;
}

test("selectPolygon: the per-point rule's points, and fewer nodes read", async function () {
	var store = await build(), all = nodesWithPoints(store);
	var reads = await same(store, function () { return store.selectPolygon(LASSO); }, function (t) { return selectPolygon(t, LASSO); }, "lasso");
	assert.ok(all > 40, all + " nodes");
	assert.ok(reads < all / 2, reads + " of " + all + " nodes read");
	await same(store, function () { return store.selectPolygon(LASSO, { boundary: "inside", tolerance: 3 }); }, function (t) { return selectPolygon(t, LASSO, { boundary: "inside", tolerance: 3 }); }, "inside, tolerance 3");
	await same(store, function () { return store.selectPolygon(LASSO, { tolerance: 3 }); }, function (t) { return selectPolygon(t, LASSO, { tolerance: 3 }); }, "touching, tolerance 3");
	await same(store, function () { return store.selectPolygon(LASSO, { minZ: 310, maxZ: 360 }); }, function (t) { return selectPolygon(t, LASSO, { minZ: 310, maxZ: 360 }); }, "Z limits");
});

test("selectPolygon and selectBox on a rotated, moved store", async function () {
	var store = await build();
	await store.transform(makeTransform({ rotateZ: 30, about: [CX, CY, 300], shift: [15, -8, 2] }));
	await same(store, function () { return store.selectPolygon(LASSO); }, function (t) { return selectPolygon(t, LASSO); }, "rotated lasso");
	var box = { minX: 478100.3, maxX: 478270.7, minY: 6772090.1, maxY: 6772260.9, minZ: 305 };
	await same(store, function () { return store.selectBox(box); }, function (t) { return selectBox(t, box); }, "rotated box");
});

test("selectBox: the per-point rule's points, and fewer nodes read", async function () {
	var store = await build(), all = nodesWithPoints(store);
	var box = { minX: 478050.5, maxX: 478330.5, minY: 6772040.5, maxY: 6772310.5 };
	var reads = await same(store, function () { return store.selectBox(box); }, function (t) { return selectBox(t, box); }, "box");
	assert.ok(reads < all / 2, reads + " of " + all + " nodes read");
	var thin = { minX: 478050.5, maxX: 478330.5, minY: 6772040.5, maxY: 6772310.5, minZ: 320, maxZ: 330 };
	await same(store, function () { return store.selectBox(thin); }, function (t) { return selectBox(t, thin); }, "box with Z limits");
});

// the screen rule, written here: through the matrix, inside the clip volume, the pixel y down
function onScreen(view, x, y, z) {
	var m = view.viewProjection, o = view.localOrigin || { x: 0, y: 0, z: 0 };
	x -= o.x; y -= o.y; z -= o.z;
	var cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cz = m[2] * x + m[6] * y + m[10] * z + m[14], w = m[3] * x + m[7] * y + m[11] * z + m[15];
	if (!(w > 0) || Math.abs(cx) > w || Math.abs(cy) > w || Math.abs(cz) > w) return null;
	return [(cx / w + 1) / 2 * view.width, (1 - cy / w) / 2 * view.height];
}

var W = 800, H = 600;
var PIXELS = [120, 90, 640, 140, 560, 330, 700, 520, 180, 470, 300, 300];
function perspectiveView(eye, target, origin) {
	var o = origin || { x: 0, y: 0, z: 0 };
	return { viewProjection: multiply(perspective(60, W / H, 1, 2000), lookAt([eye[0] - o.x, eye[1] - o.y, eye[2] - o.z], [target[0] - o.x, target[1] - o.y, target[2] - o.z])), width: W, height: H, localOrigin: origin };
}

test("selectScreen (in memory) is the projection rule", async function () {
	var cols = await (await openLas(BYTES)).readPoints({ fields: ["x", "y", "z"] });
	var view = perspectiveView([CX - 300, CY - 350, 600], [CX, CY, 300], { x: CX, y: CY, z: 0 });
	var poly = makePolygonTest(PIXELS), want = [];
	for (var i = 0; i < cols.count; i++) { var p = onScreen(view, cols.x[i], cols.y[i], cols.z[i]); if (p && poly.test(p[0], p[1])) want.push(i); }
	var got = selectScreen(cols, view, PIXELS);
	assert.ok(want.length > 1000 && want.length < cols.count, want.length + " points");
	assert.deepEqual(Array.from(got), want);
});

test("selectScreen on a store: perspective, the camera inside the cloud, orthographic", async function () {
	var store = await build(), all = nodesWithPoints(store);
	var outside = perspectiveView([CX - 300, CY - 350, 600], [CX, CY, 300], { x: CX, y: CY, z: 0 });
	var reads = await same(store, function () { return store.selectScreen(outside, PIXELS); }, function (t) { return selectScreen(t, outside, PIXELS); }, "perspective");
	assert.ok(reads < all / 2, reads + " of " + all + " nodes read");
	var inside = perspectiveView([CX, CY, 320], [CX + 100, CY + 60, 310]);
	await same(store, function () { return store.selectScreen(inside, PIXELS, { tolerance: 4 }); }, function (t) { return selectScreen(t, inside, PIXELS, { tolerance: 4 }); }, "inside the cloud");
	var slanted = { viewProjection: multiply(orthographic(-250, 250, 180, -180, 1, 3000), lookAt([CX + 400, CY - 500, 900], [CX, CY, 300])), width: W, height: H };
	await same(store, function () { return store.selectScreen(slanted, PIXELS, { boundary: "inside" }); }, function (t) { return selectScreen(t, slanted, PIXELS, { boundary: "inside" }); }, "orthographic, slanted");
});

test("selectScreen: a top-down orthographic rectangle is the box below it", async function () {
	var store = await build();
	// 1 pixel = 0.5 m; the view centred on (CX, CY), north up
	var view = { viewProjection: multiply(orthographic(-200, 200, 150, -150, 1, 1000), lookAt([CX, CY, 800], [CX, CY, 0], [0, 1, 0])), width: W, height: H };
	var rect = [100.313, 80.717, 650.937, 80.717, 650.937, 470.123, 100.313, 470.123];
	var box = { minX: CX - 200 + 100.313 / 2, maxX: CX - 200 + 650.937 / 2, minY: CY + 150 - 470.123 / 2, maxY: CY + 150 - 80.717 / 2 };
	var sel = await store.selectScreen(view, rect), byBox = await store.selectBox(box);
	assert.ok(sel.count > 10000, sel.count + " points");
	assert.deepEqual(await idsOf(store, sel), await idsOf(store, byBox));
});

test("selectScreen refuses a bad view", async function () {
	var store = await build();
	await assert.rejects(store.selectScreen({ viewProjection: [1, 2, 3], width: W, height: H }, PIXELS), /viewProjection/);
	await assert.rejects(store.selectScreen({ viewProjection: new Array(16).fill(0), width: 0, height: H }, PIXELS), /width/);
	await assert.rejects(store.selectScreen(perspectiveView([CX - 10, CY, 900], [CX, CY, 0]), [1, 2, 3]), /polygon/);
});

test("rectAgainstPolygon: in means every point in, out means none", function () {
	var r = rng(5), poly = makePolygonTest(LASSO), checked = { "-1": 0, "0": 0, "1": 0 };
	for (var k = 0; k < 3000; k++) {
		var x0 = 478000 + r() * 400, y0 = 6772000 + r() * 400, w = r() * 60, h = r() * 60;
		var v = rectAgainstPolygon(poly.points, x0, y0, x0 + w, y0 + h, 1e-6);
		checked[v]++;
		if (v === 0) continue;
		for (var s = 0; s < 40; s++) {
			var px = s < 4 ? (s % 2 ? x0 + w : x0) : x0 + r() * w, py = s < 4 ? (s < 2 ? y0 : y0 + h) : y0 + r() * h;
			assert.equal(poly.test(px, py), v === 1, "rect " + [x0, y0, w, h] + " verdict " + v);
		}
	}
	assert.ok(checked["-1"] > 100 && checked["0"] > 100 && checked["1"] > 100, JSON.stringify(checked));
});
