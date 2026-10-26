// src/fragments/sizeDistribution.js
//==========================================================
// The size distribution of a list of fragments, or of a findFragments
// result: % passing by size, weighted by area (the default), volume
// ((pi / 6) a b^2: an ellipsoid with the unseen depth taken as b) or
// count. Not a rock is fines: given the result, the share of the
// surface in no fragment, in sheets and in fragments under the lower
// limit (by default the cloud's floor) is the fines share, by area
// whatever the weight, and the curve starts there; fragments over an
// upper limit (the crusher gap, say) are one share, not sizes. An
// optional fines share (mass the surface cannot show) is added on top,
// under the smallest size or at finesSize. A Swebrec or Rosin-Rammler
// curve is fitted to the coarse part only (fitFrom % passing and up,
// below 100), where a scan's sizes hold; below the measured curve the
// fit stands in, and P-values taken from it are marked extrapolated.
// Swebrec, P = 1 / (1 + (ln(xmax / x) / ln(xmax / x50))^b), is a
// straight line in ln(1/P - 1) against ln ln(xmax / x) for a fixed
// xmax; a golden-section search picks xmax, above the largest fragment
// measured and up to 3 x it. Rosin-Rammler,
// P = 1 - exp(-ln 2 (x / x50)^n), is a straight line in
// ln(-ln(1 - P)) against ln x. Both are deterministic.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

var MODELS = { swebrec: 1, "rosin-rammler": 1 }, WEIGHTS = { volume: 1, area: 1, count: 1 };
var GOLDEN = (Math.sqrt(5) - 1) / 2, GOLDEN_STEPS = 60;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function finite(v) { return typeof v === "number" && isFinite(v); }

function options(input, opts) {
	if (opts !== undefined && (opts === null || typeof opts !== "object")) throw bad("sizeDistribution options must be an object");
	var o = opts || {}, isResult = !!input && typeof input === "object" && !Array.isArray(input);
	var fragments = isResult ? input.fragments : input;
	var weight = o.weight === undefined ? "area" : o.weight;
	if (!WEIGHTS[weight]) throw bad("weight must be \"volume\", \"area\" or \"count\", not " + JSON.stringify(weight));
	var model = o.model === undefined ? "swebrec" : o.model;
	if (!MODELS[model]) throw bad("model must be \"swebrec\" or \"rosin-rammler\", not " + JSON.stringify(model));
	var fitFrom = o.fitFrom === undefined ? 60 : o.fitFrom;
	if (!finite(fitFrom) || fitFrom < 0 || fitFrom >= 100) throw bad("fitFrom must be a % passing in [0, 100), not " + JSON.stringify(fitFrom));
	var fines = o.fines === undefined ? 0 : o.fines;
	if (!finite(fines) || fines < 0 || fines >= 1) throw bad("fines must be a share in [0, 1), not " + JSON.stringify(fines));
	var percents = o.percents === undefined ? [10, 20, 50, 80, 90] : o.percents;
	if (!Array.isArray(percents) || !percents.every(function (p) { return finite(p) && p > 0 && p < 100; })) throw bad("percents must be numbers in (0, 100), not " + JSON.stringify(percents));
	if (!Array.isArray(fragments)) throw bad("fragments must be an array of fragments, or findFragments' result (its fragments)");
	var floor = isResult && finite(input.floor) ? input.floor : 0;
	var lower = o.lower === undefined ? floor : o.lower;
	if (!finite(lower) || lower < 0) throw bad("lower must be a size >= 0 (0: no lower limit), not " + JSON.stringify(o.lower));
	var upper = o.upper === undefined ? 0 : o.upper;
	if (!finite(upper) || upper < 0 || (upper > 0 && !(upper > lower))) throw bad("upper must be 0 (no limit) or a size above lower (" + lower + "), not " + JSON.stringify(o.upper));
	var finesSize = o.finesSize;
	if (finesSize !== undefined && (!finite(finesSize) || !(finesSize > 0) || (lower > 0 && !(finesSize < lower)))) throw bad("finesSize must be a positive size" + (lower > 0 ? " under lower (" + lower + ")" : "") + ", not " + JSON.stringify(finesSize));
	var needArea = isResult || lower > 0 || fragments.some(function (f) { return f && f.sheet === true; });
	fragments.forEach(function (f, i) {
		if (!f || typeof f !== "object" || !finite(f.size)) throw bad("fragments[" + i + "] needs a finite size");
		if (weight === "volume" && !(Array.isArray(f.axes) && f.axes.length === 3 && f.axes.every(finite))) throw bad("fragments[" + i + "] needs axes [a, b, c] to weigh by volume");
		if ((weight === "area" || needArea) && !finite(f.area)) throw bad("fragments[" + i + "] needs a finite area " + (weight === "area" ? "to weigh by area" : "for the fines share"));
	});
	var warnings = [];
	if (isResult && o.lower !== undefined && floor > 0 && lower < floor) warnings.push({ code: "LOWER_UNDER_FLOOR", message: "Lower limit " + lower + " is under this cloud's floor (" + floor.toFixed(2) + "): the curve between them is not measured." });
	return { fragments: fragments, unassigned: isResult && finite(input.unassignedArea) ? input.unassignedArea : 0, surface: isResult && finite(input.surfaceArea) ? input.surfaceArea : 0, needArea: needArea, lower: lower, upper: upper, finesSize: finesSize,
		warnings: warnings, weight: weight, model: model, fitFrom: fitFrom, fines: fines, percents: percents };
}

