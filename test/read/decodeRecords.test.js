// test/read/decodeRecords.test.js
//==========================================================
// decodeRecords: raw point records -> typed-array columns, for
// every point format, from files built from the ASPRS tables.
// Every expected value is the value put into the builder.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRecords, DEFAULT_FIELDS } from "../../src/read/decodeRecords.js";
import { parseHeader } from "../../src/format/LasHeader.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { buildLas } from "../helpers/buildLas.js";

var P = {
	x: 477005.25, y: 6770010.5, z: 312.125, intensity: 1234,
	returnNumber: 2, numberOfReturns: 3, scanDirection: 1, edgeOfFlightLine: 1,
	classification: 2, classificationFlags: 5, scannerChannel: 2,
	userData: 7, pointSourceId: 4321, gpsTime: 123456.789,
	red: 65535, green: 32768, blue: 256, nir: 999
};

function decode(fmt, version, fields, extra) {
	var b = buildLas({ version: version, pointFormat: fmt, scale: { x: 0.001, y: 0.001, z: 0.001 }, offset: { x: 477000, y: 6770000, z: 0 },
		points: [Object.assign({}, P, { scanAngle: fmt >= 6 ? 15 : -12 }), { x: 477000, y: 6770000, z: 0 }] });
	var h = parseHeader(new MemorySource(b));
	var bytes = b.subarray(h.offsetToPointData, h.offsetToPointData + h.pointCount * h.recordLength);
	return decodeRecords(bytes, h, Object.assign({ fields: fields }, extra || {}));
}

var ALL = ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scannerChannel", "scanAngle", "userData", "pointSourceId", "gpsTime", "red", "green", "blue", "nir"];

test("coordinates are int * scale + offset, exact for every format", function () {
	for (var fmt = 0; fmt <= 10; fmt++) {
		var c = decode(fmt, fmt >= 6 ? "1.4" : "1.2", ["x", "y", "z"]);
		assert.equal(c.count, 2);
		assert.ok(c.x instanceof Float64Array);
		assert.equal(c.x[0], 477005.25, "format " + fmt);
		assert.equal(c.y[0], 6770010.5);
		assert.equal(c.z[0], 312.125);
		assert.equal(c.x[1], 477000);
	}
});

test("legacy formats (0-5): 3-bit returns, 5-bit class, 3 flag bits, scan angle rank in degrees", function () {
	var c = decode(3, "1.2", ALL);
	assert.equal(c.intensity[0], 1234);
	assert.equal(c.returnNumber[0], 2);
	assert.equal(c.numberOfReturns[0], 3);
	assert.equal(c.scanDirection[0], 1);
	assert.equal(c.edgeOfFlightLine[0], 1);
	assert.equal(c.classification[0], 2);
	assert.equal(c.classificationFlags[0], 5);
	assert.equal(c.scanAngle[0], -12);
	assert.equal(c.userData[0], 7);
	assert.equal(c.pointSourceId[0], 4321);
	assert.equal(c.gpsTime[0], 123456.789);
	assert.deepEqual([c.red[0], c.green[0], c.blue[0]], [65535, 32768, 256]);
	assert.equal(c.nir, undefined);          // not in format 3
	assert.equal(c.scannerChannel, undefined);
});

test("extended formats (6-10): 4-bit returns, 8-bit class, 4 flag bits, channel, scan angle x 0.006", function () {
	var c = decode(8, "1.4", ALL);
	assert.equal(c.returnNumber[0], 2);
	assert.equal(c.numberOfReturns[0], 3);
	assert.equal(c.classification[0], 2);
	assert.equal(c.classificationFlags[0], 5);
	assert.equal(c.scannerChannel[0], 2);
	assert.equal(c.scanDirection[0], 1);
	assert.equal(c.edgeOfFlightLine[0], 1);
	assert.ok(Math.abs(c.scanAngle[0] - 15) < 1e-4); // raw 2500 * 0.006
	assert.equal(c.gpsTime[0], 123456.789);
	assert.equal(c.nir[0], 999);
	assert.deepEqual([c.red[0], c.green[0], c.blue[0]], [65535, 32768, 256]);
});

test("formats without a field leave it out; format 0 has no time or colour", function () {
	var c = decode(0, "1.2", ALL);
	assert.equal(c.gpsTime, undefined);
	assert.equal(c.red, undefined);
	assert.equal(c.intensity[0], 1234);
});

test("waveform formats decode their point fields (4: time, 5: time + colour, 9 / 10)", function () {
	assert.equal(decode(4, "1.3", ["gpsTime"]).gpsTime[0], 123456.789);
	assert.equal(decode(5, "1.3", ["red"]).red[0], 65535);
	assert.equal(decode(9, "1.4", ["gpsTime"]).gpsTime[0], 123456.789);
	assert.equal(decode(10, "1.4", ["nir"]).nir[0], 999);
});

test("default fields: x y z intensity returns class, plus colour when the format has it", function () {
	assert.deepEqual(DEFAULT_FIELDS, ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "classification"]);
	var c = decode(2, "1.2");
	assert.ok(c.red && c.green && c.blue);
	assert.equal(c.gpsTime, undefined);
	assert.equal(decode(1, "1.2").red, undefined);
});

test("localOrigin + float32 stores small Float32 coordinates (no UTM jitter)", function () {
	var c = decode(0, "1.2", ["x", "y", "z"], { localOrigin: { x: 477000, y: 6770000 }, float32: true });
	assert.ok(c.x instanceof Float32Array);
	assert.equal(c.x[0], 5.25);
	assert.equal(c.y[0], 10.5);
	assert.equal(c.z[0], 312.125); // no z origin given: z unchanged
});

test("keep(view, offset) drops records before they are decoded", function () {
	var c = decode(0, "1.2", ["x"], { keep: function (view, at) { return (view.getUint8(at + 15) & 31) === 2; } }); // class byte = class + flags * 32
	assert.equal(c.count, 1);
	assert.equal(c.x[0], 477005.25);
});

test("an unknown field name is INVALID_ARGUMENT", function () {
	assert.throws(function () { decode(0, "1.2", ["x", "colour"]); }, { code: "INVALID_ARGUMENT" });
});

test("stride keeps every n-th record counted from the file start (firstIndex)", function () {
	assert.equal(decode(0, "1.2", ["x"], { stride: 2 }).count, 1);
	var odd = decode(0, "1.2", ["x"], { stride: 2, firstIndex: 1 });
	assert.equal(odd.count, 1);
	assert.equal(odd.x[0], 477000); // record 1 of the window = file record 2
});
