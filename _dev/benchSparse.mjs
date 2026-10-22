// _dev/benchSparse.mjs
//==========================================================
// Time buildIndex and selectSparse on a whole file, read as Kirra
// reads it (x, y, z as Float32 after a local origin).
// Usage: node _dev/benchSparse.mjs <sample id | path> [radius=2] [minNeighbours=1]
// A sample id (s1, s2 …, from test/helpers/samples.js, or sparse1 =
// LAS_SPARSE_SAMPLE) is printed instead of the path, so the output
// never names a private file.
//==========================================================

import { openLas, buildIndex, selectSparse } from "../src/index.js";
import { findSamples } from "../test/helpers/samples.js";

var arg = process.argv[2], radius = Number(process.argv[3] || 2), minNeighbours = Number(process.argv[4] || 1);
if (!arg) {
	console.error("usage: node _dev/benchSparse.mjs <sample id | path> [radius=2] [minNeighbours=1]");
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

var peak = 0;
function mem() { var a = process.memoryUsage().arrayBuffers; if (a > peak) peak = a; return a; }
var timer = setInterval(mem, 50);
function mb(b) { return Math.round(b / 1048576) + " MB"; }

var las = await openLas(path), b = las.header.bounds;
var origin = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 };
var t = performance.now();
var cols = await las.readPoints({ fields: ["x", "y", "z"], localOrigin: origin, float32: true });
await las.close();
var tRead = performance.now() - t;
mem();
t = performance.now();
var index = buildIndex(cols);
var tIndex = performance.now() - t;
mem();
var indexBytes = index.order.byteLength + index.keys.byteLength + index.start.byteLength + index.length.byteLength;
index = null;
t = performance.now();
var sparse = selectSparse(cols, { radius: radius, minNeighbours: minNeighbours });
var tSparse = performance.now() - t;
mem();
clearInterval(timer);

console.log(label + ": " + cols.count.toLocaleString("en") + " points (read " + Math.round(tRead) + " ms)");
console.log("buildIndex (auto cellSize): " + Math.round(tIndex) + " ms, " + mb(indexBytes) + " (" + (indexBytes / cols.count).toFixed(2) + " bytes a point)");
console.log("selectSparse radius " + radius + ", minNeighbours " + minNeighbours + ": " + sparse.length.toLocaleString("en") + " sparse (" + (100 * sparse.length / cols.count).toFixed(3) + " %) in " + Math.round(tSparse) + " ms");
console.log("peak ArrayBuffer memory: " + mb(peak));
