// test/ops/parallel.test.js
//==========================================================
// selectOutliersParallel, selectSparseParallel, pointNormalsParallel and
// denoisePointsParallel give the serial tools' answers on a cloud cut
// into tiles (exactly, where their ring covers the neighbours), with one
// climbing bar of 1000, a stop that works, and the serial tool on this
// thread when a pool does not pay.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOutliers, selectSparse, pointNormals, denoisePoints, estimateNoise,
	selectOutliersParallel, selectSparseParallel, pointNormalsParallel, denoisePointsParallel } from "../../src/index.js";

var E = 478000, N = 6771000, H = 240;
// a rippled surface at UTM scale on a 5 cm grid with 1 cm of jitter and 4 mm of noise in height, some stray points far above it, some doubles
function surface(side, seed, f32) {
	var s = seed >>> 0, rnd = function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
	var n = side * side, A = f32 ? Float32Array : Float64Array, x = new A(n), y = new A(n), z = new A(n), o = f32 ? 0 : 1;
	for (var i = 0; i < n; i++) {
		x[i] = o * E + (i % side) * 0.05 + rnd() * 0.01; y[i] = o * N + Math.floor(i / side) * 0.05 + rnd() * 0.01;
		z[i] = o * H + 0.2 * Math.sin((i % side) / 12) + rnd() * 0.004;
	}
	for (var j = 0; j < n / 400; j++) z[Math.floor(rnd() * n)] += 1.5 + rnd();
	return { count: n, x: x, y: y, z: z, intensity: new Uint16Array(n).map(function (_, q) { return q & 0xffff; }) };
}
function same(a, b, label) {
	assert.equal(a.length, b.length, label + " length");
	for (var i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) assert.fail(label + " differs at " + i + ": " + a[i] + " vs " + b[i]);
}
function bar(label) {
	var seen = [];
	return { seen: seen, on: function (d, t) { seen.push([d, t]); },
		check: function () {
			assert.ok(seen.length >= 4, label + ": " + seen.length + " reports");
			assert.deepEqual(seen[0], [0, 1000], label);
			assert.deepEqual(seen[seen.length - 1], [1000, 1000], label);
			seen.forEach(function (e, i) { assert.equal(e[1], 1000); if (i) assert.ok(e[0] > seen[i - 1][0], label + ": a step back at " + i); });
		} };
}

var CLOUD = surface(260, 5, false), TILE = { threads: 3, tile: 4 };

test("selectOutliersParallel selects the points selectOutliers selects, on tiles", { timeout: 120000 }, async function () {
	var want = selectOutliers(CLOUD), b = bar("outliers");
	assert.ok(want.length > 100 && want.length < CLOUD.count / 20, want.length + " outliers");
	var got = await selectOutliersParallel(CLOUD, Object.assign({ overlap: 1.5, onProgress: b.on }, TILE));
	same(got, want, "outliers"); b.check();
	// with k and multiplier, and on Float32 (local) columns
	var f = surface(200, 8, true);
	same(await selectOutliersParallel(f, { k: 6, multiplier: 3, overlap: 1.5, threads: 2, tile: 3 }), selectOutliers(f, { k: 6, multiplier: 3 }), "float32 outliers");
});

test("selectSparseParallel is exact: the points selectSparse selects, in 2D and 3D", { timeout: 120000 }, async function () {
	for (var opts of [{ radius: 0.09 }, { radius: 0.09, minNeighbours: 4 }, { radius: 0.055, xy: true, minNeighbours: 3 }]) {
		var want = selectSparse(CLOUD, opts), b = bar("sparse");
		assert.ok(want.length > 0, JSON.stringify(opts));
		same(await selectSparseParallel(CLOUD, Object.assign({ onProgress: b.on }, opts, TILE)), want, "sparse " + JSON.stringify(opts));
		b.check();
	}
});

test("pointNormalsParallel is exact: pointNormals' normals and residuals (NaN where there is no plane)", { timeout: 120000 }, async function () {
	var want = pointNormals(CLOUD, { maxDistance: 0.3 }), b = bar("normals");
	var got = await pointNormalsParallel(CLOUD, Object.assign({ maxDistance: 0.3, onProgress: b.on }, TILE));
	same(got.normal, want.normal, "normal"); same(got.residual, want.residual, "residual"); b.check();
	var k8 = pointNormals(CLOUD, { k: 8, maxDistance: 0.2 });
	same((await pointNormalsParallel(CLOUD, Object.assign({ k: 8, maxDistance: 0.2 }, TILE))).residual, k8.residual, "k 8 residual");
});

