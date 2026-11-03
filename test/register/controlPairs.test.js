// test/register/controlPairs.test.js
//==========================================================
// parseControlPointPairs: name + x y z E N RL rows (delimiters, ':'
// after the name, names with spaces, a header, bad rows named by line)
// and Vulcan transformation error reports (blocks, residuals, RMS, the
// targets taken from the inverse block). All coordinates are made up.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseControlPointPairs } from "../../src/register/controlPairs.js";
import { fitTransform } from "../../src/register/fit.js";
import { applyTransform } from "../../src/ops/transform.js";
import * as lib from "../../src/index.js";

var PAIRS = [
	["CP-1", 9885.964, 19077.431, 5420.469, 312069.458, 6608983.308, 420.469],
	["AAM 108", 10250.5, 19400.25, 5410, 312560.125, 6609081.75, 410],
	["CP3", 9700, 19800.125, 5433.5, 312440.5, 6609612.375, 433.5]
];
function expectPairs(got, rows) {
	assert.deepEqual(got.names, rows.map(function (r) { return r[0]; }));
	assert.deepEqual(Array.from(got.from), [].concat.apply([], rows.map(function (r) { return r.slice(1, 4); })));
	assert.deepEqual(Array.from(got.to), [].concat.apply([], rows.map(function (r) { return r.slice(4, 7); })));
	assert.ok(got.from instanceof Float64Array && got.to instanceof Float64Array);
	assert.equal(got.format, "pairs");
	assert.equal(got.measured, true);
	assert.deepEqual(got.blocks, []);
}

test("the package exports parseControlPointPairs and applyTransform", function () {
	assert.equal(lib.parseControlPointPairs, parseControlPointPairs);
	assert.equal(lib.applyTransform, applyTransform);
	assert.deepEqual(lib.applyTransform({ m: [0, -1, 0, 1, 0, 0, 0, 0, 2], t: [1, 2, 3] }, 1, 0, 1), [1, 3, 5]);
	var out = new Float64Array(3);
	assert.equal(lib.applyTransform({ m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [1, 2, 3] }, 0, 0, 0, out), out);
	assert.deepEqual(Array.from(out), [1, 2, 3]);
});

test("pairs: tab with a ':' after the name, comma, semicolon and spaces", function () {
	var tab = PAIRS.map(function (r) { return r[0] + ":\t" + r.slice(1).join("\t"); }).join("\r\n");
	expectPairs(parseControlPointPairs("﻿" + tab), PAIRS);
	[",", ";", "\t"].forEach(function (d) {
		expectPairs(parseControlPointPairs(PAIRS.map(function (r) { return r.join(d); }).join("\n")), PAIRS);
	});
	// spaces: the last six fields are the numbers, the rest the name ("AAM 108", "CP-1:")
	expectPairs(parseControlPointPairs(PAIRS.map(function (r) { return r[0] + ":   " + r.slice(1).join("  "); }).join("\n")), PAIRS);
	expectPairs(parseControlPointPairs(PAIRS.map(function (r) { return r.join(" "); }).join("\n")), PAIRS);
});

test("pairs: a header, blank lines and # comments are skipped", function () {
	var t = "# from the surveyor\nName,X,Y,Z,E,N,RL\n\n" + PAIRS.map(function (r) { return r.join(","); }).join("\n") + "\n# end\n";
	expectPairs(parseControlPointPairs(t), PAIRS);
});

