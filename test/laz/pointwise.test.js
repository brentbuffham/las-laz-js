// test/laz/pointwise.test.js
//==========================================================
// LAZ point formats 0-3 (point-wise chunked, item version 2) against
// an independent encoder. The fixtures were compressed by PDAL from
// the seeded clouds in helpers/lazFixtureData.js; the oracle is PDAL's
// OWN decompression of each (the SHA-256 of its records, in
// fixtures/laz/manifest.json), and — field by field — the values the
// builder put in. Made by _dev/makeLazFixtures.mjs.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeRecords } from "../../src/read/decodeRecords.js";
import { LAZ_FIXTURES, fixturePoints } from "../helpers/lazFixtureData.js";
import { LAZ_MANIFEST, fixtureBytes, decompressAll } from "../helpers/lazFixtureFiles.js";

// int * 0.001 + offset is the builder's decimal to within float noise; half a scale step is the honest bound
function near(a, b, what) { assert.ok(Math.abs(a - b) < 0.0005, what + ": " + a + " vs " + b); }

var MANIFEST = LAZ_MANIFEST;

LAZ_FIXTURES.forEach(function (fx) {
	test(fx.name + " (format " + fx.pointFormat + (fx.extra ? " + " + fx.extra + " extra bytes" : "") + ", " + fx.points + " points): records equal PDAL's decompression", async function () {
		var r = await decompressAll(fixtureBytes(fx.name));
		var m = MANIFEST[fx.name];
		assert.equal(r.header.pointCount, m.points);
		assert.equal(r.header.recordLength, m.recordLength);
		assert.equal(r.chunks.length, Math.ceil(fx.points / 50000));
		assert.equal(createHash("sha256").update(r.records).digest("hex"), m.sha256);
	});

	test(fx.name + ": decoded fields are the values the builder put in", async function () {
		var r = await decompressAll(fixtureBytes(fx.name));
		var cols = decodeRecords(r.records, r.header, {});
		var pts = fixturePoints(fx);
		[0, 1, 4999, fx.points - 1].forEach(function (i) {
			var p = pts[i];
			near(cols.x[i], p.x, "x " + i); near(cols.y[i], p.y, "y " + i); near(cols.z[i], p.z, "z " + i);
			assert.equal(cols.intensity[i], p.intensity, "intensity " + i);
			assert.equal(cols.returnNumber[i], p.returnNumber); assert.equal(cols.numberOfReturns[i], p.numberOfReturns);
			assert.equal(cols.classification[i], p.classification, "class " + i);
			if (cols.gpsTime) assert.equal(cols.gpsTime[i], p.gpsTime, "gps " + i);
			if (cols.red) { assert.equal(cols.red[i], p.red); assert.equal(cols.green[i], p.green); assert.equal(cols.blue[i], p.blue, "blue " + i); }
		});
	});
});
