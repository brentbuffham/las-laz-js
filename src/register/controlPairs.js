// src/register/controlPairs.js
//==========================================================
// Control-point pairs from text, both sides on one line: the "from"
// (local / mine grid) x y z and the "to" (map grid) E N RL of each
// point, for fitTransform. Two layouts:
//
//   a) name x y z E N RL, tab / comma / semicolon / space separated;
//      the name may end in ':' and (tab, comma or semicolon files, or
//      the six numbers last on a space-separated line) may hold spaces.
//      Lines starting # or * are comments (* as in Vulcan's pair files).
//   b) Vulcan's transformation error report: blocks headed
//      "Error report for in transformation : <NAME>", rows
//      "<name> : <residual> [x y z -> x' y' z']" and "RMS error = r".
//      The "->" side is NOT the surveyed target: it is the from point
//      under Vulcan's fitted transform, and the residual is its distance
//      from the target. A report usually holds the transform and its
//      inverse (X_MINE2MGA and X_MGA2MINE), whose from points are each
//      other's targets, so a block's targets are taken from the other
//      block, by name, when every one of them sits at the reported
//      residual from the computed point.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

var NUM = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
var IS_NUM = new RegExp("^" + NUM + "$");
var VULCAN_ROW = new RegExp("^(.*?)\\s*:\\s*(" + NUM + ")?\\s*\\[\\s*(" + NUM + ")\\s+(" + NUM + ")\\s+(" + NUM + ")\\s*->\\s*(" + NUM + ")\\s+(" + NUM + ")\\s+(" + NUM + ")\\s*\\]\\s*$");
var VULCAN_TITLE = /transformation\s*:\s*(.*?)\s*$/i;
var VULCAN_RMS = new RegExp("^\\s*RMS error\\s*=\\s*(" + NUM + ")\\s*$", "i");

// The fields of a layout (a) line: tab, semicolon or comma (all but the last six fields are the
// name, so a stray delimiter in a number is caught by the field count), else runs of spaces
function fieldsOf(line) {
	var delim = line.indexOf("\t") >= 0 ? "\t" : line.indexOf(";") >= 0 ? ";" : line.indexOf(",") >= 0 ? "," : null;
	var f = delim ? line.split(delim) : line.trim().split(/\s+/);
	f = f.map(function (s) { return s.trim(); });
	while (f.length && f[f.length - 1] === "") f.pop();
	return { fields: f, delim: delim };
}

// Pair rows of layout (a)
function parsePlain(lines) {
	var names = [], from = [], to = [], seen = Object.create(null), first = true;
	for (var ln = 0; ln < lines.length; ln++) {
		var raw = lines[ln], at = "line " + (ln + 1);
		// # comments, and Vulcan's * comment lines (a Transparams3D pair file opens with them)
		if (!raw.trim() || raw.trim()[0] === "#" || raw.trim()[0] === "*") continue;
		var p = fieldsOf(raw), f = p.fields, nums = f.slice(-6);
		var numeric = f.length >= 6 && nums.every(function (s) { return IS_NUM.test(s); });
		// a header (a first line that is not a pair) is skipped
		var header = first && !numeric;
		first = false;
		if (header) continue;
		if (!numeric) throw bad(at + ": expected a name then six numbers (x y z E N RL), got \"" + raw.trim() + "\"");
		var nameFields = f.slice(0, -6);
		if (p.delim && nameFields.length > 1) throw bad(at + " has " + f.length + " fields, a name and six numbers expected (a thousands separator, or a stray delimiter?)");
		var name = nameFields.join(" ").replace(/\s*:\s*$/, "").trim();
		if (!name) throw bad(at + ": the pair has no name");
		if (seen[name]) throw bad(at + ": duplicate name " + name + " (also " + seen[name] + ")");
		seen[name] = at;
		names.push(name);
		for (var k = 0; k < 6; k++) (k < 3 ? from : to).push(Number(nums[k]));
	}
	if (!names.length) throw bad("no control-point pairs in the text (a name then x y z E N RL on each line)");
	return { format: "pairs", names: names, from: Float64Array.from(from), to: Float64Array.from(to), measured: true, blocks: [] };
}

