// test/helpers/peakMemory.mjs
//==========================================================
// Child-process probe for test/memory.test.js. Prints JSON
// { outBytes, peakDelta }: the size of what the operation returns
// and how far the process's PEAK resident set (maxRSS) rose while it
// ran. Run in its own process so earlier tests' garbage is not in it.
//   node peakMemory.mjs read  <file.las> <windowBytes>
//   node peakMemory.mjs write <pointCount>
//==========================================================
import { openLas } from "../../src/LasReader.js";
import { writeLas } from "../../src/write/writeLas.js";

function peakBytes() { return process.resourceUsage().maxRSS * 1024; }

var mode = process.argv[2];
var out, before;
if (mode === "read") {
	var las = await openLas(process.argv[3], { windowSize: Number(process.argv[4]) });
	before = peakBytes();
	var pts = await las.readPoints({ fields: ["x", "y", "z"] });
	out = pts.x.byteLength + pts.y.byteLength + pts.z.byteLength;
	await las.close();
} else {
	var n = Number(process.argv[3]);
	var cols = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { cols.x[i] = 1000 + i * 0.01; cols.y[i] = 2000 + (i % 977); cols.z[i] = i % 100; }
	before = peakBytes();
	var bytes = await writeLas(cols, { version: "1.2", pointFormat: 0 });
	out = bytes.byteLength;
}
console.log(JSON.stringify({ outBytes: out, peakDelta: peakBytes() - before }));
