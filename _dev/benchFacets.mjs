// _dev/benchFacets.mjs
//==========================================================
// findFacets and jointSets on a real scan, read as Kirra reads it (x, y,
// z as Float32 after a local origin). An optional crop keeps a share of
// the plan box about its centre (e.g. 0.2 keeps the middle 20 % x 20 %),
// printed as a share, never as coordinates. Prints the facets, the sets
// (dip / dip direction, K, cone, facets, area) and the timings.
// Usage: node _dev/benchFacets.mjs <sample id | path> [maxDistance=0.3] [crop=1] [maxAngle=10] [setAngle=15]
// A sample id (s1, s2 …, from test/helpers/samples.js) is printed instead
// of the path, so the output never names a private file.
//==========================================================

import { openLas, findFacets, jointSets, selectBox, keepPoints } from "../src/index.js";
import { findSamples } from "../test/helpers/samples.js";

var arg = process.argv[2], maxDistance = Number(process.argv[3] || 0.3), crop = Number(process.argv[4] || 1);
var maxAngle = Number(process.argv[5] || 10), setAngle = Number(process.argv[6] || 15);
if (!arg) { console.error("usage: node _dev/benchFacets.mjs <sample id | path> [maxDistance=0.3] [crop=1] [maxAngle=10] [setAngle=15]"); process.exit(1); }
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
console.log(label + ": " + all.toLocaleString("en") + " points (read " + Math.round(performance.now() - t0) + " ms)" + (crop < 1 ? "; the middle " + Math.round(crop * 100) + " % x " + Math.round(crop * 100) + " % of the plan box: " + cols.count.toLocaleString("en") + " points" : "") + "; maxDistance " + maxDistance + ", maxAngle " + maxAngle);

var t1 = performance.now(), f = findFacets(cols, { maxDistance: maxDistance, maxAngle: maxAngle });
var inFacets = 0;
for (var i = 0; i < f.facet.length; i++) if (f.facet[i]) inFacets++;
var areas = f.facets.reduce(function (sum, x) { return sum + x.area; }, 0);
console.log("findFacets: " + Math.round(performance.now() - t1) + " ms; " + f.facets.length + " facets (>= 1 m²) holding " + inFacets.toLocaleString("en") + " points (" + (100 * inFacets / cols.count).toFixed(0) + " %), " + areas.toFixed(0) + " m²; plane distance " + (f.planeDistance * 1000).toFixed(1) + " mm");
var t2 = performance.now(), j = jointSets(f.facets, { maxAngle: setAngle });
console.log("jointSets (maxAngle " + setAngle + "): " + Math.round(performance.now() - t2) + " ms; " + j.families.length + " sets");
j.families.slice(0, 8).forEach(function (s) {
	console.log("  set " + s.id + ": " + s.dip.toFixed(0) + "/" + ("00" + s.dipDirection.toFixed(0)).slice(-3) + "  K " + (s.fisherK === s.fisherK ? s.fisherK.toFixed(0) : "-") + "  cone95 " + (s.cone95 === s.cone95 ? s.cone95.toFixed(1) : "-") + "  facets " + s.facets + "  area " + s.area.toFixed(0) + " m²");
});
