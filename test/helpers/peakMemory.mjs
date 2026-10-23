// test/helpers/peakMemory.mjs
//==========================================================
// Child-process probe for test/memory.test.js. Prints JSON
// { outBytes, peakDelta }: the size of what the operation returns
// and how far the process's PEAK resident set (maxRSS) rose while it
// ran. Run in its own process so earlier tests' garbage is not in it.
//   node peakMemory.mjs read  <file.las> <windowBytes>
//   node peakMemory.mjs read-polygon <file.las> <windowBytes>   (a rectangle over the first tenth of X, full Y)
//   node peakMemory.mjs write <pointCount>
//==========================================================
import { openLas } from "../../src/LasReader.js";
import { writeLas } from "../../src/write/writeLas.js";

function peakBytes() { return process.resourceUsage().maxRSS * 1024; }

var mode = process.argv[2];
var out, before;
if (mode === "read" || mode === "read-polygon") {
	var las = await openLas(process.argv[3], { windowSize: Number(process.argv[4]) });
	var opts = { fields: ["x", "y", "z"] };
	if (mode === "read-polygon") {
		var b = las.header.bounds, x1 = b.minX + (b.maxX - b.minX) / 10;
		opts.polygon = [b.minX, b.minY, x1, b.minY, x1, b.maxY, b.minX, b.maxY];
	}
	before = peakBytes();
	var pts = await las.readPoints(opts);
	out = pts.x.byteLength + pts.y.byteLength + pts.z.byteLength;
	await las.close();
} else if (mode === "facets") {
	// one flat plane of n points (one huge facet), normals made before the baseline so only
	// findFacets' own memory is measured; outBytes is n (the peak is read per point)
	var { findFacets } = await import("../../src/facets/findFacets.js");
	var { pointNormals } = await import("../../src/ops/normals.js");
	var m = Number(process.argv[3]), side = Math.ceil(Math.sqrt(m));
	var pc = { count: m, x: new Float32Array(m), y: new Float32Array(m), z: new Float32Array(m) };
	for (var j = 0; j < m; j++) { pc.x[j] = (j % side) * 0.05; pc.y[j] = Math.floor(j / side) * 0.05; pc.z[j] = 0.002 * Math.sin(j * 12.9898); }
	var nm = pointNormals(pc, { k: 16, maxDistance: 0.2 });
	before = peakBytes();
	var ff = findFacets(pc, { maxDistance: 0.2, normals: nm, planeDistance: 0.02 });
	if (ff.facets.length !== 1) throw new Error("expected one facet, found " + ff.facets.length);
	out = m;
} else {
	var n = Number(process.argv[3]);
	var cols = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { cols.x[i] = 1000 + i * 0.01; cols.y[i] = 2000 + (i % 977); cols.z[i] = i % 100; }
	before = peakBytes();
	var bytes = await writeLas(cols, { version: "1.2", pointFormat: 0 });
	out = bytes.byteLength;
}
console.log(JSON.stringify({ outBytes: out, peakDelta: peakBytes() - before }));
