// test/fragments/parallel.test.js
//==========================================================
// findFragmentsParallel: tiles in workers find the boxes of a synthetic
// pile as one run does; the workers and the same tiles run here give
// the same answer; a box on a seam is found once, not twice; the
// hybrid's counts; the shortcuts (small cloud, one tile); bad options.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFragments } from "../../src/fragments/findFragments.js";
import { findFragmentsParallel } from "../../src/fragments/parallel.js";
import * as lib from "../../src/index.js";
import { rockPile } from "../helpers/rocks.js";

var PILE = rockPile({ count: 30, swebrec: { x50: 0.5, xmax: 1.2, b: 2 }, extent: 8, spacing: 0.02, noise: 0.002, seed: 4, fines: "pebbles" });

// boxes found whole: one fragment holds at least 90 % of the box's points
function whole(p, fr) {
	var byBox = new Map();
	for (var i = 0; i < p.truth.length; i++) if (p.truth[i] && fr.fragment[i]) { var key = p.truth[i] + ":" + fr.fragment[i]; byBox.set(key, (byBox.get(key) || 0) + 1); }
	return p.boxes.filter(function (b) { var best = 0; byBox.forEach(function (c, key) { if (Number(key.split(":")[0]) === b.id && c > best) best = c; }); return best >= 0.9 * b.points; }).length;
}

test("tiles in workers find the pile's boxes as one run does", async function () {
	var one = findFragments(PILE.cols, { method: "watershed" });
	var par = await findFragmentsParallel(PILE.cols, { method: "watershed", threads: 2, tile: 3, overlap: 1.5 });
	assert.ok(par.tiles >= 4, "tiles " + par.tiles);
	assert.equal(par.threads, 2);
	assert.ok(whole(PILE, par) >= whole(PILE, one) - 1, whole(PILE, par) + " vs " + whole(PILE, one));
	assert.ok(Math.abs(par.fragments.length - one.fragments.length) <= 0.1 * one.fragments.length + 2, par.fragments.length + " vs " + one.fragments.length);
	assert.equal(par.spacing, one.spacing); assert.equal(par.floor, one.floor); assert.equal(par.cell, one.cell);
	assert.ok(Math.abs(par.unassignedArea / par.surfaceArea - one.unassignedArea / one.surfaceArea) < 0.05);
	// ids by size, largest first, each fragment's points labelled with its id
	for (var i = 1; i < par.fragments.length; i++) assert.ok(par.fragments[i - 1].size >= par.fragments[i].size);
	var seen = new Uint32Array(par.fragments.length + 1);
	for (i = 0; i < par.fragment.length; i++) seen[par.fragment[i]]++;
	par.fragments.forEach(function (f) { assert.equal(f.id, par.fragments.indexOf(f) + 1); assert.ok(seen[f.id] > 0); assert.equal(typeof f.sheet, "boolean"); });
});

test("the workers and the same tiles run here agree", async function () {
	var opts = { method: "watershed", tile: 3, overlap: 1.5 };
	var a = await findFragmentsParallel(PILE.cols, Object.assign({ threads: 3 }, opts));
	var b = await findFragmentsParallel(PILE.cols, Object.assign({ threads: 1 }, opts));
	assert.equal(b.threads, 1); assert.equal(a.tiles, b.tiles);
	assert.deepEqual(a.fragment, b.fragment);
	assert.deepEqual(a.fragments.map(function (f) { return f.size; }), b.fragments.map(function (f) { return f.size; }));
});

test("a box on a seam is found once", async function () {
	// one box straddling the seam between two 2 m tiles
	var p = rockPile({ boxes: [{ centre: [2, 1], size: [0.8, 0.7, 0.4], yaw: 30, tilt: 0 }], extent: 4, spacing: 0.02, noise: 0.002, seed: 2 });
	var par = await findFragmentsParallel(p.cols, { method: "watershed", threads: 1, tile: 2, overlap: 1, reliefRadius: 1 });
	assert.ok(par.tiles >= 2);
	var ids = new Set();
	for (var i = 0; i < p.truth.length; i++) if (p.truth[i] && par.fragment[i]) ids.add(par.fragment[i]);
	var big = Array.from(ids).filter(function (id) { var c = 0; for (var j = 0; j < p.truth.length; j++) if (p.truth[j] && par.fragment[j] === id) c++; return c > 0.2 * p.boxes[0].points; });
	assert.equal(big.length, 1, "fragments over the box: " + Array.from(ids).join());
	// and one fragment in the list centred on it (a copy from the other tile would sit there too)
	var c = p.cols, cx = 0, cy = 0, nb = 0;
	for (i = 0; i < p.truth.length; i++) if (p.truth[i]) { cx += c.x[i]; cy += c.y[i]; nb++; }
	cx /= nb; cy /= nb;
	assert.equal(par.fragments.filter(function (f) { return Math.hypot(f.centroid[0] - cx, f.centroid[1] - cy) < 0.3; }).length, 1);
});

test("the hybrid's counts", async function () {
	var par = await findFragmentsParallel(PILE.cols, { method: "hybrid", threads: 2, tile: 4, overlap: 1.5 });
	assert.equal(par.method, "hybrid");
	assert.equal(par.fromWatershed + par.fromFacets, par.fragments.length);
	assert.ok(par.fragments.every(function (f) { return f.from === "watershed" || f.from === "facets"; }));
	assert.equal(par.facets, null);
});

test("shortcuts: a small cloud, one tile", async function () {
	var small = await findFragmentsParallel(PILE.cols, { method: "watershed" });   // under the points worth a pool
	assert.equal(small.tiles, 1); assert.equal(small.threads, 1);
	assert.deepEqual(small.fragment, findFragments(PILE.cols, { method: "watershed" }).fragment);
	var big = await findFragmentsParallel(PILE.cols, { method: "watershed", threads: 2, tile: 100 });
	assert.equal(big.tiles, 1);
});

test("bad options", async function () {
	await assert.rejects(findFragmentsParallel(PILE.cols), /needs options/);
	for (var bad of [{ threads: 0 }, { threads: 1.5 }, { tile: -1, threads: 2 }, { overlap: -1, threads: 2, tile: 3 }]) {
		await assert.rejects(findFragmentsParallel(PILE.cols, Object.assign({ method: "watershed" }, bad)), /threads|tile|overlap/, JSON.stringify(bad));
	}
	assert.throws(function () { findFragments(PILE.cols, { method: "watershed", spacing: -1 }); }, /spacing/);
	assert.equal(findFragments(PILE.cols, { method: "watershed", spacing: 0.02 }).spacing, 0.02);
});

test("exports", function () {
	assert.equal(lib.findFragmentsParallel, findFragmentsParallel);
});
