// test/format/LasCrs.test.js
//==========================================================
// The coordinate system from GeoKey (34735) or WKT (2112) records.
// Parsed only; the library never reprojects.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCrs } from "../../src/format/LasCrs.js";
import { geoKeyBytes } from "../helpers/buildLas.js";

function vlr(userId, recordId, bytes) { return { userId: userId, recordId: recordId, bytes: bytes }; }
function text(s) { return Uint8Array.from(s.split("").map(function (c) { return c.charCodeAt(0); }).concat([0])); }

test("ProjectedCSTypeGeoKey 3072 = 28350 gives EPSG 28350 (MGA94 zone 50)", function () {
	var crs = parseCrs([vlr("LASF_Projection", 34735, geoKeyBytes([[1024, 1], [3072, 28350]]))]);
	assert.equal(crs.kind, "geokeys");
	assert.equal(crs.epsg, 28350);
	assert.equal(crs.keys.length, 2);
	assert.deepEqual(crs.keys[1], { keyId: 3072, location: 0, count: 1, value: 28350 });
});

test("only a GeographicTypeGeoKey 2048 = 4326 gives EPSG 4326", function () {
	assert.equal(parseCrs([vlr("LASF_Projection", 34735, geoKeyBytes([[2048, 4326]]))]).epsg, 4326);
});

test("a user-defined code (32767) is not an EPSG", function () {
	assert.equal(parseCrs([vlr("LASF_Projection", 34735, geoKeyBytes([[3072, 32767]]))]).epsg, null);
});

test("WKT record gives the text; WKT wins over GeoKeys when both are present", function () {
	var w = "PROJCS[\"GDA94 / MGA zone 50\"]";
	var crs = parseCrs([vlr("LASF_Projection", 34735, geoKeyBytes([[3072, 28350]])), vlr("LASF_Projection", 2112, text(w))]);
	assert.equal(crs.kind, "wkt");
	assert.equal(crs.wkt, w);
	assert.equal(crs.epsg, 28350);
});

test("no projection records gives kind null", function () {
	assert.deepEqual(parseCrs([vlr("other", 1, Uint8Array.from([1]))]), { kind: null, epsg: null });
});