function weightOf(f, weight) {
	if (weight === "count") return 1;
	if (weight === "area") return f.area;
	return Math.PI / 6 * f.axes[0] * f.axes[1] * f.axes[1];
}

// least squares Y = s X + c; null when X has no spread
function line(X, Y) {
	var n = X.length, mx = 0, my = 0, sxx = 0, sxy = 0, i;
	for (i = 0; i < n; i++) { mx += X[i]; my += Y[i]; }
	mx /= n; my /= n;
	for (i = 0; i < n; i++) { var dx = X[i] - mx; sxx += dx * dx; sxy += dx * (Y[i] - my); }
	if (!(sxx > 1e-300)) return null;
	var s = sxy / sxx;
	return { s: s, c: my - s * mx };
}

function rmseOf(xs, ps, passing) {
	var e = 0;
	for (var i = 0; i < xs.length; i++) { var d = passing(xs[i]) - 100 * ps[i]; e += d * d; }
	return Math.sqrt(e / xs.length);
}

function swebrecCurve(x50, xmax, b) {
	var l50 = Math.log(xmax / x50);
	return {
		passing: function (x) { return x <= 0 ? 0 : x >= xmax ? 100 : 100 / (1 + Math.pow(Math.log(xmax / x) / l50, b)); },
		sizeAt: function (P) { return P <= 0 ? 0 : P >= 100 ? xmax : xmax / Math.exp(l50 * Math.pow(100 / P - 1, 1 / b)); },
	};
}

function rosinCurve(x50, n) {
	return {
		passing: function (x) { return x <= 0 ? 0 : 100 * (1 - Math.exp(-Math.LN2 * Math.pow(x / x50, n))); },
		sizeAt: function (P) { return P <= 0 ? 0 : P >= 100 ? Infinity : x50 * Math.pow(-Math.log(1 - P / 100) / Math.LN2, 1 / n); },
	};
}

// Swebrec for a fixed xmax: { x50, b, curve, rmse } or null
function swebrecAt(xs, ps, xmax) {
	var X = xs.map(function (x) { return Math.log(Math.log(xmax / x)); });
	var Y = ps.map(function (p) { return Math.log(1 / p - 1); });
	var l = line(X, Y);
	if (!l || !(l.s > 0)) return null;
	var b = l.s, x50 = xmax / Math.exp(Math.exp(-l.c / b));
	if (!(x50 > 0 && x50 < xmax)) return null;
	var curve = swebrecCurve(x50, xmax, b);
	return { x50: x50, b: b, curve: curve, rmse: rmseOf(xs, ps, curve.passing) };
}

