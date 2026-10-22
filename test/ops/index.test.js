// test/ops/index.test.js
//==========================================================
// The index column: each kept point's record number in the file,
// after every filter and maxPoints, through readPoints, chunks
// (windows) and LAZ decode workers; and it rides through the
// operations like any other column.
// Oracle: a full read of the same file (point j of a filtered read
// is point index[j] of the full read), and a built LAS whose x
// encodes the record number.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas } from "../../src/LasReader.js";
import { columnType, FIELD_TYPES, DEFAULT_FIELDS } from "../../src/read/decodeRecords.js";
import { keepPoints, removePoints, mergePoints, splitPoints } from "../../src/index.js";
import { selectClasses } from "../../src/ops/select.js";
import { buildLas } from "../helpers/buildLas.js";
import { LAZ_MANIFEST, fixtureBytes } from "../helpers/lazFixtureFiles.js";

var BASE = ["x", "y", "z", "classification"];

// An L over the header bounds, arms 0.3 of the width / height
function lShape(b, arm) {
	var w = b.maxX - b.minX, h = b.maxY - b.minY;
	return [b.minX, b.minY, b.maxX, b.minY, b.maxX, b.minY + arm * h, b.minX + arm * w, b.minY + arm * h, b.minX + arm * w, b.maxY, b.minX, b.maxY];
}

// 1000 points; x = i / 100 so the record number is in the data too
function builtLas() {
	var pts = [];
	for (var i = 0; i < 1000; i++) pts.push({ x: i / 100, y: (i * 7) % 50 / 10, z: i % 13, classification: i % 4 === 0 ? 2 : (i % 4) + 2, returnNumber: 1, numberOfReturns: 1 });
	return buildLas({ version: "1.2", pointFormat: 0, scale: { x: 0.01, y: 0.01, z: 0.01 }, points: pts });
}

function filtersFor(h) {
	var b = h.bounds, w = b.maxX - b.minX, d = b.maxY - b.minY;
	return [
		{ name: "classes", f: { classes: [2] } },
		{ name: "maxPoints", f: { maxPoints: 50 } },
		{ name: "classes + maxPoints", f: { classes: [2], maxPoints: 50 } },
		{ name: "bounds", f: { bounds: { minX: b.minX + w * 0.25, maxX: b.maxX - w * 0.25, minY: b.minY + d * 0.25, maxY: b.maxY - d * 0.25 } } },
		{ name: "polygon", f: { polygon: lShape(b, 0.3) } }
	];
}

function checkAgainstFull(r, all, label) {
	var prev = -1;
	for (var j = 0; j < r.count; j++) {
		var i = r.index[j];
		assert.ok(i > prev, label + " index strictly ascending at " + j);
		assert.ok(i < all.count, label + " index in the file at " + j);
		prev = i;
		BASE.forEach(function (k) { if (r[k][j] !== all[k][i]) assert.fail(label + " " + k + "[" + j + "] is not the file's record " + i); });
	}
}

async function checkSource(source, label, opts, expectWindows) {
	var las = await openLas(source, opts);
	var all = await las.readPoints({ fields: BASE });
	var sawPart = false;
	var cases = filtersFor(las.header).concat([{ name: "no filter", f: {} }]);
	for (var cs of cases) {
		var tag = label + " " + cs.name;
		var r = await las.readPoints(Object.assign({ fields: BASE.concat(["index"]) }, cs.f));
		assert.ok(r.index instanceof Uint32Array, tag + " Uint32");
		assert.equal(r.index.length, r.count, tag + " index length");
		checkAgainstFull(r, all, tag);
		if (r.count > 0 && r.count < all.count) sawPart = true;
		// the same points window by window
		var got = [], windows = 0;
		for await (var c of las.chunks(Object.assign({ fields: BASE.concat(["index"]) }, cs.f))) {
			windows++;
			assert.equal(c.index.length, c.count, tag + " chunk index length");
			for (var j = 0; j < c.count; j++) got.push(c.index[j]);
		}
		assert.deepEqual(got, Array.from(r.index), tag + " chunks give the same indexes");
		if (expectWindows) assert.ok(windows >= expectWindows, tag + " windows " + windows);
	}
	assert.ok(sawPart, label + " at least one filter keeps part of the file");
	await las.close();
}

