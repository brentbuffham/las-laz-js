// _dev/benchDenoise.mjs
//==========================================================
// Time selectOutliers, estimateNoise, pointNormals and denoisePoints
// (bilateral and mls) on a whole file, read as Kirra reads it (x, y, z
// as Float32 after a local origin). Memory beyond the columns is
// structural: the k-d tree about 4.6 bytes a point, an output's
// coordinates 12 bytes a point (Float32).
// Usage: node _dev/benchDenoise.mjs <sample id | path> [maxDistance=0.3] [k=16] [only]
// `only` runs one call: outliers, noise, normals, bilateral or mls.
// A sample id (s1, s2 …, from test/helpers/samples.js, or sparse1 =
// LAS_SPARSE_SAMPLE) is printed instead of the path, so the output
// never names a private file.
//==========================================================

import { openLas, selectOutliers, estimateNoise, pointNormals, denoisePoints } from "../src/index.js";
import { findSamples } from "../test/helpers/samples.js";

var arg = process.argv[2], maxDistance = Number(process.argv[3] || 0.3), k = Number(process.argv[4] || 16), only = process.argv[5];
if (!arg) {
	console.error("usage: node _dev/benchDenoise.mjs <sample id | path> [maxDistance=0.3] [k=16] [outliers|noise|normals|bilateral|mls]");
	process.exit(1);
}
var path = arg, label = "(path given)";
if (arg === "sparse1") { path = process.env.LAS_SPARSE_SAMPLE; label = "sparse1"; }
else if (/^s\d+$/.test(arg)) {
	var s = findSamples().find(function (x) { return x.id === arg; });
	if (!s) { console.error("no sample " + arg); process.exit(1); }
	path = s.path; label = s.id;
}
if (!path) { console.error("LAS_SPARSE_SAMPLE is not set"); process.exit(1); }


var las = await openLas(path), b = las.header.bounds;
var origin = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 };
var t = performance.now();
var cols = await las.readPoints({ fields: ["x", "y", "z"], localOrigin: origin, float32: true });
await las.close();
console.log(label + ": " + cols.count.toLocaleString("en") + " points (read " + Math.round(performance.now() - t) + " ms); maxDistance " + maxDistance + ", k " + k);

function run(name, fn) {
	if (only && only !== name) return;
	var t0 = performance.now(), r = fn(), ms = performance.now() - t0;
	console.log(name + ": " + r + " in " + Math.round(ms) + " ms (" + (1000 * ms / cols.count).toFixed(2) + " µs a point)");
}
run("outliers", function () { return selectOutliers(cols).length.toLocaleString("en") + " outliers"; });
run("noise", function () { return (100 * estimateNoise(cols, { k: k, maxDistance: maxDistance })).toFixed(2) + " cm"; });
run("normals", function () { pointNormals(cols, { k: k, maxDistance: maxDistance }); return "done"; });
["bilateral", "mls"].forEach(function (method) {
	run(method, function () {
		var out = denoisePoints(cols, { method: method, k: k, maxDistance: maxDistance });
		return "noise after " + (100 * estimateNoise(out, { k: k, maxDistance: maxDistance })).toFixed(2) + " cm";
	});
});