// largest: the largest fragment measured (the top point, at 100 %, is not fitted, but bounds xmax all the same)
function fitCurve(xs, ps, model, fitFrom, largest) {
	if (xs.length < 3) return null;
	var best = null, lo, hi;
	if (model === "rosin-rammler") {
		var l = line(xs.map(Math.log), ps.map(function (p) { return Math.log(-Math.log(1 - p)); }));
		if (!l || !(l.s > 0)) return null;
		var n = l.s, x50 = Math.exp((Math.log(Math.LN2) - l.c) / n), rc = rosinCurve(x50, n);
		best = { model: model, x50: x50, n: n, rmse: rmseOf(xs, ps, rc.passing), curve: rc };
	} else {
		lo = largest * (1 + 1e-6); hi = 3 * largest;
		var score = function (xmax) {
			var f = swebrecAt(xs, ps, xmax);
			if (f && (!best || f.rmse < best.rmse)) best = { model: model, x50: f.x50, xmax: xmax, b: f.b, rmse: f.rmse, curve: f.curve };
			return f ? f.rmse : Infinity;
		};
		var a = hi - GOLDEN * (hi - lo), c = lo + GOLDEN * (hi - lo), fa = score(a), fc = score(c);
		for (var step = 0; step < GOLDEN_STEPS; step++) {
			if (fa <= fc) { hi = c; c = a; fc = fa; a = hi - GOLDEN * (hi - lo); fa = score(a); }
			else { lo = a; a = c; fa = fc; c = lo + GOLDEN * (hi - lo); fc = score(c); }
		}
		if (!best) return null;
	}
	var out = { model: best.model, x50: best.x50 };
	if (model === "swebrec") { out.xmax = best.xmax; out.b = best.b; } else out.n = best.n;
	out.rmse = best.rmse; out.from = fitFrom; out.range = [xs[0], xs[xs.length - 1]];
	out.passing = best.curve.passing; out.sizeAt = best.curve.sizeAt;
	return out;
}

/**
 * The size distribution of fragments: the measured % passing curve between the limits, a Swebrec or
 * Rosin-Rammler fit to its coarse part, and P-values.
 * @param {Array<{size: number, axes?: number[], area?: number, sheet?: boolean}>|object} input - findFragments'
 *   result (its fragments, floor, unassignedArea), or an array of fragments (0.11.0's form); fragments of size 0
 *   or less (no measurable size) are left out.
 * @param {{weight?: string, model?: string, fitFrom?: number, fines?: number, finesSize?: number, lower?: number,
 *   upper?: number, percents?: number[]}} [options] - weight "area" (default), "volume" ((pi / 6) a b^2) or
 *   "count"; model "swebrec" (default) or "rosin-rammler"; fitFrom 60 (% passing); lower: the result's floor, or 0
 *   for an array (0: none); upper 0 (none); fines 0 (unseen mass, a share of the whole, under the smallest size or
 *   at finesSize); percents [10, 20, 50, 80, 90].
 * @returns {{size: Float64Array, passing: Float64Array, sizeAt: function(number): number,
 *   passingAt: function(number): number, fit: object|null, p: object, lower: number, upper: number,
 *   finesShare: number, over: number, warnings: Array<{code: string, message: string}>}} sizes ascending, % passing
 *   (0 ... 100), with the points at finesSize, lower and upper; fit { model, x50, xmax, b | n, rmse, from, range,
 *   passing(x), sizeAt(P) } or null (fewer than 3 measured points from fitFrom up and below 100); finesShare: % of
 *   the surface that is not a rock; over: % over upper; p[P] = { size, extrapolated, below, above } (below: in the
 *   fines, size = lower; above: over upper, size = upper).
 * @throws {LasError} INVALID_ARGUMENT naming the bad argument.
 */
