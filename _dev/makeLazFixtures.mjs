// _dev/makeLazFixtures.mjs
//==========================================================
// Make test/fixtures/laz/*.laz with PDAL — an encoder independent of
// this library — from the seeded clouds in test/helpers/lazFixtureData.js.
// PDAL's OWN decompression of each file is the oracle: its records'
// SHA-256 goes in test/fixtures/laz/manifest.json. It also reports
// whether PDAL kept the records it was given (format 8 gains 2 pad bytes).
// Needs PDAL 2.x: set PDAL=<path to pdal.exe>, or it tries the QGIS
// install. Run: node _dev/makeLazFixtures.mjs
//==========================================================
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { LAZ_FIXTURES, fixtureLas } from "../test/helpers/lazFixtureData.js";

var PDAL = process.env.PDAL || ["C:/Program Files/QGIS 4.2.3/bin/pdal.exe", "pdal"].find(function (p) { return p === "pdal" || existsSync(p); });
var OUT = fileURLToPath(new URL("../test/fixtures/laz/", import.meta.url));
mkdirSync(OUT, { recursive: true });
var tmp = mkdtempSync(join(tmpdir(), "laz-fixtures-"));

function records(bytes) {
	var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var start = v.getUint32(96, true), len = v.getUint16(105, true);
	var n = bytes[25] >= 4 ? Number(v.getBigUint64(247, true)) : v.getUint32(107, true);
	return { len: len, n: n, bytes: bytes.subarray(start, start + n * len) };
}

var manifest = {};
try {
	LAZ_FIXTURES.forEach(function (fx) {
		var las = join(tmp, fx.name + ".las"), laz = join(OUT, fx.name + ".laz"), back = join(tmp, fx.name + "-back.las");
		var src = fixtureLas(fx);
		writeFileSync(las, src);
		execFileSync(PDAL, ["translate", las, laz, "--writers.las.compression=true", "--writers.las.forward=all", "--writers.las.extra_dims=all"], { stdio: "pipe" });
		execFileSync(PDAL, ["translate", laz, back, "--writers.las.forward=all", "--writers.las.extra_dims=all"], { stdio: "pipe" });
		var a = records(src), b = records(readFileSync(back));
		var same = a.len === b.len && a.n === b.n && Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)) === 0;
		console.log(fx.name, "format " + fx.pointFormat, a.n + " points", readFileSync(laz).length + " bytes", same ? "PDAL round trip: records identical" : "PDAL round trip: RECORDS DIFFER (len " + a.len + "/" + b.len + ", n " + a.n + "/" + b.n + ")");
		manifest[fx.name] = { pointFormat: fx.pointFormat, points: b.n, recordLength: b.len, sha256: createHash("sha256").update(b.bytes).digest("hex"), pdalKeptRecords: same };
	});
	var version = execFileSync(PDAL, ["--version"], { encoding: "utf8" }).match(/pdal \S+/)[0];
	writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ made: version, fixtures: manifest }, null, "\t") + "\n");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
