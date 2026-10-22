// test/samples.test.js
//==========================================================
// Real files, as a black box (private samples, see
// test/helpers/samples.js). The oracle is each file's OWN header,
// written by the software that made it — independent of this code:
//  - the decoded point count equals the header count
//  - the decoded bounds sit within one scale step of the header bounds
//  - reading in 1 MiB windows gives the same points as 64 MiB windows
//    (files under 200 MB; the big ones are read once)
//  - a .laz is read the same way (0.2.0), and a .laz with a .las twin
//    (same point count and header bounds — matched by content, never by
//    name) decodes to exactly the twin's points, field by field (a
//    streamed SHA-256 per field, so even big pairs never sit in memory)
//  - with LAS_PDAL=<path to pdal> set, each .laz also equals PDAL's own
//    decompression of it, field by field (opt-in: it writes a temporary
//    LAS as big as the decompressed file)
//  - (0.4.0) each sample is compressed to LAZ with its own version, point
//    format, scale and offset (writeLas; createLasWriter streaming to a
//    temporary file when the points are over 200 MB decompressed), and
//    reading that back gives the original's points, field by field (a
//    streamed SHA-256 per field). The size ratio and compression time
//    are logged. With LAS_PDAL set, PDAL decompresses our file too and
//    must find the same points
//  - (0.6.0) selectSparse on a 20 m × 20 m crop around each sample's
//    centre (at most 2 M points, radius 2); with LAS_PDAL set, PDAL's
//    radius outlier filter flags the same points (helpers/pdalOutlier.js)
//    on the crop thinned to 200 000 points, at the crop's own automatic
//    cell size as the radius (about 16 points a cell): PDAL returns every
//    neighbour of every point, so a dense crop at 2 m runs out of memory.
//    LAS_SPARSE_SAMPLE=<path> adds one more file to this check only (a
//    scan too big for every check above), as id "sparse1"
//  - (0.7.0) denoise on a 10 m × 10 m crop around each sample's centre
//    (at most 200 000 points; sparse1 too): selectOutliers, estimateNoise
//    (k 16, maxDistance 0.3), denoisePoints, then estimateNoise of the
//    result is lower (a crop too sparse to measure is left unmoved);
//    with LAS_PDAL set, PDAL's statistical outlier filter flags the same
//    points as selectOutliers
// Skipped, loudly, when there are no samples.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLas } from "../src/LasReader.js";
import { writeLas, createLasWriter } from "../src/write/writeLas.js";
import { findSamples } from "./helpers/samples.js";
import { fieldDigests, EVERY_FIELD } from "./helpers/fieldDigests.js";
import { selectSparse } from "../src/ops/sparse.js";
import { buildIndex } from "../src/index/grid.js";
import { keepPoints } from "../src/ops/apply.js";
import { thinSelection } from "../src/ops/select.js";
import { pdalRadiusOutlier, pdalStatisticalOutlier } from "./helpers/pdalOutlier.js";
import { selectOutliers } from "../src/ops/outliers.js";
import { estimateNoise } from "../src/ops/normals.js";
import { denoisePoints } from "../src/ops/denoise.js";

var samples = findSamples();

if (!samples.length) {
	test("real-file checks (no private samples in samples/ — skipped)", { skip: "add .las / .laz files to samples/ or list paths in samples/paths.txt" }, function () {});
}

function checksum(cols) {
	var s = 0;
	for (var i = 0; i < cols.count; i += Math.max(1, Math.floor(cols.count / 100000))) s += cols.x[i] * 1e-3 + cols.y[i] * 1e-6 + cols.z[i];
	return s;
}

