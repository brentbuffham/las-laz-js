// _dev/benchRegister.mjs
//==========================================================
// A registration check on a real scan, with a known answer. The scan's
// odd points, moved by a known rigid transform (a rotation about Z and a
// small tilt, then a shift), stand in for the grid / reference; its even
// points are the scan to place, so ICP never pairs a point with itself.
// Six well-spread points are the control points: grid side exact, scan
// side with 2 cm of noise (picking error). Reports fitTransform on the
// control points, then alignCloud with ICP, each as the largest error
// over the whole cloud against the known transform, with timings.
// Usage: node _dev/benchRegister.mjs <sample id | path> [maxDistance=0.3]
// A sample id (s1, s2 …, from test/helpers/samples.js) is printed
// instead of the path, so the output never names a private file.
//==========================================================

import { openLas, makeTransform, fitTransform, alignCloud } from "../src/index.js";
import { findSamples } from "../test/helpers/samples.js";

var arg = process.argv[2], maxDistance = Number(process.argv[3] || 0.3);
if (!arg) { console.error("usage: node _dev/benchRegister.mjs <sample id | path> [maxDistance=0.3]"); process.exit(1); }
var path = arg, label = "(path given)";
if (/^s\d+$/.test(arg)) {
	var s = findSamples().find(function (x) { return x.id === arg; });
	if (!s) { console.error("no sample " + arg); process.exit(1); }
	path = s.path; label = s.id;
}

var las = await openLas(path), b = las.header.bounds;
var origin = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 };
var t0 = performance.now();
var all = await las.readPoints({ fields: ["x", "y", "z"], localOrigin: origin, float32: true });
await las.close();
console.log(label + ": " + all.count.toLocaleString("en") + " points (read " + Math.round(performance.now() - t0) + " ms); ICP maxDistance " + maxDistance);

// the truth: about the cloud's centre, rotate 37.3 deg about Z and tilt 0.3 deg about X, then
// shift 1,234.5 / -2,345.6 / 12.3 m (world to world)
var c = Math.cos(0.3 * Math.PI / 180), sn = Math.sin(0.3 * Math.PI / 180);
var Z = makeTransform({ rotateZ: 37.3 }).m, X = [1, 0, 0, 0, c, -sn, 0, sn, c], R = new Array(9);
for (var r = 0; r < 3; r++) for (var q = 0; q < 3; q++) R[r * 3 + q] = Z[r * 3] * X[q] + Z[r * 3 + 1] * X[3 + q] + Z[r * 3 + 2] * X[6 + q];
var TRUTH = makeTransform({ rotate: R, about: [origin.x, origin.y, origin.z], shift: [1234.5, -2345.6, 12.3] });
function apply(T, p) {
	var m = T.m, t = T.t;
	return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + t[0], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + t[1], m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + t[2]];
}

// even points: the scan (local about origin); odd points moved: the reference (local about T(origin))
var n2 = Math.floor(all.count / 2), refOrigin = apply(TRUTH, [origin.x, origin.y, origin.z]);
var scan = { count: n2, x: new Float32Array(n2), y: new Float32Array(n2), z: new Float32Array(n2) };
var ref = { count: n2, x: new Float32Array(n2), y: new Float32Array(n2), z: new Float32Array(n2) };
for (var i = 0; i < n2; i++) {
	scan.x[i] = all.x[2 * i]; scan.y[i] = all.y[2 * i]; scan.z[i] = all.z[2 * i];
	var w = apply(TRUTH, [all.x[2 * i + 1] + origin.x, all.y[2 * i + 1] + origin.y, all.z[2 * i + 1] + origin.z]);
	ref.x[i] = w[0] - refOrigin[0]; ref.y[i] = w[1] - refOrigin[1]; ref.z[i] = w[2] - refOrigin[2];
}

// six control points: the scan points nearest six spots spread over the plan box
var spots = [[0.15, 0.15], [0.85, 0.15], [0.5, 0.5], [0.15, 0.85], [0.85, 0.85], [0.5, 0.2]], from = [], to = [];
var seed = 7;
function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
function gauss() { var u = rnd() || 1e-12, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
spots.forEach(function (sp) {
	var gx = b.minX + sp[0] * (b.maxX - b.minX) - origin.x, gy = b.minY + sp[1] * (b.maxY - b.minY) - origin.y, best = -1, bd = Infinity;
	for (var j = 0; j < n2; j++) { var d = (scan.x[j] - gx) * (scan.x[j] - gx) + (scan.y[j] - gy) * (scan.y[j] - gy); if (d < bd) { bd = d; best = j; } }
	var p = [scan.x[best] + origin.x, scan.y[best] + origin.y, scan.z[best] + origin.z], g = apply(TRUTH, p);
	from.push(p[0] + 0.02 * gauss(), p[1] + 0.02 * gauss(), p[2] + 0.02 * gauss());
	to.push(g[0], g[1], g[2]);
});

// the largest error over the scan, against the truth
function worst(T) {
	var e = 0;
	for (var j = 0; j < n2; j += 97) {
		var p = [scan.x[j] + origin.x, scan.y[j] + origin.y, scan.z[j] + origin.z], a = apply(T, p), t = apply(TRUTH, p);
		e = Math.max(e, Math.hypot(a[0] - t[0], a[1] - t[1], a[2] - t[2]));
	}
	return e;
}
function mm(v) { return (v * 1000).toFixed(1) + " mm"; }

var t1 = performance.now(), f = fitTransform(from, to);
console.log("fitTransform (6 control points, 2 cm picking noise): " + Math.round(performance.now() - t1) + " ms; RMS " + mm(f.rms) + ", worst leave-one-out " + mm(f.looResiduals[f.worst]) + "; largest error over the scan " + mm(worst(f.transform)));
var t2 = performance.now();
var a = alignCloud(scan, ref, { pairs: { from: from, to: to }, movingOrigin: [origin.x, origin.y, origin.z], fixedOrigin: refOrigin, icp: { maxDistance: maxDistance } });
console.log("alignCloud with ICP (" + n2.toLocaleString("en") + " points each, tree build included): " + Math.round(performance.now() - t2) + " ms; " + a.icp.iterations + " iterations" + (a.icp.converged ? ", converged" : ", NOT converged") + "; point-to-plane RMS " + mm(a.icp.rmsBefore) + " -> " + mm(a.icp.rmsAfter) + "; overlap " + a.icp.used.toLocaleString("en") + " of " + a.icp.sampled.toLocaleString("en") + "; largest error over the scan " + mm(worst(a.transform)));
