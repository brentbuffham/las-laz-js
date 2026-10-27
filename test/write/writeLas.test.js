// test/write/writeLas.test.js
//==========================================================
// writeLas / createLasWriter: round trips through openLas for every
// point format, the version / format rules, the CRS record, header
// totals, and the streaming writer matching the one-shot writer.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeLas, createLasWriter } from "../../src/write/writeLas.js";
import { chooseScaleOffset } from "../../src/write/scaleOffset.js";
import { openLas } from "../../src/LasReader.js";
import { parseHeader } from "../../src/format/LasHeader.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { openScratchSyncWriter, openScratchReader } from "../../src/io/ScratchBinaryFile.js";
import { createFakeRoot } from "../helpers/fakeOpfs.js";
import { open } from "node:fs/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

var ALL = ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scannerChannel", "scanAngle", "userData", "pointSourceId", "gpsTime", "red", "green", "blue", "nir"];

function columns(n) {
	var c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), intensity: new Uint16Array(n), returnNumber: new Uint8Array(n), numberOfReturns: new Uint8Array(n), scanDirection: new Uint8Array(n), edgeOfFlightLine: new Uint8Array(n), classification: new Uint8Array(n), classificationFlags: new Uint8Array(n), scannerChannel: new Uint8Array(n), scanAngle: new Float32Array(n), userData: new Uint8Array(n), pointSourceId: new Uint16Array(n), gpsTime: new Float64Array(n), red: new Uint16Array(n), green: new Uint16Array(n), blue: new Uint16Array(n), nir: new Uint16Array(n) };
	for (var i = 0; i < n; i++) {
		c.x[i] = 477000.123 + i; c.y[i] = 6770000.456 + 2 * i; c.z[i] = 300.5 - i;
		c.intensity[i] = 100 * i; c.returnNumber[i] = 1 + (i % 3); c.numberOfReturns[i] = 3;
		c.scanDirection[i] = i % 2; c.edgeOfFlightLine[i] = (i + 1) % 2;
		c.classification[i] = 2 + (i % 4); c.classificationFlags[i] = i % 4; c.scannerChannel[i] = i % 3;
		c.scanAngle[i] = i % 2 ? -12 : 15; c.userData[i] = i; c.pointSourceId[i] = 1000 + i;
		c.gpsTime[i] = 123456.5 + i; c.red[i] = 1000 * i; c.green[i] = 2000 * i; c.blue[i] = 3000 * i; c.nir[i] = 4000 * i;
	}
	return c;
}

var SCALE = { x: 0.001, y: 0.001, z: 0.001 };
var FORMAT_FIELDS = {
	legacy: ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "userData", "pointSourceId"],
	time: ["gpsTime"], rgb: ["red", "green", "blue"], nir: ["nir"], ext: ["scannerChannel"]
};
function fieldsOf(fmt) {
	var f = FORMAT_FIELDS.legacy.slice();
	if ([1, 3, 4, 5, 6, 7, 8, 9, 10].indexOf(fmt) >= 0) f = f.concat(FORMAT_FIELDS.time);
	if ([2, 3, 5, 7, 8, 10].indexOf(fmt) >= 0) f = f.concat(FORMAT_FIELDS.rgb);
	if ([8, 10].indexOf(fmt) >= 0) f = f.concat(FORMAT_FIELDS.nir);
	if (fmt >= 6) f = f.concat(FORMAT_FIELDS.ext);
	return f;
}