samples.forEach(function (s) {
	test(s.id + " (" + (s.laz ? "LAZ " : "LAS ") + Math.round(s.size / 1048576) + " MB): count and bounds match the file's own header", { timeout: 900000 }, async function () {
		var las = await openLas(s.path);
		var h = las.header;
		var r = await las.readPoints({ fields: ["x", "y", "z"] });
		assert.equal(r.count, h.pointCount);
		var tol = Math.max(h.scale.x, h.scale.y, h.scale.z) * 1.0001 + 1e-9;
		["minX", "maxX", "minY", "maxY", "minZ", "maxZ"].forEach(function (k) {
			assert.ok(Math.abs(r.bounds[k] - h.bounds[k]) <= tol, s.id + " " + k + ": decoded " + r.bounds[k] + " vs header " + h.bounds[k]);
		});
		if (s.size < 200 * 1048576) {
			var small = await (await openLas(s.path, { windowSize: 1048576 })).readPoints({ fields: ["x", "y", "z"] });
			assert.equal(small.count, r.count);
			assert.equal(checksum(small), checksum(r));
			assert.equal(small.x[small.count - 1], r.x[r.count - 1]);
		}
		await las.close();
	});
});

async function headerOf(path) { var l = await openLas(path); var h = l.header; await l.close(); return h; }

var twins = [];
await Promise.all(samples.map(async function (s) { s.header = await headerOf(s.path); }));
samples.filter(function (s) { return s.laz; }).forEach(function (z) {
	samples.filter(function (s) { return !s.laz; }).forEach(function (l) {
		var a = z.header, b = l.header;
		if (a.pointCount === b.pointCount && a.pointFormat === b.pointFormat && JSON.stringify(a.bounds) === JSON.stringify(b.bounds)) twins.push([z, l]);
	});
});
twins.forEach(function (pair) {
	var z = pair[0], l = pair[1];
	test(z.id + " (LAZ) decodes to exactly the points of its twin " + l.id + " (LAS), every field", { timeout: 1800000 }, async function () {
		var a = await fieldDigests(z.path), b = await fieldDigests(l.path);
		assert.deepEqual(a, b);
	});
});

