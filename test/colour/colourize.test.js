// test/colour/colourize.test.js
//==========================================================
// colourize: RGB (16 -> 8 bit, with 8-bit files detected),
// intensity, elevation (Kirra's spectrum ramp) and class colours.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { colourize, RAMPS, CLASS_COLOURS } from "../../src/colour/colourize.js";

function rgbAt(c, i) { return [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]]; }

test("16-bit RGB: round(v / 256) — 65535 -> 255, 32768 -> 128 (Kirra's rule)", function () {
	var c = colourize({ count: 2, red: Uint16Array.from([65535, 32768]), green: Uint16Array.from([0, 256]), blue: Uint16Array.from([512, 65535]) }, { by: "rgb" });
	assert.deepEqual(rgbAt(c, 0), [255, 0, 2]);
	assert.deepEqual(rgbAt(c, 1), [128, 1, 255]);
});

test("8-bit colour stored in the 16-bit fields is used as-is, not darkened (new in the library)", function () {
	var c = colourize({ count: 2, red: Uint16Array.from([200, 255]), green: Uint16Array.from([100, 0]), blue: Uint16Array.from([50, 10]) }, { by: "rgb" });
	assert.deepEqual(rgbAt(c, 0), [200, 100, 50]);
	assert.deepEqual(rgbAt(c, 1), [255, 0, 10]);
});

test("elevation: Kirra's spectrum at min / quarter / half / three-quarter / max", function () {
	var c = colourize({ count: 5, z: Float64Array.from([0, 25, 50, 75, 100]) }, { by: "elevation" });
	assert.deepEqual(rgbAt(c, 0), [0, 0, 255]);
	assert.deepEqual(rgbAt(c, 1), [0, 255, 255]);
	assert.deepEqual(rgbAt(c, 2), [0, 255, 0]);
	assert.deepEqual(rgbAt(c, 3), [255, 255, 0]);
	assert.deepEqual(rgbAt(c, 4), [255, 0, 0]);
});

test("elevation with a range clamps outside values to the ends", function () {
	var c = colourize({ count: 2, z: Float64Array.from([-10, 500]) }, { by: "elevation", range: [0, 100] });
	assert.deepEqual(rgbAt(c, 0), [0, 0, 255]);
	assert.deepEqual(rgbAt(c, 1), [255, 0, 0]);
});

test("a flat elevation gets the ramp's middle, not NaN", function () {
	var c = colourize({ count: 2, z: Float64Array.from([5, 5]) }, { by: "elevation" });
	assert.deepEqual(rgbAt(c, 0), [0, 255, 0]);
});

test("intensity: greyscale over the given range", function () {
	var c = colourize({ count: 3, intensity: Uint16Array.from([0, 500, 1000]) }, { by: "intensity", range: [0, 1000] });
	assert.deepEqual(rgbAt(c, 0), [0, 0, 0]);
	assert.deepEqual(rgbAt(c, 1), [128, 128, 128]);
	assert.deepEqual(rgbAt(c, 2), [255, 255, 255]);
});

test("intensity without a range clips at the 2nd and 98th percentiles (one hot spike ignored)", function () {
	var vals = [];
	for (var i = 0; i < 100; i++) vals.push(i);
	vals[99] = 60000;
	var c = colourize({ count: 100, intensity: Uint16Array.from(vals) }, { by: "intensity" });
	assert.deepEqual(rgbAt(c, 99), [255, 255, 255]);
	assert.ok(c[98 * 3] >= 250, "the 98th value is near white, not dark grey");
});

test("classification: conventional viewer colours; unknown codes grey", function () {
	var c = colourize({ count: 3, classification: Uint8Array.from([2, 9, 99]) }, { by: "classification" });
	assert.deepEqual(rgbAt(c, 0), CLASS_COLOURS[2]);
	assert.deepEqual(rgbAt(c, 1), CLASS_COLOURS[9]);
	assert.deepEqual(rgbAt(c, 2), [128, 128, 128]);
	assert.deepEqual(CLASS_COLOURS[2], [165, 113, 78]);
});

test("ramps are exposed; a missing field or unknown mode is INVALID_ARGUMENT", function () {
	assert.ok(RAMPS.spectrum && RAMPS.greyscale);
	assert.throws(function () { colourize({ count: 1, x: Float64Array.from([1]) }, { by: "rgb" }); }, { code: "INVALID_ARGUMENT" });
	assert.throws(function () { colourize({ count: 1, z: Float64Array.from([1]) }, { by: "rainbow" }); }, { code: "INVALID_ARGUMENT" });
});
