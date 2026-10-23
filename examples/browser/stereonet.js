// examples/browser/stereonet.js
//==========================================================
// A lower-hemisphere equal-area (Schmidt) net in plain SVG, for the
// Facets tab: each facet's pole (a dot sized by area, coloured by its
// set), each set's mean pole (a ring) and its 95 % cone (a small
// circle), N / E / S / W ticks. A pole is drawn as the downward unit
// vector: a plane of dip d and dip direction a plots at trend a + 180,
// plunge 90 - d, radius R sqrt(2) sin((90 - plunge) / 2), north up, so a
// horizontal plane plots at the centre and a vertical one on the rim. A
// cone point that leaves the lower hemisphere is replaced by its
// antipode, so a cone that crosses the rim continues from the opposite side.
//==========================================================

var NS = "http://www.w3.org/2000/svg", R = 100, D = Math.PI / 180;

function el(name, attrs, parent) {
	var e = document.createElementNS(NS, name);
	Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
	if (parent) parent.appendChild(e);
	return e;
}

// The net position of a direction (any sign): the lower-hemisphere unit vector, projected
export function project(v) {
	var l = Math.hypot(v[0], v[1], v[2]), x = v[0] / l, y = v[1] / l, z = v[2] / l;
	if (z > 0) { x = -x; y = -y; z = -z; }
	var plunge = Math.asin(Math.min(1, -z)), trend = Math.atan2(x, y);
	var r = R * Math.SQRT2 * Math.sin((Math.PI / 2 - plunge) / 2);
	return [r * Math.sin(trend), -r * Math.cos(trend)];
}

// 72 points of the small circle of radius a (degrees) about m, each projected
function smallCircle(m, a) {
	var l = Math.hypot(m[0], m[1], m[2]), u = [m[0] / l, m[1] / l, m[2] / l];
	var e = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
	var p = [u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]], pl = Math.hypot(p[0], p[1], p[2]);
	p = [p[0] / pl, p[1] / pl, p[2] / pl];
	var q = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]], out = [];
	for (var i = 0; i <= 72; i++) {
		var t = i * 5 * D, c = Math.cos(a * D), s = Math.sin(a * D);
		out.push(project([0, 1, 2].map(function (k) { return c * u[k] + s * (Math.cos(t) * p[k] + Math.sin(t) * q[k]); })));
	}
	return out;
}

/**
 * Draw the net into an SVG element (viewBox -110 -110 220 220).
 * @param {SVGElement} svg
 * @param {Array<{normal: number[], area: number}>|null} facets - findFacets' list (null: an empty net).
 * @param {Array<{id: number, normal: number[], cone95: number}>|null} families - jointSets' sets.
 * @param {Uint32Array|null} family - each facet's set (0 none).
 * @param {function(number): string} colourOf - a set's CSS colour (0: none).
 */
export function drawStereonet(svg, facets, families, family, colourOf) {
	while (svg.firstChild) svg.removeChild(svg.firstChild);
	el("circle", { cx: 0, cy: 0, r: R, fill: "none", stroke: "currentColor", "stroke-width": 0.8, opacity: 0.8 }, svg);
	el("path", { d: "M -4 0 H 4 M 0 -4 V 4", stroke: "currentColor", "stroke-width": 0.5, opacity: 0.6 }, svg);
	[["N", 0, -R - 3], ["E", R + 3, 0], ["S", 0, R + 3], ["W", -R - 3, 0]].forEach(function (t) {
		var tick = el("text", { x: t[1], y: t[2], "font-size": 8, fill: "currentColor", "text-anchor": "middle", "dominant-baseline": "middle", opacity: 0.8 }, svg);
		tick.textContent = t[0];
	});
	if (!facets || !facets.length) return;
	var maxArea = Math.max.apply(null, facets.map(function (f) { return f.area || 0; })) || 1;
	facets.forEach(function (f, i) {
		var p = project(f.normal), set = family ? family[i] : 0;
		el("circle", { cx: p[0].toFixed(2), cy: p[1].toFixed(2), r: (1.2 + 3.5 * Math.sqrt((f.area || 0) / maxArea)).toFixed(2), fill: colourOf(set), "fill-opacity": 0.75 }, svg);
	});
	(families || []).forEach(function (fam) {
		var c = colourOf(fam.id), m = project(fam.normal);
		if (fam.cone95 === fam.cone95 && fam.cone95 > 0) {
			// break the line where it jumps across the net (a cone wrapping over the rim)
			var pts = smallCircle(fam.normal, fam.cone95), d = "";
			pts.forEach(function (pt, k) {
				var jump = k > 0 && Math.hypot(pt[0] - pts[k - 1][0], pt[1] - pts[k - 1][1]) > R;
				d += (k === 0 || jump ? "M " : "L ") + pt[0].toFixed(2) + " " + pt[1].toFixed(2) + " ";
			});
			el("path", { d: d, fill: "none", stroke: c, "stroke-width": 1.2 }, svg);
		}
		el("circle", { cx: m[0].toFixed(2), cy: m[1].toFixed(2), r: 4.5, fill: "none", stroke: c, "stroke-width": 1.5 }, svg);
		var label = el("text", { x: (m[0] + 6).toFixed(2), y: (m[1] - 6).toFixed(2), "font-size": 8, fill: c }, svg);
		label.textContent = String(fam.id);
	});
}