test("index names each kept record after filters and thinning (LAZ fixtures, threads 1 and 4)", async function () {
	for (var name of Object.keys(LAZ_MANIFEST)) {
		for (var threads of [1, 4]) {
			await checkSource(fixtureBytes(name), name + " threads " + threads, { threads: threads, windowSize: 1000 }, name === "f3" || name === "f7" ? 2 : 1);
		}
	}
});
test("index names each kept record after filters and thinning (LAS, 3+ windows)", async function () {
	await checkSource(builtLas(), "built LAS", { windowSize: 20 * 150 }, 7);
});
test("index of a built LAS is the record number: x was written as it", async function () {
	var las = await openLas(builtLas(), { windowSize: 20 * 150 });
	var r = await las.readPoints({ fields: ["x", "classification", "index"], classes: [2], maxPoints: 50 });
	assert.equal(r.count, 50);
	for (var j = 0; j < r.count; j++) {
		assert.equal(Math.round(r.x[j] * 100), r.index[j]);
		assert.equal(r.index[j] % 4, 0);
	}
});
test("index is not a default field; every point format can supply it", async function () {
	assert.ok(DEFAULT_FIELDS.indexOf("index") < 0);
	assert.equal(FIELD_TYPES.index, Uint32Array);
	var plain = await (await openLas(builtLas())).readPoints({});
	assert.equal(plain.index, undefined);
	for (var fmt = 0; fmt <= 10; fmt++) {
		var las = await openLas(buildLas({ version: fmt >= 6 ? "1.4" : "1.2", pointFormat: fmt, points: [{ x: 1, y: 2, z: 3 }, { x: 2, y: 3, z: 4 }, { x: 3, y: 4, z: 5 }] }));
		var r = await las.readPoints({ fields: ["index"] });
		assert.deepEqual(Array.from(r.index), [0, 1, 2], "format " + fmt);
	}
});
test("index is Uint32, or Float64 above 4294967295 points", function () {
	assert.equal(columnType("index", {}, { pointCount: 4294967295 }), Uint32Array);
	assert.equal(columnType("index", {}, { pointCount: 4294967296 }), Float64Array);
	assert.equal(columnType("x", {}, { pointCount: 4294967296 }), Float64Array);
	assert.equal(columnType("classification", {}, { pointCount: 4294967296 }), Uint8Array);
});
test("index survives keepPoints, removePoints, splitPoints and mergePoints", async function () {
	var las = await openLas(builtLas());
	var r = await las.readPoints({ fields: ["x", "classification", "index"], bounds: { minX: 2, maxX: 8 } });
	var sel = selectClasses(r, [2]);
	assert.ok(sel.length > 5 && sel.length < r.count);
	var kept = keepPoints(r, sel);
	assert.deepEqual(Array.from(kept.index), Array.from(sel, function (s) { return r.index[s]; }));
	assert.ok(kept.index instanceof Uint32Array);
	var rest = removePoints(r, sel);
	var inSel = {};
	sel.forEach(function (s) { inSel[s] = true; });
	var wantRest = [];
	for (var i = 0; i < r.count; i++) if (!inSel[i]) wantRest.push(r.index[i]);
	assert.deepEqual(Array.from(rest.index), wantRest);
	var parts = splitPoints(r, sel);
	assert.deepEqual(Array.from(parts[0].index), Array.from(kept.index));
	assert.deepEqual(Array.from(parts[1].index), wantRest);
	var back = mergePoints([kept, rest]);
	assert.equal(back.count, r.count);
	assert.deepEqual(Array.from(back.index), Array.from(kept.index).concat(wantRest));
	// and each index still names its record
	for (var j = 0; j < back.count; j++) assert.equal(Math.round(back.x[j] * 100), back.index[j]);
});
