// _dev/scoreFragments.mjs
//==========================================================
// findFragments scored against rock outlines drawn by hand: each drawn
// rock (a closed polygon, in plan) is a match when one fragment covers
// it with IoU >= 0.5 over the points, merged when it lies mostly in a
// fragment that is mostly something else, split when it is in pieces
// (or under half covered), else missed. Prints the cloud's spacing,
// floor, resolution and warnings, the tally by drawn size b, the
// matched b / drawn b, and the fines share and P20-P90 by area
// (sizeDistribution on the result). The outlines come from Kirra's
// drawings.json (inside a .kap: unzip it) or an R12 DXF of POLYLINE /
// LWPOLYLINE entities, in the cloud's world coordinates. A sample id
// (s1, s2 …, test/helpers/samples.js) is printed instead of a path, so
// the output never names a private file.
// Usage: node _dev/scoreFragments.mjs <sample id | path> <drawings.json | rocks.dxf> [method=facets] [options JSON]
//==========================================================

import { readFileSync } from "node:fs";
import { openLas, findFragments, sizeDistribution } from "../src/index.js";
import { fragmentAxes } from "../src/fragments/axes.js";
import { findSamples } from "../test/helpers/samples.js";

var [arg, drawn, method = "facets", extra = "{}"] = process.argv.slice(2);
if (!arg || !drawn) { console.error("usage: node _dev/scoreFragments.mjs <sample id | path> <drawings.json | rocks.dxf> [method] [options JSON]"); process.exit(1); }
var path = arg, label = "(path given)";
if (/^s\d+$/.test(arg)) {
	var s = findSamples().find(function (x) { return x.id === arg; });
	if (!s) { console.error("no sample " + arg); process.exit(1); }
	path = s.path; label = s.id;
}

// closed outlines in world x / y: Kirra drawings.json ([name, { data: [{ pointXLocation, pointYLocation }] }])
// or DXF POLYLINE / VERTEX and LWPOLYLINE
function outlines(file) {
	var text = readFileSync(file, "utf8");
	if (/\.json$/i.test(file)) return JSON.parse(text).map(function (e) { return e[1].data.map(function (q) { return [q.pointXLocation, q.pointYLocation]; }); });
	var L = text.split(/\r?\n/).map(function (l) { return l.trim(); }), polys = [], cur = null, v = null, lw = null;
	for (var i = 0; i + 1 < L.length; i += 2) {
		var code = L[i], val = L[i + 1];
		if (code === "0") {
			if (v && cur) { cur.push(v); v = null; }
			if (lw) { polys.push(lw); lw = null; }
			if (val === "POLYLINE") { cur = []; polys.push(cur); } else if (val === "VERTEX" && cur) v = []; else if (val === "LWPOLYLINE") lw = []; else if (val === "SEQEND") cur = null;
			continue;
		}
		if (v && code === "10") v[0] = Number(val); if (v && code === "20") v[1] = Number(val);
		if (lw && code === "10") lw.push([Number(val), NaN]); if (lw && code === "20" && lw.length) lw[lw.length - 1][1] = Number(val);
	}
	if (lw) polys.push(lw);
	return polys.filter(function (p) { return p.length >= 3; });
}

var las = await openLas(path), b = las.header.bounds, O = { x: b.minX, y: b.minY, z: b.minZ };
var c = await las.readPoints({ fields: ["x", "y", "z"], localOrigin: O, float32: true });
await las.close();
var n = c.count, polys = outlines(drawn).map(function (P) { return P.map(function (q) { return [q[0] - O.x, q[1] - O.y]; }); });
function inside(P, x, y) { var r = false; for (var i = 0, j = P.length - 1; i < P.length; j = i++) { var a = P[i], q = P[j]; if ((a[1] > y) !== (q[1] > y) && x < (q[0] - a[0]) * (y - a[1]) / (q[1] - a[1]) + a[0]) r = !r; } return r; }
var boxes = polys.map(function (P) { var bx = [Infinity, Infinity, -Infinity, -Infinity]; P.forEach(function (q) { bx[0] = Math.min(bx[0], q[0]); bx[1] = Math.min(bx[1], q[1]); bx[2] = Math.max(bx[2], q[0]); bx[3] = Math.max(bx[3], q[1]); }); return bx; });
var rocks = polys.map(function () { return []; });
for (var i = 0; i < n; i++) for (var r = 0; r < polys.length; r++) { var bx = boxes[r]; if (c.x[i] < bx[0] || c.x[i] > bx[2] || c.y[i] < bx[1] || c.y[i] > bx[3]) continue; if (inside(polys[r], c.x[i], c.y[i])) { rocks[r].push(i); break; } }

