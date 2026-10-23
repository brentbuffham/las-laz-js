// src/register/controlPoints.js
//==========================================================
// Control points from text: the surveyor's control list (grid) and the
// scan's target list, each "name, x, y, z" rows, matched by name into
// the from / to pairs fitTransform takes. Delimiter per file: semicolon,
// comma, or runs of spaces / tabs (double quotes keep a delimiter in a
// name; "" escapes a quote). An optional header names the columns
// (E / N / RL and the like); every row must have as many fields as the
// first (trailing empty fields ignored), so "478,000.1" is refused, not
// read as two numbers. Names match exactly after trimming, case-sensitive
// (a surveyor's CP1 and cp1 may differ).
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

var HEADER = {
	name: ["name", "id", "point", "pt", "station"],
	x: ["x", "e", "east", "easting"],
	y: ["y", "n", "north", "northing"],
	z: ["z", "rl", "elev", "elevation", "h", "height"]
};

// Fields of one line: split on delim (a character), or on runs of white space when delim is null,
// with double quotes
function fieldsOf(line, delim) {
	var out = [], cur = "", quoted = false, had = false;
	for (var i = 0; i < line.length; i++) {
		var ch = line[i];
		if (quoted) {
			if (ch === "\"") {
				if (line[i + 1] === "\"") { cur += "\""; i++; } else quoted = false;
			} else cur += ch;
		} else if (ch === "\"") { quoted = true; had = true; }
		else if (delim ? ch === delim : (ch === " " || ch === "\t")) {
			if (delim || cur || had) out.push(cur);
			cur = ""; had = false;
			if (!delim) while (line[i + 1] === " " || line[i + 1] === "\t") i++;
		} else cur += ch;
	}
	if (delim || cur || had) out.push(cur);
	return out.map(function (f) { return f.trim(); });
}

// The delimiter of a data line: semicolon or comma outside quotes, else white space (null)
function delimiterOf(line) {
	var quoted = false, comma = false;
	for (var i = 0; i < line.length; i++) {
		if (line[i] === "\"") quoted = !quoted;
		else if (!quoted && line[i] === ";") return ";";
		else if (!quoted && line[i] === ",") comma = true;
	}
	return comma ? "," : null;
}

function trimEmpty(f) { var n = f.length; while (n > 0 && f[n - 1] === "") n--; return f.slice(0, n); }
function isNum(s) { return s !== "" && isFinite(Number(s)); }

function checkColumns(c) {
	if (c === null || typeof c !== "object") throw bad("columns must be { name, x, y, z } column numbers (0 = the first)");
	["name", "x", "y", "z"].forEach(function (k) {
		if (!Number.isInteger(c[k]) || c[k] < 0) throw bad("columns." + k + " must be a column number (0 = the first)");
	});
	return c;
}

/**
 * Read control points from text: one "name, x, y, z" row per point.
 * @param {string} text - CSV / TXT; a UTF-8 BOM, CRLF, blank lines and lines starting # are accepted.
 * @param {{columns?: {name: number, x: number, y: number, z: number}}} [options] - zero-based
 *   column numbers, overriding the header (or the default name, x, y, z order).
 * @returns {{names: string[], xyz: Float64Array}}
 * @throws {LasError} INVALID_ARGUMENT naming the line of a bad row, a duplicate name, or no rows.
 */
export function parseControlPoints(text, options) {
	if (typeof text !== "string") throw bad("parseControlPoints needs the file's text (a string)");
	var o = options === undefined ? {} : options;
	if (o === null || typeof o !== "object") throw bad("options must be an object");
	var cols = o.columns !== undefined ? checkColumns(o.columns) : null;
	var lines = text.replace(/^﻿/, "").split(/\r?\n/), delim, width = -1, names = [], xyz = [], seen = Object.create(null);
	for (var ln = 0; ln < lines.length; ln++) {
		var raw = lines[ln], at = "line " + (ln + 1);
		if (!raw.trim() || raw.trim()[0] === "#") continue;
		if (delim === undefined) delim = delimiterOf(raw);
		var f = trimEmpty(fieldsOf(raw, delim));
		if (width < 0) {
			// the first row: a header when the coordinate fields are not all numbers
			var c = cols || { name: 0, x: 1, y: 2, z: 3 };
			var header = !(isNum(f[c.x] || "") && isNum(f[c.y] || "") && isNum(f[c.z] || ""));
			width = f.length;
			if (header) {
				if (!cols) {
					cols = {};
					Object.keys(HEADER).forEach(function (k) {
						var j = f.findIndex(function (h) { return HEADER[k].indexOf(h.toLowerCase()) >= 0; });
						if (j < 0) throw bad(at + ": the header has no " + k + " column (" + HEADER[k].join(" / ") + ")");
						cols[k] = j;
					});
				}
				continue;
			}
			cols = c;
		}
		if (f.length !== width) throw bad(at + " has " + f.length + " fields, the first row " + width + " (a thousands separator, or a missing value?)");
		var x = f[cols.x], y = f[cols.y], z = f[cols.z], name = f[cols.name];
		if (!isNum(x) || !isNum(y) || !isNum(z)) throw bad(at + ": x, y and z must be numbers (got " + [x, y, z].join(", ") + ")");
		if (!name) throw bad(at + ": the point has no name");
		if (seen[name]) throw bad(at + ": duplicate name " + name + " (also " + seen[name] + ")");
		seen[name] = at;
		names.push(name);
		xyz.push(Number(x), Number(y), Number(z));
	}
	if (!names.length) throw bad("no control points in the text");
	return { names: names, xyz: Float64Array.from(xyz) };
}

function checkList(l, what) {
	if (!l || !Array.isArray(l.names) || !l.xyz || l.xyz.length !== l.names.length * 3) throw bad(what + " must be { names, xyz } from parseControlPoints");
}

/**
 * Pair a scan's targets with the grid's control points by name.
 * @param {{names: string[], xyz: ArrayLike<number>}} scan
 * @param {{names: string[], xyz: ArrayLike<number>}} grid
 * @returns {{names: string[], from: Float64Array, to: Float64Array, unmatchedScan: string[], unmatchedGrid: string[]}}
 *   pairs in the scan list's order; from the scan's coordinates, to the grid's.
 */
export function matchControlPoints(scan, grid) {
	checkList(scan, "scan");
	checkList(grid, "grid");
	var at = Object.create(null), used = Object.create(null), names = [], from = [], to = [], unmatchedScan = [];
	grid.names.forEach(function (n, i) { var k = String(n).trim(); if (!(k in at)) at[k] = i; });
	scan.names.forEach(function (n, i) {
		var k = String(n).trim();
		if (!(k in at)) { unmatchedScan.push(k); return; }
		var j = at[k];
		used[k] = true;
		names.push(k);
		from.push(scan.xyz[3 * i], scan.xyz[3 * i + 1], scan.xyz[3 * i + 2]);
		to.push(grid.xyz[3 * j], grid.xyz[3 * j + 1], grid.xyz[3 * j + 2]);
	});
	var unmatchedGrid = grid.names.map(function (n) { return String(n).trim(); }).filter(function (k) { return !used[k]; });
	return { names: names, from: Float64Array.from(from), to: Float64Array.from(to), unmatchedScan: unmatchedScan, unmatchedGrid: unmatchedGrid };
}