test("pairs: bad rows are named by line", function () {
	var good = PAIRS.map(function (r) { return r.join(","); });
	assert.throws(function () { parseControlPointPairs(good.concat(["CP4,9,8,7,6,5"]).join("\n")); }, /line 4: expected a name then six numbers/);
	assert.throws(function () { parseControlPointPairs(good.concat(["CP4,9,8,7,312,000.5,6608983,1"]).join("\n")); }, /line 4 has 8 fields.*thousands separator/);
	assert.throws(function () { parseControlPointPairs(good.concat(["CP-1,1,2,3,4,5,6"]).join("\n")); }, /line 4: duplicate name CP-1 \(also line 1\)/);
	assert.throws(function () { parseControlPointPairs(good.concat([":\t1\t2\t3\t4\t5\t6"]).join("\n")); }, /line 4: the pair has no name/);
	assert.throws(function () { parseControlPointPairs("Name,X,Y,Z,E,N,RL\n"); }, /no control-point pairs/);
	assert.throws(function () { parseControlPointPairs(""); }, /no control-point pairs/);
	assert.throws(function () { parseControlPointPairs(null); }, /needs the file's text/);
});

// ---- Vulcan transformation error reports ----

// Targets (the surveyed points of both grids) and Vulcan-style computed points: each block's from
// points under an arbitrary forward / inverse transform, the residual |computed - target|
var MINE = [[9885.964, 19077.431, 420.469], [10250.5, 19400.25, 410], [9700, 19800.125, 433.5], [10612.25, 18850.5, 415.25]];
var GRID = [[312069.461, 6608983.302, 420.469], [312560.122, 6609081.758, 410], [312440.497, 6609612.37, 433.5], [312914.6, 6608640.11, 415.25]];
var NAMES = ["CP-1", "AAM 108", "MBH5/CH4", "CP 9"];
var FWD = { m: [0.684, -0.729, 0, 0.729, 0.684, 0], t: [319201.3, 6602743.9, 0] };
function fwd(p) { return [FWD.m[0] * p[0] + FWD.m[1] * p[1] + FWD.t[0], FWD.m[3] * p[0] + FWD.m[4] * p[1] + FWD.t[1], p[2]]; }
function inv(q) {
	var a = FWD.m[0], b = FWD.m[1], c = FWD.m[3], d = FWD.m[4], D = a * d - b * c, x = q[0] - FWD.t[0], y = q[1] - FWD.t[1];
	return [(d * x - b * y) / D, (a * y - c * x) / D, q[2]];
}
function f6(v) { return v.toFixed(6); }
function block(title, src, dst, map, withResidual) {
	var rows = src.map(function (p, i) {
		var c = map(p).map(function (v) { return Number(f6(v)); }), r = Math.hypot(c[0] - dst[i][0], c[1] - dst[i][1], c[2] - dst[i][2]);
		return (NAMES[i] + "         ").slice(0, 9) + ": " + (withResidual ? f6(r) + "  " : "") + "[" + p.map(f6).join(" ") + " -> " + c.map(f6).join(" ") + "]";
	});
	return ["", "Error report for in transformation : " + title, ""].concat(rows, ["", "", "  RMS error = 0.081551", "", ""]).join("\r\n");
}
var REPORT = block("SITE_MINE2MGA", MINE, GRID, fwd, true) + block("SITE_MGA2MINE", GRID, MINE, inv, true);

test("vulcan: two blocks in their reported directions, with residuals and RMS", function () {
	var r = parseControlPointPairs(REPORT);
	assert.equal(r.format, "vulcan");
	assert.equal(r.blocks.length, 2);
	var a = r.blocks[0], b = r.blocks[1];
	assert.equal(a.title, "SITE_MINE2MGA");
	assert.equal(b.title, "SITE_MGA2MINE");
	assert.deepEqual(a.names, NAMES);
	assert.deepEqual(Array.from(a.from), [].concat.apply([], MINE));
	assert.deepEqual(Array.from(b.from), [].concat.apply([], GRID));
	assert.deepEqual(Array.from(a.computed), [].concat.apply([], MINE.map(function (p) { return fwd(p).map(function (v) { return Number(f6(v)); }); })));
	assert.equal(a.rms, 0.081551);
	assert.ok(a.residuals instanceof Float64Array && a.residuals[0] > 0);
	// each block's targets are the other block's from points
	assert.deepEqual(Array.from(a.to), Array.from(b.from));
	assert.deepEqual(Array.from(b.to), Array.from(a.from));
	assert.equal(a.inverse, 1);
	assert.equal(b.inverse, 0);
	// the top level: the first block's measured pairs, copies
	assert.equal(r.measured, true);
	assert.deepEqual(r.names, NAMES);
	assert.deepEqual(Array.from(r.from), Array.from(a.from));
	assert.deepEqual(Array.from(r.to), Array.from(a.to));
	assert.notEqual(r.from, a.from);
	// the computed points are the reported transform: affine2d on them fits to the printed digits
	var g = fitTransform(a.from, a.computed, { model: "affine2d" });
	assert.ok(g.rms < 1e-5, "rms " + g.rms);
});

test("vulcan: one block alone gives its computed points (measured false)", function () {
	var r = parseControlPointPairs(block("SITE_MINE2MGA", MINE, GRID, fwd, true));
	assert.equal(r.measured, false);
	assert.equal(r.blocks[0].to, null);
	assert.equal(r.blocks[0].inverse, -1);
	assert.deepEqual(Array.from(r.to), Array.from(r.blocks[0].computed));
});

test("vulcan: a block whose from points are not at the reported residuals is not taken as the inverse", function () {
	var shifted = GRID.map(function (p) { return [p[0] + 0.5, p[1], p[2]]; });
	var r = parseControlPointPairs(block("SITE_MINE2MGA", MINE, GRID, fwd, true) + block("OTHER_MGA2MINE", shifted, MINE, inv, true));
	assert.equal(r.blocks[0].to, null);
	assert.equal(r.measured, false);
	// nor one missing a name
	var short = parseControlPointPairs(block("SITE_MINE2MGA", MINE, GRID, fwd, true) + block("SITE_MGA2MINE", GRID.slice(0, 3), MINE, inv, true));
	assert.equal(short.blocks[0].to, null);
	assert.equal(short.blocks[1].inverse, 0);
});

test("vulcan: without residuals only reversed titles (A2B / B2A) pair the blocks", function () {
	var r = parseControlPointPairs(block("SITE_MINE2MGA", MINE, GRID, fwd, false) + block("SITE_MGA2MINE", GRID, MINE, inv, false));
	assert.ok(r.blocks[0].residuals.every(function (v) { return v !== v; }));
	assert.equal(r.blocks[0].inverse, 1);
	assert.equal(r.measured, true);
	var s = parseControlPointPairs(block("SITE_MINE2MGA", MINE, GRID, fwd, false) + block("OTHER_X", GRID, MINE, inv, false));
	assert.equal(s.blocks[0].to, null);
	// rows with no block header are one untitled block, no RMS
	var t = parseControlPointPairs("A : [1 2 3 -> 4 5 6]\nB : [7 8 9 -> 10 11 12]");
	assert.equal(t.blocks[0].title, null);
	assert.deepEqual(t.names, ["A", "B"]);
	assert.ok(isNaN(t.blocks[0].rms));
});

test("vulcan: bad rows are named by line", function () {
	assert.throws(function () { parseControlPointPairs(REPORT + "\r\nCP 7 : 0.1 [1 2 -> 4 5 6]"); }, /line 24: not a Vulcan report row/);
	assert.throws(function () { parseControlPointPairs("A : [1 2 3 -> 4 5 6]\nA : [7 8 9 -> 10 11 12]"); }, /line 2: duplicate name A/);
	assert.throws(function () { parseControlPointPairs(" : [1 2 3 -> 4 5 6]"); }, /line 1: the pair has no name/);
});
