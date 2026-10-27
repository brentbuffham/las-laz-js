// test/facets/parallel.test.js
//==========================================================
// findFacetsParallel: a face wider than a tile comes back as one facet
// (its pieces joined across the seams), as findFacets finds it; two
// faces at an angle stay two; the workers and the same tiles run here
// agree; the small-cloud shortcut; bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFacets } from "../../src/facets/findFacets.js";
import { findFacetsParallel } from "../../src/facets/parallel.js";
import * as lib from "../../src/index.js";

function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6d2b79f5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// a roof: two planes meeting at a ridge along y = 5, each 10 x 5 m, slopes of 20 degrees; jittered grid
function roof(s) {
	var r = rng(5), pts = [], t = Math.tan(20 * Math.PI / 180);
	for (var x = 0; x < 10; x += s) for (var y = 0; y < 10; y += s) {
		var u = x + (r() - 0.5) * 0.4 * s, v = y + (r() - 0.5) * 0.4 * s;
		pts.push(u, v, (5 - Math.abs(v - 5)) * t + (r() - 0.5) * 0.002);
	}
	var n = pts.length / 3, cols = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { cols.x[i] = pts[3 * i]; cols.y[i] = pts[3 * i + 1]; cols.z[i] = pts[3 * i + 2]; }
	return cols;
}
var ROOF = roof(0.05), OPTS = { maxDistance: 0.2, maxAngle: 10 };

test("a face wider than a tile is one facet, as findFacets finds it", async function () {
	var one = findFacets(ROOF, OPTS);
	var par = await findFacetsParallel(ROOF, Object.assign({ threads: 2, tile: 2.5, overlap: 0.5 }, OPTS));
	assert.ok(par.tiles >= 9, "tiles " + par.tiles);
	var big = function (r) { return r.facets.filter(function (f) { return f.area > 10; }); };
	assert.equal(big(one).length, 2);
	assert.equal(big(par).length, 2, par.facets.map(function (f) { return f.area.toFixed(1); }).join());
	big(par).forEach(function (f, k) {
		var g = big(one)[k];
		assert.ok(Math.abs(f.area - g.area) < 0.05 * g.area, f.area + " vs " + g.area);
		assert.ok(Math.abs(f.dip - 20) < 1.5, "dip " + f.dip);
	});
	assert.equal(par.planeDistance, one.planeDistance);
	// ids by area, each facet's points labelled
	for (var i = 1; i < par.facets.length; i++) assert.ok(par.facets[i - 1].area >= par.facets[i].area);
	var seen = new Uint32Array(par.facets.length + 1);
	for (i = 0; i < par.facet.length; i++) seen[par.facet[i]]++;
	par.facets.forEach(function (f) { assert.equal(seen[f.id], f.count); });
});

test("the workers and the same tiles run here agree", async function () {
	var o = Object.assign({ tile: 2.5, overlap: 0.5 }, OPTS);
	var a = await findFacetsParallel(ROOF, Object.assign({ threads: 3 }, o)), b = await findFacetsParallel(ROOF, Object.assign({ threads: 1 }, o));
	assert.equal(b.threads, 1);
	assert.deepEqual(a.facet, b.facet);
});

test("shortcuts and bad options", async function () {
	var small = await findFacetsParallel(ROOF, OPTS);   // under the points worth a pool
	assert.equal(small.tiles, 1);
	assert.deepEqual(small.facet, findFacets(ROOF, OPTS).facet);
	await assert.rejects(findFacetsParallel(ROOF), /needs options/);
	await assert.rejects(findFacetsParallel(ROOF, { maxAngle: 10 }), /maxDistance/);
	for (var bad of [{ threads: 0 }, { tile: -1 }, { overlap: -1, tile: 3 }]) {
		await assert.rejects(findFacetsParallel(ROOF, Object.assign({}, OPTS, bad)), /threads|tile|overlap/, JSON.stringify(bad));
	}
	assert.equal(lib.findFacetsParallel, findFacetsParallel);
});
