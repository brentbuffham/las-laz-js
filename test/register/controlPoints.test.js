// test/register/controlPoints.test.js
//==========================================================
// parseControlPoints: delimiters, headers choosing the columns, the
// columns override, Excel quirks, bad rows named by line; and
// matchControlPoints by exact (trimmed, case-sensitive) name.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseControlPoints, matchControlPoints } from "../../src/register/controlPoints.js";
import * as lib from "../../src/index.js";

var ROWS = [["CP1", 478000.125, 6772000.5, 301.25], ["CP2", 478100, 6772050.75, 299], ["CP3", 477950.5, 6772100, 305.5], ["CP4", 478020, 6771980.25, 300.125]];
function text(delim, header) {
	var lines = ROWS.map(function (r) { return r.join(delim); });
	if (header) lines.unshift(["Name", "X", "Y", "Z"].join(delim));
	return lines.join("\n");
}
function expectRows(got, rows) {
	assert.deepEqual(got.names, rows.map(function (r) { return r[0]; }));
	assert.deepEqual(Array.from(got.xyz), [].concat.apply([], rows.map(function (r) { return [r[1], r[2], r[3]]; })));
	assert.ok(got.xyz instanceof Float64Array);
}

test("each delimiter, with and without a header", function () {
	[",", "\t", ";", " ", "   "].forEach(function (d) {
		expectRows(parseControlPoints(text(d, true)), ROWS);
		expectRows(parseControlPoints(text(d, false)), ROWS);
	});
	expectRows(parseControlPoints("CP1  478000.125\t 6772000.5  301.25"), [ROWS[0]]);
});

test("headers choose the columns", function () {
	var a = parseControlPoints("Point,RL,Northing,Easting\nCP1,301.25,6772000.5,478000.125");
	expectRows(a, [ROWS[0]]);
	expectRows(parseControlPoints("id e n elev\nCP1 478000.125 6772000.5 301.25"), [ROWS[0]]);
	expectRows(parseControlPoints("STATION,H,N,E\nCP1,301.25,6772000.5,478000.125"), [ROWS[0]]);
	expectRows(parseControlPoints("Code,Name,Desc,East,North,Height\nX,CP1,peg,478000.125,6772000.5,301.25"), [ROWS[0]]);
});

test("columns overrides detection", function () {
	expectRows(parseControlPoints("478000.125,6772000.5,301.25,CP1", { columns: { name: 3, x: 0, y: 1, z: 2 } }), [ROWS[0]]);
});

test("Excel quirks", function () {
	var t = "﻿Name,E,N,RL,\r\nCP1,478000.125,6772000.5,301.25,\r\n\r\n# a comment\r\n\"CP, 2\",478100,6772050.75,299,\r\n\"say \"\"hi\"\"\",477950.5,6772100,305.5,\r\n";
	var got = parseControlPoints(t);
	assert.deepEqual(got.names, ["CP1", "CP, 2", "say \"hi\""]);
	assert.deepEqual(Array.from(got.xyz), [478000.125, 6772000.5, 301.25, 478100, 6772050.75, 299, 477950.5, 6772100, 305.5]);
});

test("bad rows are refused, naming the line", function () {
	assert.throws(function () { parseControlPoints("Name,X,Y,Z\nCP1,1,2,3\nCP2,1,2,3\nCP3,1,2"); }, /line 4/);
	assert.throws(function () { parseControlPoints("Name,X,Y,Z\nCP1,478,000.1,6772000,300"); }, /line 2/);
	assert.throws(function () { parseControlPoints("CP1,1,2,3\nCP2,1,x,3"); }, /line 2/);
	assert.throws(function () { parseControlPoints("CP1,1,2,3\nCP2,1,2,3\nCP2,4,5,6"); }, /duplicate.*CP2/);
	assert.throws(function () { parseControlPoints("Name,X,Y,Z\n\n"); }, /no control points/);
	assert.throws(function () { parseControlPoints(""); }, /no control points/);
	assert.throws(function () { parseControlPoints(42); }, /text/);
	assert.throws(function () { parseControlPoints("CP1,1,2,3", { columns: { name: 0, x: 1, y: 2 } }); }, /columns/);
});

test("matchControlPoints", function () {
	var scan = parseControlPoints("CP1,1,1,1\nCP2,2,2,2\n CP3 ,3,3,3\nX9,9,9,9\ncp1,7,7,7");
	var grid = parseControlPoints("CP3,30,30,30\nCP1,10,10,10\nCP2,20,20,20\nCP7,70,70,70");
	var m = matchControlPoints(scan, grid);
	assert.deepEqual(m.names, ["CP1", "CP2", "CP3"]);
	assert.deepEqual(Array.from(m.from), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
	assert.deepEqual(Array.from(m.to), [10, 10, 10, 20, 20, 20, 30, 30, 30]);
	assert.deepEqual(m.unmatchedScan, ["X9", "cp1"]);
	assert.deepEqual(m.unmatchedGrid, ["CP7"]);
	assert.ok(m.from instanceof Float64Array && m.to instanceof Float64Array);
	assert.throws(function () { matchControlPoints({}, grid); }, /scan/);
	assert.equal(lib.parseControlPoints, parseControlPoints);
	assert.equal(lib.matchControlPoints, matchControlPoints);
});

test("quoted names in a space-separated file", function () {
	var got = parseControlPoints("\"CP 1\" 1 2 3\n\"Peg A\"  4 5 6");
	assert.deepEqual(got.names, ["CP 1", "Peg A"]);
	assert.deepEqual(Array.from(got.xyz), [1, 2, 3, 4, 5, 6]);
	assert.throws(function () { parseControlPoints("\"\" 1 2 3"); }, /no name/);
});

test("a header without a coordinate column is refused, naming it", function () {
	assert.throws(function () { parseControlPoints("Name,X,Y\nCP1,1,2"); }, /no z column/);
	assert.throws(function () { parseControlPoints("Name,E,RL\nCP1,1,2"); }, /no y column/);
});

test("options and columns must be objects", function () {
	assert.throws(function () { parseControlPoints("CP1,1,2,3", null); }, /options/);
	assert.throws(function () { parseControlPoints("CP1,1,2,3", { columns: null }); }, /columns/);
});