var opts = Object.assign({ method: method }, JSON.parse(extra)), t0 = performance.now(), fr = findFragments(c, opts), ms = performance.now() - t0;
var cnt = new Map();
for (i = 0; i < n; i++) if (fr.fragment[i]) cnt.set(fr.fragment[i], (cnt.get(fr.fragment[i]) || 0) + 1);
var out = rocks.map(function (pts) {
	var h = new Map(), nR = pts.length;
	pts.forEach(function (p) { h.set(fr.fragment[p], (h.get(fr.fragment[p]) || 0) + 1); });
	var best = 0, bestN = 0, parts = 0;
	h.forEach(function (m, id) { if (!id) return; if (m > bestN) { bestN = m; best = id; } if (m >= 0.2 * nR) parts++; });
	var F = best ? cnt.get(best) : 0, iou = F ? bestN / (F + nR - bestN) : 0, cover = nR ? bestN / nR : 0, purity = F ? bestN / F : 0;
	var kind = iou >= 0.5 ? "match" : cover >= 0.5 && purity < 0.5 ? "merged" : parts >= 2 || (cover < 0.5 && cover >= 0.2) ? "split" : "missed";
	var trueB = nR >= 3 ? fragmentAxes(c.x, c.y, c.z, 1, Uint32Array.from(pts)).axes[1] : 0;
	return { kind: kind, trueB: trueB, fragB: best ? fr.fragments[best - 1].size : 0 };
});
function tally(rows) { var t = { match: 0, split: 0, merged: 0, missed: 0 }; rows.forEach(function (o) { t[o.kind]++; }); return t.match + " match, " + t.split + " split, " + t.merged + " merged, " + t.missed + " missed (of " + rows.length + ")"; }
function median(a) { a = a.slice().sort(function (x, y) { return x - y; }); return a.length ? a[Math.floor((a.length - 1) / 2)] : NaN; }
var psd = sizeDistribution(fr), P = function (q) { var p = psd.p[q]; return p.below ? "fines" : p.above ? "> " + p.size.toFixed(2) : p.size.toFixed(2); };
console.log(label + ": " + n.toLocaleString("en") + " points; method " + method + (extra !== "{}" ? " " + extra : "") + "; " + fr.fragments.length + " fragments in " + Math.round(ms) + " ms");
console.log("cloud: spacing " + fr.spacing.toFixed(4) + ", floor " + fr.floor.toFixed(2) + ", resolution " + fr.resolution + "; warnings: " + (fr.warnings.map(function (w) { return w.code; }).join(", ") || "none"));
console.log("drawn rocks: " + tally(out));
[[0, 0.5], [0.5, 0.7], [0.7, Infinity]].forEach(function (band) { var rows = out.filter(function (o) { return o.trueB >= band[0] && o.trueB < band[1]; }); console.log("  drawn b " + band[0] + "-" + (band[1] === Infinity ? "" : band[1]) + ": " + tally(rows)); });
console.log("matched b / drawn b, median: " + median(out.filter(function (o) { return o.kind === "match"; }).map(function (o) { return o.fragB / o.trueB; })).toFixed(2));
console.log("by area (lower = the floor): fines " + psd.finesShare.toFixed(0) + " %; P20 " + P(20) + "  P50 " + P(50) + "  P80 " + P(80) + "  P90 " + P(90));