// Compress every sample and read it back (formats 4, 5, 9, 10 cannot be compressed and are skipped)
var BIG = 200 * 1048576;
samples.forEach(function (s) {
	var h = s.header, fmt = h.pointFormat;
	var skip = (fmt === 4 || fmt === 5 || fmt === 9 || fmt === 10) ? "point format " + fmt + " cannot be compressed" : false;
	var size = h.pointCount * h.recordLength;
	test(s.id + " (" + (s.laz ? "LAZ" : "LAS") + ", format " + fmt + ", " + Math.round(size / 1048576) + " MB of points) compresses to LAZ and reads back to the same points, every field" + (size > BIG ? " (streamed)" : ""), { skip: skip, timeout: 3600000 }, async function (t) {
		var dir = mkdtempSync(join(tmpdir(), "las-laz-write-"));
		try {
			var out = join(dir, "ours.laz");
			var opts = { compress: true, version: "1." + h.versionMinor, pointFormat: fmt, scale: h.scale, offset: h.offset };
			var started = Date.now();
			var src = await openLas(s.path);
			if (size > BIG) {
				// never two copies in memory: window by window from the reader to a file
				var file = await open(out, "w");
				try {
					var w = await createLasWriter(file, opts);
					for await (var c of src.chunks({ fields: EVERY_FIELD })) await w.writePoints(c);
					await w.close();
				} finally {
					await file.close();
				}
			} else {
				var all = await src.readPoints({ fields: EVERY_FIELD });
				writeFileSync(out, await writeLas(all, opts));
			}
			var took = Date.now() - started;
			await src.close();
			var ours = await openLas(out);
			assert.equal(ours.compressed, true);
			assert.equal(ours.header.pointCount, h.pointCount);
			assert.equal(ours.header.pointFormat, fmt);
			await ours.close();
			t.diagnostic(s.id + ": " + (s.size / 1048576).toFixed(1) + " MB -> " + (statSync(out).size / 1048576).toFixed(1) + " MB LAZ (" + (statSync(out).size / s.size).toFixed(3) + " of the original), compressed in " + took + " ms");
			assert.deepEqual(await fieldDigests(out), await fieldDigests(s.path));
			if (process.env.LAS_PDAL) {
				var back = join(dir, "pdal.las");
				execFileSync(process.env.LAS_PDAL, ["translate", out, back, "--writers.las.forward=all"], { stdio: "pipe" });
				assert.deepEqual(await fieldDigests(back), await fieldDigests(s.path));
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

if (process.env.LAS_PDAL) {
	samples.filter(function (s) { return s.laz; }).forEach(function (z) {
		test(z.id + " (LAZ) equals PDAL's own decompression of it, every field (LAS_PDAL)", { timeout: 3600000 }, async function () {
			var dir = mkdtempSync(join(tmpdir(), "las-pdal-"));
			try {
				var out = join(dir, "pdal.las");
				execFileSync(process.env.LAS_PDAL, ["translate", z.path, out, "--writers.las.forward=all", "--writers.las.extra_dims=all"], { stdio: "pipe" });
				assert.deepEqual(await fieldDigests(z.path), await fieldDigests(out));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
}

var sparseSamples = samples.slice();
if (process.env.LAS_SPARSE_SAMPLE) sparseSamples.push({ id: "sparse1", path: process.env.LAS_SPARSE_SAMPLE, size: statSync(process.env.LAS_SPARSE_SAMPLE).size, laz: /\.laz$/i.test(process.env.LAS_SPARSE_SAMPLE) });
sparseSamples.forEach(function (s) {
	test(s.id + ": selectSparse on a 20 m crop" + (process.env.LAS_PDAL ? ", against PDAL" : ""), { timeout: 900000 }, async function () {
		var las = await openLas(s.path), b = las.header.bounds;
		var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
		var crop = await las.readPoints({ fields: ["x", "y", "z"], polygon: [cx - 10, cy - 10, cx + 10, cy - 10, cx + 10, cy + 10, cx - 10, cy + 10], maxPoints: 2000000 });
		await las.close();
		var t = performance.now(), sel = selectSparse(crop, { radius: 2 }), ms = Math.round(performance.now() - t);
		console.log("# " + s.id + ": " + crop.count + " points in the crop, " + sel.length + " sparse at radius 2 (" + ms + " ms)");
		assert.ok(sel.length <= crop.count);
		if (!process.env.LAS_PDAL || crop.count === 0) return;
		// R = (k + 0.5) mm: R² is then a quarter of a mm² step from any squared distance at 1 mm scale
		var thin = keepPoints(crop, thinSelection(crop.count, 200000)), R = (Math.round(buildIndex(thin).cellSize * 1000) + 0.5) / 1000;
		var res = await pdalRadiusOutlier(process.env.LAS_PDAL, thin, R, 1);
		var ours = Array.from(selectSparse(res.cols, { radius: R - 1e-9 }));
		if (ours.length === res.cols.count) return;   // PDAL flags none then
		assert.deepEqual(ours, res.flagged, s.id + ": PDAL and selectSparse disagree");
	});
});

sparseSamples.forEach(function (s) {
	test(s.id + ": denoise on a 10 m crop" + (process.env.LAS_PDAL ? ", outliers against PDAL" : ""), { timeout: 900000 }, async function () {
		var las = await openLas(s.path), b = las.header.bounds;
		var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
		var crop = await las.readPoints({ fields: ["x", "y", "z"], polygon: [cx - 5, cy - 5, cx + 5, cy - 5, cx + 5, cy + 5, cx - 5, cy + 5], maxPoints: 200000 });
		await las.close();
		var t = performance.now(), out = selectOutliers(crop), tOut = Math.round(performance.now() - t);
		var o = { maxDistance: 0.3 }, before = estimateNoise(crop, o);
		t = performance.now();
		var smooth = denoisePoints(crop, o), tSmooth = Math.round(performance.now() - t), after = estimateNoise(smooth, o);
		console.log("# " + s.id + ": " + crop.count + " points in the crop, " + out.length + " outliers (" + tOut + " ms); noise " + (before * 100).toFixed(2) + " cm → " + (after * 100).toFixed(2) + " cm (denoise " + tSmooth + " ms)");
		if (before > 0) assert.ok(after < before, s.id + ": noise " + before + " → " + after);
		else assert.deepEqual(Array.from(smooth.z), Array.from(crop.z));
		if (!process.env.LAS_PDAL || crop.count < 20) return;
		var res = await pdalStatisticalOutlier(process.env.LAS_PDAL, crop, 8, 2);
		assert.deepEqual(Array.from(selectOutliers(res.cols)), res.flagged, s.id + ": PDAL and selectOutliers disagree");
	});
});