test("round trip for every format (1.4: 0-10, 1.2: 0-3, 1.3: 4-5): each field back within one scale step", async function () {
	var src = columns(9);
	var cases = [];
	for (var f = 0; f <= 10; f++) cases.push(["1.4", f]);
	[0, 1, 2, 3].forEach(function (f) { cases.push(["1.2", f]); });
	[4, 5].forEach(function (f) { cases.push(["1.3", f]); });
	for (var c of cases) {
		var bytes = await writeLas(src, { version: c[0], pointFormat: c[1], scale: SCALE, offset: { x: 477000, y: 6770000, z: 0 } });
		var back = await (await openLas(bytes)).readPoints({ fields: ALL });
		assert.equal(back.count, 9, c.join(" "));
		fieldsOf(c[1]).forEach(function (name) {
			for (var i = 0; i < 9; i++) {
				var tol = (name === "x" || name === "y" || name === "z") ? 0.0005 : (name === "scanAngle" ? 0.006 : 0);
				assert.ok(Math.abs(back[name][i] - src[name][i]) <= tol, c.join(" ") + " " + name + "[" + i + "]: " + back[name][i] + " vs " + src[name][i]);
			}
		});
		// 1.4 scan angle keeps degrees to 0.006; legacy rounds to whole degrees
		assert.ok(Math.abs(back.scanAngle[0] - 15) < 0.01);
	}
});

