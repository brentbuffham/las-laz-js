// _dev/benchFragments.mjs
//==========================================================
// findFragments and sizeDistribution on a real scan, read as Kirra reads
// it (x, y, z as Float32 after a local origin). An optional crop keeps a
// share of the plan box about its centre (e.g. 0.2 keeps the middle 20 %
// x 20 %), printed as a share, never as coordinates. Prints the
// fragments, the floor check, P20 / P50 / P80, the fit, the timings and
// the memory a point (the RSS rise over the run).
// Usage: node _dev/benchFragments.mjs <sample id | path> [maxDistance=0.06] [crop=1]
// A sample id (s1, s2 …, from test/helpers/samples.js) is printed instead
// of the path, so the output never names a private file.
//==========================================================

import { openLas, findFragments, sizeDistribution, selectBox, keepPoints } from "../src/index.js";
import { findSamples } from "../test/helpers/samples.js";

var arg = process.argv[2], maxDistance = Number(process.argv[3] || 0.06), crop = Number(process.argv[4] || 1);
if (!arg) { console.error("usage: node _dev/benchFragments.mjs <sample id | path> [maxDistance=0.06] [crop=1]"); process.exit(1); }
var path = arg, label = "(path given)";
if (/^s\d+$/.test(arg)) {
	var s = findSamples().find(function (x) { return x.id === arg; });
	if (!s) { console.error("no sample " + arg); process.exit(1); }
	path = s.path; label = s.id;
}

var las = await openLas(path), b = las.header.bounds;
var origin = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 };
var t0 = performance.now();
var cols = await las.readPoints({ fields: ["x", "y", "z"], localOrigin: origin, float32: true });
await las.close();
var all = cols.count;
if (crop < 1) {
	var hx = (b.maxX - b.minX) * crop / 2, hy = (b.maxY - b.minY) * crop / 2;
	cols = keepPoints({ count: cols.count, x: cols.x, y: cols.y, z: cols.z }, selectBox(cols, { minX: -hx, maxX: hx, minY: -hy, maxY: hy }));
}
console.log(label + ": " + all.toLocaleString("en") + " points (read " + Math.round(performance.now() - t0) + " ms)" + (crop < 1 ? "; the middle " + Math.round(crop * 100) + " % x " + Math.round(crop * 100) + " % of the plan box: " + cols.count.toLocaleString("en") + " points" : "") + "; maxDistance " + maxDistance);

if (global.gc) global.gc();
var rss0 = process.memoryUsage().rss, peak = rss0, timer = setInterval(function () { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
var t1 = performance.now(), f = findFragments(cols, { maxDistance: maxDistance, onProgress: function () { peak = Math.max(peak, process.memoryUsage().rss); } });
var ms = performance.now() - t1;
clearInterval(timer);
peak = Math.max(peak, process.memoryUsage().rss);
var inFragments = 0;
for (var i = 0; i < f.fragment.length; i++) if (f.fragment[i]) inFragments++;
console.log("findFragments: " + Math.round(ms) + " ms (" + (ms / cols.count * 1000).toFixed(1) + " s a million points); " + f.fragments.length + " fragments holding " + inFragments.toLocaleString("en") + " points (" + (100 * inFragments / cols.count).toFixed(0) + " %); " +
	f.facets.facets.length + " facets; plane distance " + (f.planeDistance * 1000).toFixed(1) + " mm; " + f.unassignedArea.toFixed(1) + " of " + f.surfaceArea.toFixed(1) + " m² in none; memory ~" + Math.round((peak - rss0) / cols.count) + " bytes a point");
var big = f.fragments.reduce(function (a, x) { return !a || x.area > a.area ? x : a; }, null);
if (big && big.area > 0.25 * f.surfaceArea) console.log("  fragment " + big.id + " covers " + (100 * big.area / f.surfaceArea).toFixed(0) + " % of the surface: a floor or a wall in the run");
var d = sizeDistribution(f.fragments), fit = d.fit;
console.log("sizeDistribution (volume, Swebrec from 60 %): P20 " + d.p[20].size.toFixed(3) + (d.p[20].extrapolated ? "*" : "") + "  P50 " + d.p[50].size.toFixed(3) + (d.p[50].extrapolated ? "*" : "") + "  P80 " + d.p[80].size.toFixed(3) + (d.p[80].extrapolated ? "*" : "") +
	(fit ? "; fit x50 " + fit.x50.toFixed(3) + " xmax " + fit.xmax.toFixed(3) + " b " + fit.b.toFixed(2) + " RMSE " + fit.rmse.toFixed(2) + " %" : "; no fit") + " (* from the fit)");
f.fragments.slice(0, 5).forEach(function (x) { console.log("  fragment " + x.id + ": size " + x.size.toFixed(3) + "  axes " + x.axes.map(function (v) { return v.toFixed(2); }).join(" / ") + "  " + x.count.toLocaleString("en") + " points  " + x.facets.length + " facets"); });
