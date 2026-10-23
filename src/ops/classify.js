// src/ops/classify.js
//==========================================================
// Categorise: give selected points a LAS classification. Existing
// classes are kept by default (Brent, 2026-10-23: a point that already
// has a code is not overwritten); only points still at 0 (created,
// never classified) or 1 (unclassified) change, unless the caller asks
// for overwrite or names the classes that may change (only). Copy by
// default (a new classification array, every other column shared);
// inPlace overwrites the input's array. ASPRS_CLASSES names the
// standard codes of LAS 1.4 R15.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { checkSelection, needColumn, countOf } from "./columns.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

function isCode(v) { return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255; }

/** ASPRS standard classification codes (LAS 1.4 R15) -> name. 23-63 reserved, 64-255 user-definable. */
export var ASPRS_CLASSES = Object.freeze({
	0: "Created, never classified",
	1: "Unclassified",
	2: "Ground",
	3: "Low vegetation",
	4: "Medium vegetation",
	5: "High vegetation",
	6: "Building",
	7: "Low point (noise)",
	8: "Reserved (model key-point)",
	9: "Water",
	10: "Rail",
	11: "Road surface",
	12: "Reserved (overlap)",
	13: "Wire – guard (shield)",
	14: "Wire – conductor (phase)",
	15: "Transmission tower",
	16: "Wire-structure connector",
	17: "Bridge deck",
	18: "High noise",
	19: "Overhead structure",
	20: "Ignored ground",
	21: "Snow",
	22: "Temporal exclusion"
});

// 256 flags: may a point of this class change?
function mayChangeTable(o) {
	var t = new Uint8Array(256);
	if (o.only !== undefined) {
		if (o.overwrite) throw bad("give only or overwrite: true, not both (only names the classes that may change)");
		if (!Array.isArray(o.only)) throw bad("only must be a list of class codes 0-255");
		o.only.forEach(function (v, i) {
			if (!isCode(v)) throw bad("only[" + i + "] = " + v + " is not a class code 0-255");
			t[v] = 1;
		});
	} else if (o.overwrite) t.fill(1);
	else { t[0] = 1; t[1] = 1; }
	return t;
}

/**
 * Give the selected points a classification. By default only points whose class is 0 or 1
 * change; a point with any other class keeps it.
 * @param {object} cols - point columns with a classification column (Uint8Array, k = 1).
 * @param {Uint32Array|number[]} selection - ascending point indices.
 * @param {number} code - the class, a whole number 0-255.
 * @param {{overwrite?: boolean, only?: number[], inPlace?: boolean}} [options]
 *   overwrite: change every selected point, whatever its class. only: change only selected points
 *   whose class is listed (not with overwrite). inPlace: overwrite the input's classification array
 *   and return the input's columns object.
 * @returns {{columns: object, changed: number}} the columns (a copy with a new classification
 *   array, every other column shared and stats dropped, unless inPlace, which keeps the input's
 *   stats.classCounts true) and how many points changed class.
 * @throws {LasError} INVALID_ARGUMENT naming the bad argument.
 */
export function classifyPoints(cols, selection, code, options) {
	var o = options === undefined ? {} : options;
	if (o === null || typeof o !== "object") throw bad("options must be an object");
	["overwrite", "inPlace"].forEach(function (k) {
		if (o[k] !== undefined && typeof o[k] !== "boolean") throw bad(k + " must be true or false (got " + JSON.stringify(o[k]) + ")");
	});
	if (!isCode(code)) throw bad("code must be a class code, a whole number 0-255 (got " + code + ")");
	var n = countOf(cols);
	var cls = needColumn(cols, "classification", "classifyPoints");
	var sel = checkSelection(selection, n);
	var may = mayChangeTable(o);
	var out = cols, target = cls;
	// readPoints' stats.classCounts: a copy drops stats (stale, as transformPoints drops it);
	// inPlace keeps the input's counts true
	var counts = o.inPlace && cols.stats && cols.stats.classCounts ? cols.stats.classCounts : null;
	if (!o.inPlace) {
		target = Uint8Array.from(cls);
		out = Object.assign({}, cols, { classification: target });
		delete out.stats;
	}
	var changed = 0;
	for (var j = 0; j < sel.length; j++) {
		var i = sel[j], k = target[i];
		if (may[k] && k !== code) {
			target[i] = code; changed++;
			if (counts) { if (--counts[k] === 0) delete counts[k]; counts[code] = (counts[code] || 0) + 1; }
		}
	}
	return { columns: out, changed: changed };
}
