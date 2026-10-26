// examples/browser/sizeChart.js
//==========================================================
// The size curve in plain SVG, for the Fragments tab: % passing up the
// side against size on a log axis (decades labelled, 2 ... 9 ticked).
// The measured curve solid (the accent colour); the fitted curve a thin
// line, dashed below the measured curve's lowest point (extrapolated:
// what the scan could not resolve); P20, P50 and P80 marked with their
// sizes, a hollow mark where the size came from the fit. With limits, the
// fines step under the lower limit and the share over the upper limit are
// drawn flat and labelled; a P-value in either is not marked.
//==========================================================

var NS = "http://www.w3.org/2000/svg", W = 400, H = 250, L = 40, RM = 12, T = 12, B = 34;

function el(name, attrs, parent) {
	var e = document.createElementNS(NS, name);
	Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
	if (parent) parent.appendChild(e);
	return e;
}
function label(svg, x, y, text, anchor) {
	var t = el("text", { x: x.toFixed(1), y: y.toFixed(1), "font-size": 9, fill: "currentColor", "text-anchor": anchor || "middle", opacity: 0.8 }, svg);
	t.textContent = text;
}
function sizeText(v) { return v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2); }

/**
 * Draw the curve into an SVG element (viewBox 0 0 400 250).
 * @param {SVGElement} svg
 * @param {object|null} psd - sizeDistribution's result (null or empty: the axes alone).
 */
export function drawSizeChart(svg, psd) {
	while (svg.firstChild) svg.removeChild(svg.firstChild);
	svg.setAttribute("viewBox", "0 0 " + W + " " + H);
	var m = psd ? psd.size.length : 0, fit = psd && psd.fit;
	// the size range: the measured curve, down to the fit's P5 when there is a fit, a decade at least
	var lo = m ? psd.size[0] : 0.01, hi = m ? psd.size[m - 1] : 1;
	if (fit) { var f5 = fit.sizeAt(5); if (f5 > 0 && f5 < lo) lo = f5; }
	var l0 = Math.floor(Math.log10(lo) + 1e-9), l1 = Math.ceil(Math.log10(hi) - 1e-9);
	if (l1 <= l0) l1 = l0 + 1;
	function X(s) { return L + (Math.log10(s) - l0) / (l1 - l0) * (W - L - RM); }
	function Y(p) { return T + (100 - p) / 100 * (H - T - B); }
	// grid and axes
	for (var p = 0; p <= 100; p += 20) {
		el("line", { x1: L, x2: W - RM, y1: Y(p).toFixed(1), y2: Y(p).toFixed(1), stroke: "currentColor", "stroke-width": 0.4, opacity: p ? 0.25 : 0.7 }, svg);
		label(svg, L - 4, Y(p) + 3, String(p), "end");
	}
	for (var d = l0; d <= l1; d++) {
		var x = X(Math.pow(10, d));
		el("line", { x1: x.toFixed(1), x2: x.toFixed(1), y1: T, y2: H - B, stroke: "currentColor", "stroke-width": 0.4, opacity: 0.35 }, svg);
		label(svg, x, H - B + 12, sizeText(Math.pow(10, d)));
		if (d < l1) for (var k = 2; k <= 9; k++) {
			var xk = X(k * Math.pow(10, d));
			el("line", { x1: xk.toFixed(1), x2: xk.toFixed(1), y1: H - B, y2: H - B + 3, stroke: "currentColor", "stroke-width": 0.4, opacity: 0.6 }, svg);
		}
	}
	label(svg, (L + W - RM) / 2, H - 6, "size b (m), log scale");
	var yl = el("text", { x: 10, y: (T + H - B) / 2, "font-size": 9, fill: "currentColor", "text-anchor": "middle", opacity: 0.8, transform: "rotate(-90 10 " + ((T + H - B) / 2) + ")" }, svg);
	yl.textContent = "% passing";
	if (!m) return;

	// the fit: thin, dashed below the measured curve
	if (fit) {
		var below = "", above = "", n = 120, a = Math.log10(Math.pow(10, l0)), b = Math.log10(Math.min(Math.pow(10, l1), fit.xmax || Infinity));
		for (var i = 0; i <= n; i++) {
			var s = Math.pow(10, a + (b - a) * i / n), v = fit.passing(s);
			if (!(v === v)) continue;
			var pt = X(s).toFixed(1) + " " + Y(Math.max(0, Math.min(100, v))).toFixed(1);
			if (s <= psd.size[0]) below += (below ? " L " : "M ") + pt;
			if (s >= psd.size[0]) above += (above ? " L " : "M ") + pt;
		}
		if (below) el("path", { d: below, fill: "none", stroke: "currentColor", "stroke-width": 1, "stroke-dasharray": "4 3", opacity: 0.8 }, svg);
		if (above) el("path", { d: above, fill: "none", stroke: "currentColor", "stroke-width": 1, opacity: 0.6 }, svg);
	}
	// the measured curve
	var dm = "";
	for (var j = 0; j < m; j++) dm += (j ? " L " : "M ") + X(psd.size[j]).toFixed(1) + " " + Y(psd.passing[j]).toFixed(1);
	el("path", { d: dm, fill: "none", class: "size-measured", "stroke-width": 2 }, svg);
	// P20 / P50 / P80
	// the fines step and the share over the upper limit
	if (psd.lower > 0 && psd.finesShare > 0) {
		var yf = Y(psd.passingAt(psd.lower));
		el("path", { d: "M " + L + " " + yf.toFixed(1) + " H " + X(psd.lower).toFixed(1), fill: "none", class: "size-measured", "stroke-width": 2, "stroke-dasharray": "5 3", opacity: 0.7 }, svg);
		label(svg, L + 4, yf - 4, psd.finesShare.toFixed(0) + "% fines under " + sizeText(psd.lower) + " m", "start");
	}
	if (psd.upper > 0 && psd.over > 0) label(svg, X(psd.upper) - 4, Y(100 - psd.over) + 12, psd.over.toFixed(0) + "% over " + sizeText(psd.upper) + " m", "end");
	[20, 50, 80].forEach(function (P) {
		var q = psd.p[P], s = q ? q.size : psd.sizeAt(P);
		if (!(s > 0) || (q && (q.below || q.above))) return;
		var cx = X(s), cy = Y(P);
		el("path", { d: "M " + L + " " + cy.toFixed(1) + " H " + cx.toFixed(1) + " V " + (H - B), fill: "none", stroke: "currentColor", "stroke-width": 0.6, "stroke-dasharray": "1 2", opacity: 0.7 }, svg);
		el("circle", { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 3, class: q && q.extrapolated ? "size-mark-fit" : "size-mark" }, svg);
		label(svg, cx + 5, cy - 5, "P" + P + " " + sizeText(s), "start");
	});
}