test("version / format rules: 6-10 need 1.4, 4-5 need 1.3+; never silently changed (Kirra downgraded)", async function () {
	var src = columns(2);
	await assert.rejects(writeLas(src, { version: "1.2", pointFormat: 6 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(writeLas(src, { version: "1.2", pointFormat: 4 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(writeLas(src, { version: "1.4", pointFormat: 11 }), { code: "INVALID_ARGUMENT" });
	await assert.rejects(writeLas({ count: 1, y: new Float64Array(1) }, {}), { code: "INVALID_ARGUMENT" });
});

test("default format: 3 with colour, else 0; default version 1.2", async function () {
	var withColour = parseHeader(new MemorySource(await writeLas(columns(2))));
	assert.equal(withColour.pointFormat, 3);
	assert.equal(withColour.versionMinor, 2);
	var plain = columns(2); delete plain.red; delete plain.green; delete plain.blue;
	assert.equal(parseHeader(new MemorySource(await writeLas(plain))).pointFormat, 0);
});

test("EPSG 28350 writes a GeoKey record that reads back as 28350; WKT writes record 2112 and the WKT bit", async function () {
	var las = await openLas(await writeLas(columns(2), { crs: { epsg: 28350 } }));
	assert.equal(las.crs.epsg, 28350);
	assert.equal(las.crs.kind, "geokeys");
	var wkt = "PROJCS[\"GDA94 / MGA zone 50\"]";
	var las2 = await openLas(await writeLas(columns(2), { version: "1.4", pointFormat: 6, crs: { wkt: wkt } }));
	assert.equal(las2.crs.wkt, wkt);
	assert.equal(las2.header.globalEncoding & 16, 16);
});

test("header totals: bounds and per-return counts by hand; software string", async function () {
	var h = parseHeader(new MemorySource(await writeLas(columns(6), { scale: SCALE, offset: { x: 477000, y: 6770000, z: 0 }, software: "Kirra" })));
	assert.equal(h.pointCount, 6);
	assert.ok(Math.abs(h.bounds.minX - 477000.123) < 1e-9);
	assert.ok(Math.abs(h.bounds.maxX - 477005.123) < 1e-9);
	assert.ok(Math.abs(h.bounds.maxY - 6770010.456) < 1e-9);
	assert.ok(Math.abs(h.bounds.minZ - 295.5) < 1e-9);
	assert.deepEqual(h.pointsByReturn.slice(0, 3), [2, 2, 2]); // returns 1,2,3 repeating over 6 points
	assert.equal(h.software, "Kirra");
});

test("localOrigin on write adds the origin back to every coordinate", async function () {
	var c = { count: 1, x: Float32Array.from([5.25]), y: Float32Array.from([10.5]), z: Float32Array.from([1]) };
	var back = await (await openLas(await writeLas(c, { localOrigin: { x: 477000, y: 6770000 } }))).readPoints({ fields: ["x", "y"] });
	assert.ok(Math.abs(back.x[0] - 477005.25) < 0.0005);
	assert.ok(Math.abs(back.y[0] - 6770010.5) < 0.0005);
});

test("chooseScaleOffset: the centre snapped to 100 m at 0.001; 0.001 scale, coarsened past the int32 range (Kirra's rule)", function () {
	var so = chooseScaleOffset({ minX: 0, maxX: 1000, minY: 0, maxY: 500, minZ: 0, maxZ: 100 });
	assert.deepEqual(so.offset, { x: 500, y: 300, z: 100 });   // centres 500, 250, 50 to multiples of 100 m
	assert.deepEqual(so.scale, { x: 0.001, y: 0.001, z: 0.001 });
	assert.equal(chooseScaleOffset({ minX: 0, maxX: 5e6, minY: 0, maxY: 1, minZ: 0, maxZ: 1 }).scale.x, 0.01);
});

test("the streaming writer of 3 batches equals writeLas of all points, byte for byte", async function () {
	var all = columns(12);
	var opts = { version: "1.4", pointFormat: 7, scale: SCALE, offset: { x: 477000, y: 6770000, z: 0 }, crs: { wkt: "PROJCS[\"GDA94 / MGA zone 50\"]" }, date: new Date(Date.UTC(2026, 9, 21)) };
	var oneShot = await writeLas(all, opts);
	var buf = new Uint8Array(oneShot.length + 100);
	var maxEnd = 0;
	var sink = { write: function (bytes, position) { buf.set(bytes, position); maxEnd = Math.max(maxEnd, position + bytes.length); } };
	var w = await createLasWriter(sink, opts);
	function batch(a, b) {
		var c = { count: b - a };
		Object.keys(all).forEach(function (k) { if (k !== "count") c[k] = all[k].slice(a, b); });
		return c;
	}
	await w.writePoints(batch(0, 5)); await w.writePoints(batch(5, 9)); await w.writePoints(batch(9, 12));
	await w.close();
	assert.equal(maxEnd, oneShot.length);
	assert.deepEqual(Array.from(buf.subarray(0, maxEnd)), Array.from(oneShot));
});

test("the streaming writer needs a scale and offset up front", async function () {
	await assert.rejects(createLasWriter({ write: function () {} }, {}), { code: "INVALID_ARGUMENT" });
});

test("as: \"blob\" returns a Blob", async function () {
	var b = await writeLas(columns(2), { as: "blob" });
	assert.ok(b instanceof Blob);
	assert.equal((await openLas(b)).header.pointCount, 2);
});

function batches(all, cuts) {
	var out = [];
	for (var i = 0; i + 1 < cuts.length; i++) {
		var c = { count: cuts[i + 1] - cuts[i] };
		Object.keys(all).forEach(function (k) { if (k !== "count") c[k] = all[k].slice(cuts[i], cuts[i + 1]); });
		out.push(c);
	}
	return out;
}
var STREAM_OPTS = { version: "1.4", pointFormat: 7, scale: SCALE, offset: { x: 477000, y: 6770000, z: 0 }, date: new Date(Date.UTC(2026, 9, 21)) };

test("the streaming writer writes to an OPFS scratch writer (writeAt), byte for byte", async function () {
	var all = columns(12);
	var oneShot = await writeLas(all, STREAM_OPTS);
	var root = createFakeRoot();
	var sink = await openScratchSyncWriter("stream.las", { root: root });
	var w = await createLasWriter(sink, STREAM_OPTS);
	for (var b of batches(all, [0, 5, 12])) await w.writePoints(b);
	await w.close();
	sink.close();
	var r = await openScratchReader("stream.las", { root: root });
	var got = r.slice(0, r.length());
	r.close();
	assert.deepEqual(Array.from(got), Array.from(oneShot));
});

test("the streaming writer writes to a Node FileHandle, byte for byte", async function () {
	var all = columns(12);
	var oneShot = await writeLas(all, STREAM_OPTS);
	var path = join(mkdtempSync(join(tmpdir(), "las-w-")), "stream.las");
	var handle = await open(path, "w");
	var w = await createLasWriter(handle, STREAM_OPTS);
	for (var b of batches(all, [0, 5, 12])) await w.writePoints(b);
	await w.close();
	await handle.close();
	assert.deepEqual(Array.from(readFileSync(path)), Array.from(oneShot));
});

test("writePoints calls made without waiting each get their own place in the file", async function () {
	var all = columns(12);
	var oneShot = await writeLas(all, STREAM_OPTS);
	var buf = new Uint8Array(oneShot.length);
	var sink = { write: function (bytes, position) { return new Promise(function (res) { setTimeout(function () { buf.set(bytes, position); res(); }, 5); }); } };
	var w = await createLasWriter(sink, STREAM_OPTS);
	await Promise.all(batches(all, [0, 4, 8, 12]).map(function (b) { return w.writePoints(b); }));
	await w.close();
	assert.deepEqual(Array.from(buf), Array.from(oneShot));
});

test("a sink that cannot write is INVALID_ARGUMENT; a file handle that stops writing is TRUNCATED", async function () {
	await assert.rejects(createLasWriter({}, STREAM_OPTS), { code: "INVALID_ARGUMENT" });
	var stuck = { fd: 3, write: async function () { return { bytesWritten: 0 }; } };
	await assert.rejects(createLasWriter(stuck, STREAM_OPTS), { code: "TRUNCATED" });
});

// LAS 1.4 R15: point formats 6-10 must carry their CRS as OGC WKT (GeoTIFF keys are for 0-5)
test("formats 6-10 refuse an EPSG-only CRS, and write WKT without GeoKeys", async function () {
	await assert.rejects(writeLas(columns(2), { version: "1.4", pointFormat: 6, crs: { epsg: 28350 } }), { code: "INVALID_ARGUMENT" });
	var wkt = "PROJCS[\"GDA94 / MGA zone 50\"]";
	var bytes = await writeLas(columns(2), { version: "1.4", pointFormat: 6, crs: { epsg: 28350, wkt: wkt } });
	var las = await openLas(bytes);
	assert.deepEqual(las.vlrs.map(function (v) { return v.recordId; }), [2112]);
	assert.equal(las.crs.wkt, wkt);
	assert.equal(las.header.globalEncoding & 16, 16);   // the WKT bit
	var legacy = await openLas(await writeLas(columns(2), { version: "1.2", pointFormat: 3, crs: { epsg: 28350 } }));
	assert.equal(legacy.crs.epsg, 28350);                // formats 0-5 keep GeoKeys
});

// Classes above 31 in point formats 0-5 (5 bits): refused, never masked
function classCloud(n, at, cls) {
	var c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), classification: new Uint8Array(n), returnNumber: new Uint8Array(n).fill(1), numberOfReturns: new Uint8Array(n).fill(1) };
	for (var i = 0; i < n; i++) { c.x[i] = 477000 + i; c.y[i] = 6770000 + i; c.classification[i] = 2; }
	if (at >= 0) c.classification[at] = cls;
	return c;
}

test("a class above 31 is refused in formats 0-5", async function () {
	for (var fmt of [0, 1, 2, 3]) {
		await assert.rejects(writeLas(classCloud(10, 4, 32), { pointFormat: fmt }),
			{ message: "point 4 has class 32; point formats 0-5 hold classes 0-31 — write point format 6 or higher" });
	}
	await assert.rejects(writeLas(classCloud(10, 4, 32), { pointFormat: 1, compress: true }), /point 4 has class 32/);
});

test("classes 0-31 still write in formats 0-5, 0-255 in 6+", async function () {
	var a = await openLas(await writeLas(classCloud(10, 3, 31), { pointFormat: 3 }));
	assert.equal((await a.readPoints({ fields: ["classification"] })).classification[3], 31);
	var b = await openLas(await writeLas(classCloud(10, 3, 255), { version: "1.4", pointFormat: 6 }));
	assert.equal((await b.readPoints({ fields: ["classification"] })).classification[3], 255);
});

// As the int32 overflow message (writeLaz.test.js): the point's index in the caller's points, the batch passed
test("the streaming writers name the point's index in the caller's batch", async function () {
	var all = classCloud(300, 250, 40), wrote = 0;
	var sink = { write: function (bytes) { wrote += bytes.length; } };
	var w = await createLasWriter(sink, { pointFormat: 1, scale: SCALE, offset: { x: 477000, y: 6770000, z: 0 } });
	var parts = batches(all, [0, 100, 200, 300]);
	await w.writePoints(parts[0]);
	await w.writePoints(parts[1]);
	var afterTwo = wrote;
	await assert.rejects(w.writePoints(parts[2]), { message: /^point 50 has class 40/ });
	assert.equal(wrote, afterTwo);
	assert.ok(afterTwo >= 200 * 28);
	for (var threads of [1, 2]) {
		var z = await createLasWriter({ write: function () {} }, { pointFormat: 1, compress: true, chunkSize: 100, threads: threads, scale: SCALE, offset: { x: 477000, y: 6770000, z: 0 } });
		await z.writePoints(parts[0]);
		await z.writePoints(parts[1]);
		await assert.rejects(z.writePoints(parts[2]), { message: /^point 50 has class 40/ }, "LAZ, threads " + threads);
	}
});

test("a refused batch leaves the streaming LAS writer's totals as they were", async function () {
	var file = new Uint8Array(1 << 16), sink = { write: function (bytes, pos) { file.set(bytes, pos); } };
	var w = await createLasWriter(sink, { pointFormat: 1, scale: SCALE, offset: { x: 477000, y: 6770000, z: 0 } });
	await w.writePoints(classCloud(100, -1, 0));
	var bad = classCloud(100, 90, 40);
	for (var i = 0; i < 100; i++) bad.x[i] += 5000;   // 5 km east: would widen the bounds
	await assert.rejects(w.writePoints(bad), /has class 40/);
	await w.close();
	var h = parseHeader(new MemorySource(file));
	assert.equal(h.pointCount, 100);
	assert.equal(h.pointsByReturn.reduce(function (s, v) { return s + v; }, 0), 100);
	assert.ok(h.bounds.maxX < 477100, "maxX " + h.bounds.maxX);
});

test("point formats 6-10 set the WKT bit with or without a CRS (LAS 1.4 R15); formats 0-5 without one do not", async function () {
	var c = { count: 3, x: new Float64Array([1, 2, 3]), y: new Float64Array([1, 2, 3]), z: new Float64Array([0, 0, 0]) };
	for (var fmt of [6, 7, 8]) {
		var las = await openLas(await writeLas(c, { version: "1.4", pointFormat: fmt }));
		assert.equal(las.header.globalEncoding & 16, 16, "format " + fmt);
	}
	var old = await openLas(await writeLas(c, { version: "1.4", pointFormat: 1 }));
	assert.equal(old.header.globalEncoding & 16, 0);
	var laz = await openLas(await writeLas(c, { version: "1.4", pointFormat: 6, compress: true }));
	assert.equal(laz.header.globalEncoding & 16, 16, "LAZ too");
});

test("the offset is a round number: a multiple of 100,000 x the scale, every point still within an int32", function () {
	var b = { minX: 478123.4567, maxX: 478987.1234, minY: 6771234.5678, maxY: 6772001.0001, minZ: 212.3456, maxZ: 287.6543 };
	var so = chooseScaleOffset(b);
	assert.equal(so.scale.x, 0.001);
	assert.deepEqual([so.offset.x, so.offset.y, so.offset.z], [478600, 6771600, 200]);
	["x", "y", "z"].forEach(function (a) {
		var lo = (b["min" + a.toUpperCase()] - so.offset[a]) / so.scale[a], hi = (b["max" + a.toUpperCase()] - so.offset[a]) / so.scale[a];
		assert.ok(lo > -2147483648 && hi < 2147483647, a);
	});
	// a range at the int32 limit still fits after the snap
	var wide = chooseScaleOffset({ minX: 0, maxX: 1.99e6, minY: 0, maxY: 1, minZ: 0, maxZ: 1 });
	assert.ok((1.99e6 - wide.offset.x) / wide.scale.x < 2147483647 && (0 - wide.offset.x) / wide.scale.x > -2147483648);
});