// The blocks of a Vulcan report
function parseVulcan(lines) {
	var blocks = [], cur = null, seen;
	function open(title) {
		cur = { title: title, names: [], from: [], computed: [], residuals: [] };
		blocks.push(cur);
		seen = Object.create(null);
	}
	for (var ln = 0; ln < lines.length; ln++) {
		var raw = lines[ln], at = "line " + (ln + 1), m;
		if (!raw.trim()) continue;
		if ((m = raw.match(VULCAN_ROW))) {
			if (!cur) open(null);
			var name = m[1].trim();
			if (!name) throw bad(at + ": the pair has no name");
			if (seen[name]) throw bad(at + ": duplicate name " + name + " in " + (cur.title || "the block") + " (also " + seen[name] + ")");
			seen[name] = at;
			cur.names.push(name);
			cur.residuals.push(m[2] === undefined ? NaN : Number(m[2]));
			cur.from.push(Number(m[3]), Number(m[4]), Number(m[5]));
			cur.computed.push(Number(m[6]), Number(m[7]), Number(m[8]));
		} else if ((m = raw.match(VULCAN_RMS))) {
			if (cur) cur.rms = Number(m[1]);
		} else if (/error report/i.test(raw) && (m = raw.match(VULCAN_TITLE))) {
			open(m[1] || null);
		} else if (/->/.test(raw) && /\[/.test(raw)) {
			throw bad(at + ": not a Vulcan report row (name : residual [x y z -> x' y' z']): \"" + raw.trim() + "\"");
		}
	}
	blocks = blocks.filter(function (b) { return b.names.length; });
	if (!blocks.length) throw bad("no pairs in the Vulcan report");
	blocks = blocks.map(function (b) {
		return { title: b.title, names: b.names, from: Float64Array.from(b.from), computed: Float64Array.from(b.computed), to: null,
			residuals: Float64Array.from(b.residuals), rms: b.rms === undefined ? NaN : b.rms, inverse: -1 };
	});
	blocks.forEach(function (b, i) {
		for (var j = 0; j < blocks.length; j++) {
			if (j === i) continue;
			var to = targetsFrom(b, blocks[j]);
			if (to) { b.to = to; b.inverse = j; return; }
		}
	});
	var first = blocks[0];
	return {
		format: "vulcan", names: first.names.slice(), from: first.from.slice(), to: (first.to || first.computed).slice(),
		measured: first.to !== null, blocks: blocks
	};
}

// Block b's targets from block o's from points, by name: every name found, and (where b reports
// residuals) each at b's residual from b's computed point, to the printed precision
function targetsFrom(b, o) {
	var at = Object.create(null), to = new Float64Array(b.from.length), checked = 0;
	o.names.forEach(function (n, k) { at[n] = k; });
	for (var i = 0; i < b.names.length; i++) {
		var k = at[b.names[i]];
		if (k === undefined) return null;
		to[3 * i] = o.from[3 * k]; to[3 * i + 1] = o.from[3 * k + 1]; to[3 * i + 2] = o.from[3 * k + 2];
		var r = b.residuals[i];
		if (r !== r) continue;
		var d = Math.hypot(b.computed[3 * i] - to[3 * i], b.computed[3 * i + 1] - to[3 * i + 1], b.computed[3 * i + 2] - to[3 * i + 2]);
		if (Math.abs(d - r) > 1e-4 + 1e-6 * r) return null;
		checked++;
	}
	// without residuals, only a block of the same names in reverse (X_A2B and X_B2A) is trusted
	return checked || reverseTitles(b.title, o.title) ? to : null;
}

function reverseTitles(a, b) {
	var m = /^(.*?)([A-Za-z0-9]+)2([A-Za-z0-9]+)$/.exec(a || ""), n = /^(.*?)([A-Za-z0-9]+)2([A-Za-z0-9]+)$/.exec(b || "");
	return !!(m && n && m[1] === n[1] && m[2] === n[3] && m[3] === n[2]);
}

/**
 * Read control-point pairs from text, each point's from (local) and to (grid) on one line.
 * @param {string} text - layout a) "name x y z E N RL" rows (tab, comma, semicolon or spaces; a
 *   name may end in ':'; a header line, blank lines and lines starting # or * are skipped), or b) a Vulcan
 *   transformation error report. A UTF-8 BOM and CRLF are accepted.
 * @returns {{format: string, names: string[], from: Float64Array, to: Float64Array, measured: boolean,
 *   blocks: Array<{title: (string|null), names: string[], from: Float64Array, computed: Float64Array,
 *   to: (Float64Array|null), residuals: Float64Array, rms: number, inverse: number}>}}
 *   format "pairs" or "vulcan". names / from / to are the pairs to fit: for a Vulcan report, the
 *   first block's from points and their targets (from the inverse block), or, when no inverse block
 *   gives them, the block's computed points (measured false: fitting them reproduces Vulcan's
 *   transform with ~0 residuals). blocks: one per Vulcan block (empty for layout a), in the
 *   reported direction: computed is Vulcan's x' y' z', to the targets or null, residuals and rms
 *   as Vulcan printed them (NaN when absent), inverse the index of the block that gave the targets
 *   (-1: none).
 * @throws {LasError} INVALID_ARGUMENT naming the line of a bad row, a duplicate name, or no pairs.
 */
export function parseControlPointPairs(text) {
	if (typeof text !== "string") throw bad("parseControlPointPairs needs the file's text (a string)");
	var lines = text.replace(/^﻿/, "").split(/\r?\n/);
	var vulcan = lines.some(function (l) { return VULCAN_ROW.test(l); });
	return vulcan ? parseVulcan(lines) : parsePlain(lines);
}
