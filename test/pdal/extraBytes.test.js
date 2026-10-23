// test/pdal/extraBytes.test.js
//==========================================================
// PDAL reads our extra bytes: a LAS 1.4 format 6 file (and its LAZ)
// with u8, scaled i16, u32, f32 and f64 fields, written by writeLas,
// translated by PDAL to text; PDAL's values equal the columns written.
// PDAL is an outside reader, so this checks the VLR and the records
// against another implementation. Skipped when PDAL is not installed
// (PDAL=<path to pdal>, else the QGIS 4.2.3 install).
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { writeLas } from "../../src/write/writeLas.js";

var PDAL = [process.env.PDAL, "C:/Program Files/QGIS 4.2.3/bin/pdal.exe"].find(function (p) { return p && existsSync(p); });

function cloud(n) {
	var c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), class2: new Uint8Array(n), height: new Float64Array(n), facet: new Uint32Array(n), width: new Float32Array(n), range: new Float64Array(n) };
	for (var i = 0; i < n; i++) {
		c.x[i] = 477000 + i * 0.25; c.y[i] = 6770000 + (i % 13) * 0.5; c.z[i] = 300 + i * 0.001;
		c.class2[i] = (i * 7) % 256; c.height[i] = Math.round((i * 0.37 - 40) * 100) / 100; c.facet[i] = i * 8191;
		c.width[i] = i / 7; c.range[i] = i * 1234.5678 + 0.000125;
	}
	return c;
}
var EXTRA = [{ name: "class2", type: "u8" }, { name: "height", type: "i16", scale: 0.01, offset: 5 }, { name: "facet", type: "u32" }, { name: "width", type: "f32" }, { name: "range", type: "f64" }];

function pdalRows(file, dir) {
	var csv = join(dir, "out.csv");
	execFileSync(PDAL, ["translate", file, csv, "--writers.text.order=X,Y,Z,class2,height,facet,width,range", "--writers.text.keep_unspecified=false", "--writers.text.precision=9"], { stdio: "pipe" });
	var lines = readFileSync(csv, "utf8").trim().split(/\r?\n/);
	return lines.slice(1).map(function (l) { return l.split(",").map(Number); });
}

test("PDAL reads the extra bytes we write, LAS and LAZ", { skip: PDAL ? false : "PDAL not found (set PDAL=<path to pdal>)" }, async function () {
	var c = cloud(500), dir = mkdtempSync(join(tmpdir(), "las-laz-js-pdal-"));
	try {
		for (var compress of [false, true]) {
			var file = join(dir, compress ? "eb.laz" : "eb.las");
			writeFileSync(file, await writeLas(c, { version: "1.4", pointFormat: 6, scale: { x: 0.001, y: 0.001, z: 0.001 }, offset: { x: 477000, y: 6770000, z: 0 }, extraBytes: EXTRA, compress: compress }));
			var rows = pdalRows(file, dir), label = compress ? "LAZ" : "LAS";
			assert.equal(rows.length, 500, label);
			rows.forEach(function (r, i) {
				assert.ok(Math.abs(r[0] - c.x[i]) < 1e-6, label + " x " + i);
				assert.equal(r[3], c.class2[i], label + " class2 " + i);
				assert.ok(Math.abs(r[4] - c.height[i]) <= 0.005 + 1e-9, label + " height " + i + ": " + r[4] + " vs " + c.height[i]);
				assert.equal(r[5], c.facet[i], label + " facet " + i);
				assert.ok(Math.abs(r[6] - c.width[i]) <= 1e-6 * Math.max(1, Math.abs(c.width[i])), label + " width " + i);
				assert.ok(Math.abs(r[7] - c.range[i]) <= 1e-6, label + " range " + i);
			});
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