export function sizeDistribution(input, opts) {
	var o = options(input, opts), lower = o.lower, upper = o.upper, eps = o.fines, i;
	// fines by area: the unassigned surface, the sheets, the fragments under the lower limit; the rest is measured.
	// Given a result, the share is of surfaceArea: the unassigned part as it is, the fragments sharing the rest
	// by their areas (outline areas need not add up to the plan surface)
	var fragFines = 0, fragArea = 0, kept = [];
	o.fragments.forEach(function (f) {
		if (!(f.size > 0)) return;
		if (o.needArea) fragArea += f.area;
		if (f.sheet === true || f.size < lower) { fragFines += f.area; return; }
		kept.push({ size: f.size, w: weightOf(f, o.weight) });
	});
	var phi = 0, U = o.unassigned, S = o.surface;
	if (o.needArea && S > 0) phi = fragArea > 0 ? Math.max(0, 1 - Math.max(0, S - U) / S * (fragArea - fragFines) / fragArea) : 1;   // 1 - the measured share: exactly 1 when nothing is measured
	else if (o.needArea && U + fragArea > 0) phi = (U + fragFines) / (U + fragArea);
	kept.sort(function (a, b) { return a.size - b.size; });
	if (o.finesSize !== undefined && kept.length && !(o.finesSize < kept[0].size)) throw bad("finesSize must be under the smallest size measured (" + kept[0].size + "), not " + o.finesSize);
	var wTotal = 0, wOver = 0;
	kept.forEach(function (k) { wTotal += k.w; if (upper > 0 && k.size > upper) wOver += k.w; });
	var overShare = wTotal > 0 ? (1 - phi) * wOver / wTotal : 0;
	function pct(scan) { return 100 * (eps + (1 - eps) * scan); }
	// the curve's points: the fines point, the lower limit, the measured sizes up to the upper limit, then the
	// upper limit and the largest
	var pts = [], meas = [], run = 0;
	if (o.finesSize !== undefined) pts.push([o.finesSize, pct(0)]);
	if (lower > 0) pts.push([lower, kept.length ? pct(phi) : 100]);
	for (i = 0; i < kept.length; i++) {
		run += kept[i].w;
		if (upper > 0 && kept[i].size > upper) continue;
		var P = i === kept.length - 1 || !(wTotal > 0) ? 100 : pct(phi + (1 - phi) * run / wTotal);
		if (meas.length && meas[meas.length - 1][0] === kept[i].size) meas[meas.length - 1][1] = P;
		else meas.push([kept[i].size, P]);
	}
	pts = pts.concat(meas);
	if (wOver > 0) { pts.push([upper, pct(1 - overShare)]); pts.push([kept[kept.length - 1].size, 100]); }
	var dedup = [];
	pts.forEach(function (q) { if (dedup.length && dedup[dedup.length - 1][0] === q[0]) dedup[dedup.length - 1][1] = Math.max(dedup[dedup.length - 1][1], q[1]); else dedup.push(q); });
	var m = dedup.length, size = new Float64Array(m), passing = new Float64Array(m);
	dedup.forEach(function (q, j) { size[j] = q[0]; passing[j] = q[1]; });

	var xs = [], ps = [];
	meas.forEach(function (q) { if (q[1] >= o.fitFrom && q[1] < 100) { xs.push(q[0]); ps.push(q[1] / 100); } });
	var fit = m ? fitCurve(xs, ps, o.model, o.fitFrom, size[m - 1]) : null;

	function sizeAt(P) {
		if (!m || !(P === P)) return NaN;
		if (P >= passing[m - 1]) return size[m - 1];
		if (P < passing[0]) return fit ? fit.sizeAt(P) : NaN;
		for (var k = 0; k < m - 1 && passing[k + 1] < P; k++);
		if (passing[k + 1] === passing[k]) return size[k];
		var t = (P - passing[k]) / (passing[k + 1] - passing[k]);
		return Math.exp(Math.log(size[k]) + t * (Math.log(size[k + 1]) - Math.log(size[k])));
	}
	function passingAt(x) {
		if (!m || !(x === x)) return NaN;
		if (x >= size[m - 1]) return 100;
		if (x < size[0]) return fit ? fit.passing(x) : NaN;
		for (var k = 0; k < m - 1 && size[k + 1] < x; k++);
		var t = (Math.log(x) - Math.log(size[k])) / (Math.log(size[k + 1]) - Math.log(size[k]));
		return passing[k] + t * (passing[k + 1] - passing[k]);
	}
	var finesPct = kept.length ? pct(phi) : 100, overPct = 100 * (1 - eps) * overShare, p = {};
	o.percents.forEach(function (P) {
		if (lower > 0 && P <= finesPct) p[P] = { size: lower, extrapolated: false, below: true, above: false };
		else if (overPct > 0 && P > 100 - overPct) p[P] = { size: upper, extrapolated: false, below: false, above: true };
		else p[P] = { size: sizeAt(P), extrapolated: !(m && P >= passing[0]), below: false, above: false };
	});
	return { size: size, passing: passing, sizeAt: sizeAt, passingAt: passingAt, fit: fit, p: p, lower: lower, upper: upper,
		finesShare: 100 * phi, over: overPct, warnings: o.warnings };
}
