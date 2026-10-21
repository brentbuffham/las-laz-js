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
// Skipped, loudly, when there are no samples.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openLas } from "../src/LasReader.js";
import { findSamples } from "./helpers/samples.js";

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

// One SHA-256 per field over every point, streamed window by window
async function fieldDigests(path, fields) {
	var las = await openLas(path);
	var hashes = {};
	fields.forEach(function (f) { hashes[f] = createHash("sha256"); });
	var n = 0;
	for await (var c of las.chunks({ fields: fields })) {
		fields.forEach(function (f) { hashes[f].update(new Uint8Array(c[f].buffer, c[f].byteOffset, c[f].byteLength)); });
		n += c.count;
	}
	await las.close();
	var out = { count: n };
	fields.forEach(function (f) { out[f] = hashes[f].digest("hex"); });
	return out;
}

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
		var fields = ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "classification", "scanAngle", "userData", "pointSourceId"];
		if (z.header.pointFormat === 1 || z.header.pointFormat >= 3) fields.push("gpsTime");
		if ([2, 3, 5, 7, 8, 10].indexOf(z.header.pointFormat) >= 0) fields.push("red", "green", "blue");
		var a = await fieldDigests(z.path, fields), b = await fieldDigests(l.path, fields);
		assert.deepEqual(a, b);
	});
});
