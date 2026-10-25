// src/fragments/sizeDistribution.js
//==========================================================
// The size distribution of a list of fragments: % passing by size,
// weighted by volume ((pi / 6) a b^2: an ellipsoid with the unseen
// depth taken as b), area or count, with an optional fines share added
// as a bin under the smallest fragment. A Swebrec or Rosin-Rammler
// curve is fitted to the coarse part only (fitFrom % passing and up,
// below 100), where a scan's sizes hold; below the measured curve the
// fit stands in, and P-values taken from it are marked extrapolated.
// Swebrec, P = 1 / (1 + (ln(xmax / x) / ln(xmax / x50))^b), is a
// straight line in ln(1/P - 1) against ln ln(xmax / x) for a fixed
// xmax; a golden-section search picks xmax. Rosin-Rammler,
// P = 1 - exp(-ln 2 (x / x50)^n), is a straight line in
// ln(-ln(1 - P)) against ln x. Both are deterministic.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

var MODELS = { swebrec: 1, "rosin-rammler": 1 }, WEIGHTS = { volume: 1, area: 1, count: 1 };
var GOLDEN = (Math.sqrt(5) - 1) / 2, GOLDEN_STEPS = 60;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function finite(v) { return typeof v === "number" && isFinite(v); }

function options(fragments, opts) {
	if (opts !== undefined && (opts === null || typeof opts !== "object")) throw bad("sizeDistribution options must be an object");
	var o = opts || {};
	var weight = o.weight === undefined ? "volume" : o.weight;
	if (!WEIGHTS[weight]) throw bad("weight must be \"volume\", \"area\" or \"count\", not " + JSON.stringify(weight));
	var model = o.model === undefined ? "swebrec" : o.model;
	if (!MODELS[model]) throw bad("model must be \"swebrec\" or \"rosin-rammler\", not " + JSON.stringify(model));
	var fitFrom = o.fitFrom === undefined ? 60 : o.fitFrom;
	if (!finite(fitFrom) || fitFrom < 0 || fitFrom >= 100) throw bad("fitFrom must be a % passing in [0, 100), not " + JSON.stringify(fitFrom));
	var fines = o.fines === undefined ? 0 : o.fines;
	if (!finite(fines) || fines < 0 || fines >= 1) throw bad("fines must be a share in [0, 1), not " + JSON.stringify(fines));
	var percents = o.percents === undefined ? [10, 20, 50, 80, 90] : o.percents;
	if (!Array.isArray(percents) || !percents.every(function (p) { return finite(p) && p > 0 && p < 100; })) throw bad("percents must be numbers in (0, 100), not " + JSON.stringify(percents));
	if (!Array.isArray(fragments)) throw bad("fragments must be an array of fragments (findFragments' fragments)");
	fragments.forEach(function (f, i) {
		if (!f || typeof f !== "object" || !finite(f.size)) throw bad("fragments[" + i + "] needs a finite size");
		if (weight === "volume" && !(Array.isArray(f.axes) && f.axes.length === 3 && f.axes.every(finite))) throw bad("fragments[" + i + "] needs axes [a, b, c] to weigh by volume");
		if (weight === "area" && !finite(f.area)) throw bad("fragments[" + i + "] needs a finite area to weigh by area");
	});
	return { weight: weight, model: model, fitFrom: fitFrom, fines: fines, percents: percents };
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

function fitCurve(xs, ps, model, fitFrom) {
	if (xs.length < 3) return null;
	var best = null, lo, hi;
	if (model === "rosin-rammler") {
		var l = line(xs.map(Math.log), ps.map(function (p) { return Math.log(-Math.log(1 - p)); }));
		if (!l || !(l.s > 0)) return null;
		var n = l.s, x50 = Math.exp((Math.log(Math.LN2) - l.c) / n), rc = rosinCurve(x50, n);
		best = { model: model, x50: x50, n: n, rmse: rmseOf(xs, ps, rc.passing), curve: rc };
	} else {
		var largest = xs[xs.length - 1];
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
 * The size distribution of fragments: the measured % passing curve, a Swebrec or Rosin-Rammler
 * fit to its coarse part, and P-values.
 * @param {Array<{size: number, axes?: number[], area?: number}>} fragments - findFragments' fragments;
 *   ones of size 0 or less (no measurable size) are left out.
 * @param {{weight?: string, model?: string, fitFrom?: number, fines?: number, percents?: number[]}} [options] -
 *   weight "volume" (default, (pi / 6) a b^2), "area" or "count"; model "swebrec" (default) or
 *   "rosin-rammler"; fitFrom 60 (% passing); fines 0 (the share of the whole mass below the smallest
 *   fragment); percents [10, 20, 50, 80, 90].
 * @returns {{size: Float64Array, passing: Float64Array, sizeAt: function(number): number,
 *   passingAt: function(number): number, fit: object|null, p: object}} sizes ascending, % passing (0 ... 100);
 *   fit { model, x50, xmax, b | n, rmse, from, range, passing(x), sizeAt(P) } or null (fewer than 3 points
 *   from fitFrom up and below 100); p[P] = { size, extrapolated }.
 * @throws {LasError} INVALID_ARGUMENT naming the bad argument.
 */
export function sizeDistribution(fragments, opts) {
	var o = options(fragments, opts);
	var kept = fragments.filter(function (f) { return f.size > 0; }).map(function (f) { return { size: f.size, w: weightOf(f, o.weight) }; });
	kept.sort(function (a, b) { return a.size - b.size; });
	var sizes = [], cum = [], run = 0, i;
	for (i = 0; i < kept.length; i++) {
		run += kept[i].w;
		if (sizes.length && sizes[sizes.length - 1] === kept[i].size) cum[cum.length - 1] = run;
		else { sizes.push(kept[i].size); cum.push(run); }
	}
	var total = run, F = o.fines / (1 - o.fines) * total, m = sizes.length;
	var size = Float64Array.from(sizes), passing = new Float64Array(m);
	for (i = 0; i < m; i++) passing[i] = i === m - 1 ? 100 : (F + cum[i]) / (F + total) * 100;
	if (m && !(total > 0)) passing.fill(100);

	var xs = [], ps = [];
	for (i = 0; i < m; i++) if (passing[i] >= o.fitFrom && passing[i] < 100) { xs.push(size[i]); ps.push(passing[i] / 100); }
	var fit = fitCurve(xs, ps, o.model, o.fitFrom);

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
	var p = {};
	o.percents.forEach(function (P) { p[P] = { size: sizeAt(P), extrapolated: !(m && P >= passing[0]) }; });
	return { size: size, passing: passing, sizeAt: sizeAt, passingAt: passingAt, fit: fit, p: p };
}
