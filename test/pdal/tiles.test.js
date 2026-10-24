// test/pdal/tiles.test.js
//==========================================================
// PDAL reads what a tile store writes: an edited store written as
// LAS and LAZ, PDAL's point count and bounds equal ours. Skipped when
// PDAL is not installed (PDAL=<path to pdal>, else the QGIS 4.2.3
// install).
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { openLas } from "../../src/LasReader.js";
import { buildTiles } from "../../src/tiles/build.js";
import { tileLas } from "../helpers/tileFiles.js";
import { memorySink } from "../helpers/sinks.js";

var PDAL = [process.env.PDAL, "C:/Program Files/QGIS 4.2.3/bin/pdal.exe"].find(function (p) { return p && existsSync(p); });

test("PDAL reads a written tile store, LAS and LAZ", { skip: PDAL ? false : "PDAL not found (set PDAL=<path to pdal>)", timeout: 120000 }, async function () {
	var dir = mkdtempSync(join(tmpdir(), "las-laz-js-pdal-tiles-"));
	try {
		var store = await buildTiles(await openLas(tileLas({ pointFormat: 7, n: 9000, seed: 91 })), { where: { memory: true }, tilePoints: 600 });
		await store.deletePoints(await store.selectBox({ minX: 478000, maxX: 478060 }));
		await store.addColumn("facet", "u16", 4);
		for (var compress of [false, true]) {
			var sink = memorySink(), file = join(dir, compress ? "t.laz" : "t.las");
			await store.writeLas(sink, { compress: compress });
			writeFileSync(file, sink.bytes());
			var info = JSON.parse(execFileSync(PDAL, ["info", "--summary", file], { encoding: "utf8" })).summary;
			var ours = (await openLas(sink.bytes())).header;
			assert.equal(info.num_points, ours.pointCount, compress ? "LAZ" : "LAS");
			assert.equal(info.num_points, store.count);
			var b = info.bounds;
			assert.ok(Math.abs(b.minx - ours.bounds.minX) < 1e-6 && Math.abs(b.maxx - ours.bounds.maxX) < 1e-6 && Math.abs(b.miny - ours.bounds.minY) < 1e-6 && Math.abs(b.maxz - ours.bounds.maxZ) < 1e-6);
			assert.ok(info.dimensions.indexOf("facet") >= 0, "PDAL sees the added column: " + info.dimensions);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