test("denoisePointsParallel moves the points denoisePoints moves, with a given sigma exactly", { timeout: 180000 }, async function () {
	var sigma = estimateNoise(CLOUD, { maxDistance: 0.3 }), o = { maxDistance: 0.3, iterations: 2, sigma: sigma };
	var want = denoisePoints(CLOUD, Object.assign({ normals: true }, o)), b = bar("denoise");
	var got = await denoisePointsParallel(CLOUD, Object.assign({ normals: true, onProgress: b.on }, o, TILE));
	same(got.x, want.x, "x"); same(got.y, want.y, "y"); same(got.z, want.z, "z"); same(got.normal, want.normal, "normal"); b.check();
	assert.equal(got.intensity, CLOUD.intensity, "other columns are shared");
	assert.equal(got.count, CLOUD.count);
	// mls, one pass
	var mls = denoisePoints(CLOUD, { method: "mls", maxDistance: 0.3, sigma: sigma });
	same((await denoisePointsParallel(CLOUD, Object.assign({ method: "mls", maxDistance: 0.3, sigma: sigma }, TILE))).z, mls.z, "mls z");
	// sigma measured on a few tiles: close to the serial run with the whole cloud's sigma
	var measured = await denoisePointsParallel(CLOUD, Object.assign({ maxDistance: 0.3 }, TILE)), once = denoisePoints(CLOUD, { maxDistance: 0.3, sigma: sigma }), worst = 0;
	for (var i = 0; i < CLOUD.count; i++) worst = Math.max(worst, Math.abs(measured.z[i] - once.z[i]));
	assert.ok(worst < 0.002, "worst " + worst);
});

test("denoisePointsParallel inPlace writes the cloud's columns; a cloud with no noise to measure is the serial run", { timeout: 120000 }, async function () {
	var c = surface(200, 3, false), keep = c.z.slice(), sigma = estimateNoise(c, { maxDistance: 0.3 });
	var want = denoisePoints(c, { maxDistance: 0.3, sigma: sigma });
	var r = await denoisePointsParallel(c, { maxDistance: 0.3, sigma: sigma, inPlace: true, threads: 2, tile: 3 });
	assert.equal(r.z, c.z);
	same(c.z, want.z, "in place z"); assert.notDeepEqual(Array.from(c.z.slice(0, 50)), Array.from(keep.slice(0, 50)));
	// a flat, exact plane has no residual: sigma 0, nothing to move
	var flat = surface(150, 4, false); flat.z.fill(H); flat.x.forEach(function (_, i) { flat.x[i] = E + (i % 150) * 0.05; flat.y[i] = N + Math.floor(i / 150) * 0.05; });
	var res = await denoisePointsParallel(flat, { maxDistance: 0.3, threads: 2, tile: 2 });
	same(res.z, flat.z, "unmoved");
});

test("the parallel tools run the serial tool on this thread for a small cloud, one thread or a positions column", { timeout: 120000 }, async function () {
	var c = surface(120, 6, false);
	same(await selectOutliersParallel(c), selectOutliers(c), "small outliers");
	same(await selectSparseParallel(c, { radius: 0.09, threads: 1, tile: 2 }), selectSparse(c, { radius: 0.09 }), "one thread sparse");
	var b = bar("serial path");
	await selectSparseParallel(c, { radius: 0.09, onProgress: b.on });
	b.check();
	var pos = new Float64Array(3 * c.count);
	for (var i = 0; i < c.count; i++) { pos[3 * i] = c.x[i]; pos[3 * i + 1] = c.y[i]; pos[3 * i + 2] = c.z[i]; }
	var packed = { count: c.count, positions: pos };   // a k = 3 positions column has no x, y, z to cut into tiles
	same((await pointNormalsParallel(packed, { maxDistance: 0.3, tile: 2 })).residual, pointNormals(c, { maxDistance: 0.3 }).residual, "positions column normals");
	same((await denoisePointsParallel(c, { maxDistance: 0.3, sigma: 0.002, threads: 1 })).z, denoisePoints(c, { maxDistance: 0.3, sigma: 0.002 }).z, "one thread denoise");
});

