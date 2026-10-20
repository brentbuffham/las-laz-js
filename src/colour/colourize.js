// src/colour/colourize.js
//==========================================================
// Colour points: { by: "rgb" | "intensity" | "elevation" |
// "classification" } -> Uint8Array, three bytes per point.
//
// rgb: LAS stores 16-bit colour; it is scaled with round(v / 256)
//   (Kirra's rule). Files that wrongly store 8-bit values in the
//   16-bit fields (every value <= 255 — a common writer bug) are
//   used as-is instead of being divided down to almost black. This
//   detection is new in the library; Kirra divides unconditionally.
// elevation: Kirra's spectrum ramp, blue -> cyan -> green -> yellow
//   -> red, over opts.range or the data's Z range.
// intensity: greyscale over opts.range, or the 2nd-98th percentile
//   so one hot return does not wash the rest out.
// classification: conventional viewer colours. ASPRS defines the
//   codes, not colours; these follow common LiDAR-viewer practice.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

function spectrum(t) {
	if (t < 0.25) return [0, Math.floor(t * 4 * 255), 255];
	if (t < 0.5) return [0, 255, Math.floor(255 - (t - 0.25) * 4 * 255)];
	if (t < 0.75) return [Math.floor((t - 0.5) * 4 * 255), 255, 0];
	return [255, Math.floor(255 - (t - 0.75) * 4 * 255), 0];
}
function greyscale(t) { var g = Math.round(t * 255); return [g, g, g]; }

/** Colour ramps: t in [0, 1] -> [r, g, b]. */
export var RAMPS = Object.freeze({ spectrum: spectrum, greyscale: greyscale });

/** Classification code -> [r, g, b] (common LiDAR viewer colours). */
export var CLASS_COLOURS = Object.freeze({
	0: [128, 128, 128],  // created, never classified
	1: [170, 170, 170],  // unclassified
	2: [165, 113, 78],   // ground
	3: [144, 238, 144],  // low vegetation
	4: [34, 139, 34],    // medium vegetation
	5: [0, 100, 0],      // high vegetation
	6: [220, 60, 40],    // building
	7: [255, 0, 255],    // low point (noise)
	8: [255, 215, 0],    // model key point (LAS 1.2) / reserved
	9: [30, 144, 255],   // water
	10: [139, 69, 19],   // rail
	11: [90, 90, 90],    // road surface
	12: [255, 255, 0],   // overlap (1.2) / reserved
	13: [0, 255, 255],   // wire - guard
	14: [0, 206, 209],   // wire - conductor
	15: [148, 0, 211],   // transmission tower
	16: [186, 85, 211],  // wire-structure connector
	17: [205, 133, 63],  // bridge deck
	18: [255, 20, 147]   // high noise
});
var UNKNOWN = [128, 128, 128];

function need(points, name) {
	if (!points[name]) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "colourize by this mode needs the \"" + name + "\" field; read it with fields: [..., \"" + name + "\"]");
	return points[name];
}

function rangeOf(values, n) {
	var lo = Infinity, hi = -Infinity;
	for (var i = 0; i < n; i++) { var v = values[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
	return [lo, hi];
}

function percentiles(values, n) {
	var copy = Array.prototype.slice.call(values, 0, n).sort(function (a, b) { return a - b; });
	return [copy[Math.floor(0.02 * (n - 1))], copy[Math.floor(0.98 * (n - 1))]];
}

function rampColours(values, n, range, ramp) {
	var out = new Uint8Array(n * 3);
	var lo = range[0], span = range[1] - range[0];
	for (var i = 0; i < n; i++) {
		var t = span > 1e-12 ? (values[i] - lo) / span : 0.5;
		if (!(t >= 0)) t = 0; else if (t > 1) t = 1;
		var c = ramp(t);
		out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
	}
	return out;
}

/**
 * @param {object} points - PointColumns.
 * @param {{by:string, ramp?:string, range?:number[]}} opts
 * @returns {Uint8Array} r, g, b per point
 */
export function colourize(points, opts) {
	opts = opts || {};
	var n = points.count;
	var rampName = opts.ramp || (opts.by === "intensity" ? "greyscale" : "spectrum");
	var ramp = RAMPS[rampName];
	if (!ramp) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "unknown ramp \"" + rampName + "\"");
	var out, i;
	switch (opts.by) {
		case "rgb": {
			var r = need(points, "red"), g = need(points, "green"), b = need(points, "blue");
			var max = Math.max(rangeOf(r, n)[1], rangeOf(g, n)[1], rangeOf(b, n)[1]);
			var eightBit = max <= 255;
			out = new Uint8Array(n * 3);
			for (i = 0; i < n; i++) {
				out[i * 3] = eightBit ? r[i] : Math.min(255, Math.round(r[i] / 256));
				out[i * 3 + 1] = eightBit ? g[i] : Math.min(255, Math.round(g[i] / 256));
				out[i * 3 + 2] = eightBit ? b[i] : Math.min(255, Math.round(b[i] / 256));
			}
			return out;
		}
		case "elevation": {
			var z = need(points, "z");
			return rampColours(z, n, opts.range || rangeOf(z, n), ramp);
		}
		case "intensity": {
			var v = need(points, "intensity");
			return rampColours(v, n, opts.range || percentiles(v, n), ramp);
		}
		case "classification": {
			var cls = need(points, "classification");
			out = new Uint8Array(n * 3);
			for (i = 0; i < n; i++) {
				var c = CLASS_COLOURS[cls[i]] || UNKNOWN;
				out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2];
			}
			return out;
		}
		default:
			throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "colourize by \"" + opts.by + "\" is not a mode (rgb, intensity, elevation, classification)");
	}
}
