// test/laz/pdalWrite.test.js
//==========================================================
// PDAL as the reader of OUR LAZ (opt-in: LAS_PDAL=<path to pdal>;
// skipped, loudly, without it). For every committed fixture, the
// points are written with writeLas({ compress: true }) to a temporary
// .laz, and then
//  - `pdal info --metadata` accepts the file (exit 0)
//  - `pdal translate` to LAS gives records equal to ours, field by
//    field (a SHA-256 per field), and our own reading of our file gives
//    the fixture's points too
// The writer has no extra-bytes columns yet, so fixtures with extra
// bytes (f3x, f7x) are written without them; every other field still
// has to match. PDAL pads format 8's records (manifest pdalKeptRecords
// false) — the fields are compared, never the raw record bytes.
// Temporary files live in a temp directory and are removed.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLas } from "../../src/LasReader.js";
import { writeLas } from "../../src/write/writeLas.js";
import { LAZ_FIXTURES } from "../helpers/lazFixtureData.js";
import { fixtureBytes } from "../helpers/lazFixtureFiles.js";
import { fieldDigests, EVERY_FIELD } from "../helpers/fieldDigests.js";

var PDAL = process.env.LAS_PDAL;

if (!PDAL) {
	test("PDAL reads our LAZ (LAS_PDAL not set — skipped)", { skip: "set LAS_PDAL=<path to pdal> to run" }, function () {});
}

if (PDAL) {
	LAZ_FIXTURES.forEach(function (fx) {
		test(fx.name + " (format " + fx.pointFormat + ", " + fx.points + " points): PDAL reads our LAZ and finds our points", async function () {
			var dir = mkdtempSync(join(tmpdir(), "las-pdal-write-"));
			try {
				var original = fixtureBytes(fx.name);
				var las = await openLas(original, { threads: 1 });
				var h = las.header;
				var pts = await las.readPoints({ fields: EVERY_FIELD });
				await las.close();
				var ours = await writeLas(pts, { compress: true, version: "1." + h.versionMinor, pointFormat: h.pointFormat, scale: h.scale, offset: h.offset });
				var laz = join(dir, fx.name + ".laz"), back = join(dir, fx.name + ".las");
				writeFileSync(laz, ours);

				execFileSync(PDAL, ["info", "--metadata", laz], { stdio: "pipe" });     // throws on a non-zero exit
				execFileSync(PDAL, ["translate", laz, back, "--writers.las.forward=all"], { stdio: "pipe" });

				var theirs = await fieldDigests(back);
				assert.equal(theirs.count, fx.points);
				assert.deepEqual(theirs, await fieldDigests(ours));
				assert.deepEqual(await fieldDigests(ours), await fieldDigests(original));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
}