test("the parallel tools check their options and stop when told", { timeout: 120000 }, async function () {
	await assert.rejects(selectOutliersParallel(CLOUD, { k: 0 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(selectOutliersParallel(CLOUD, { multiplier: "x" }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(selectOutliersParallel(CLOUD, { overlap: -1 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(selectOutliersParallel(CLOUD, { threads: 0 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(selectOutliersParallel(CLOUD, { tile: -2 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(selectSparseParallel(CLOUD, {}), { code: "INVALID_ARGUMENT" });
	await assert.rejects(selectSparseParallel(CLOUD, { radius: 0.1, minNeighbours: 0 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(pointNormalsParallel(CLOUD, {}), { code: "INVALID_ARGUMENT" });
	await assert.rejects(pointNormalsParallel(CLOUD, { maxDistance: 0.3, start: 5 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(denoisePointsParallel(CLOUD, { maxDistance: 0.3, method: "x" }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(denoisePointsParallel(CLOUD, { maxDistance: 0.3, iterations: 0 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(denoisePointsParallel(CLOUD, { maxDistance: 0.3, sigma: -1 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(selectOutliersParallel(CLOUD, Object.assign({ signal: AbortSignal.abort() }, TILE)), { code: "ABORTED" });
	var stop = new AbortController();
	await assert.rejects(pointNormalsParallel(CLOUD, Object.assign({ maxDistance: 0.3, signal: stop.signal, onProgress: function (d) { if (d > 100) stop.abort(); } }, TILE)), { code: "ABORTED" });
});

test("the serial tools tick steadily and stop with a signal (selectOutliers, selectSparse, pointNormals, estimateNoise, denoisePoints)", { timeout: 120000 }, function () {
	var c = surface(150, 9, false);
	function steady(label, run) {
		var b = bar(label);
		run({ onProgress: b.on });
		assert.deepEqual(b.seen[0].slice(), [0, b.seen[0][1]], label + " starts at 0");
		assert.equal(b.seen[b.seen.length - 1][0], b.seen[b.seen.length - 1][1], label + " ends at its total");
		b.seen.forEach(function (e, i) { if (i) assert.ok(e[0] >= b.seen[i - 1][0], label + " no step back"); assert.equal(e[1], b.seen[0][1]); });
		assert.ok(b.seen.length >= 20, label + ": " + b.seen.length + " reports");
		var stop = new AbortController(), calls = 0;
		assert.throws(function () { run({ signal: stop.signal, onProgress: function () { if (++calls > 3) stop.abort(); } }); }, { code: "ABORTED" }, label + " stops");
		assert.throws(function () { run({ signal: AbortSignal.abort() }); }, { code: "ABORTED" }, label + " refuses an aborted signal");
	}
	steady("selectOutliers", function (o) { return selectOutliers(c, o); });
	steady("selectSparse", function (o) { return selectSparse(c, Object.assign({ radius: 0.09 }, o)); });
	steady("pointNormals", function (o) { return pointNormals(c, Object.assign({ maxDistance: 0.3 }, o)); });
	steady("estimateNoise", function (o) { return estimateNoise(c, Object.assign({ maxDistance: 0.3 }, o)); });
	steady("denoisePoints", function (o) { return denoisePoints(c, Object.assign({ maxDistance: 0.3, iterations: 2 }, o)); });
});

test("suggestDoubleLayerParallel suggests settings close to suggestDoubleLayer's, with one climbing bar", { timeout: 120000 }, async function () {
	var { suggestDoubleLayer, suggestDoubleLayerParallel } = await import("../../src/index.js");
	var ghost = surface(300, 12, false), n = ghost.count;
	// a ghost sheet 0.3 m under every third point
	var x = new Float64Array(n + n / 3), y = new Float64Array(n + n / 3), z = new Float64Array(n + n / 3), w = 0;
	for (var i = 0; i < n; i++) { x[w] = ghost.x[i]; y[w] = ghost.y[i]; z[w++] = ghost.z[i]; if (i % 3 === 0) { x[w] = ghost.x[i] + 0.005; y[w] = ghost.y[i]; z[w++] = ghost.z[i] - 0.3; } }
	var cols = { count: w, x: x, y: y, z: z }, want = suggestDoubleLayer(cols), b = bar("suggest");
	var got = await suggestDoubleLayerParallel(cols, Object.assign({ onProgress: b.on }, TILE));
	b.check();
	assert.equal(want.ok, true); assert.equal(got.ok, true);
	assert.ok(Math.abs(got.cell - want.cell) <= want.cell, got.cell + " against " + want.cell);
	assert.ok(Math.abs(got.minGap - want.minGap) <= 0.5 * want.minGap + 0.02, got.minGap + " against " + want.minGap);
	assert.ok(got.splitFraction > 0.2 && want.splitFraction > 0.2, "both see the ghost: " + got.splitFraction + ", " + want.splitFraction);
	// small clouds, one thread: the serial suggestion
	var small = surface(100, 2, false);
	assert.deepEqual(await suggestDoubleLayerParallel(small, { strength: "gentle" }), suggestDoubleLayer(small, { strength: "gentle" }));
	assert.deepEqual(await suggestDoubleLayerParallel(small, { threads: 1 }), suggestDoubleLayer(small));
	await assert.rejects(suggestDoubleLayerParallel(small, { strength: "x" }), { code: "INVALID_ARGUMENT" });
});
