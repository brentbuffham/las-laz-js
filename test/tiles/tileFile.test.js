// test/tiles/tileFile.test.js
//==========================================================
// A node file: 32-byte header, records, added columns 8-byte aligned;
// a round trip, and bad bytes refused as BAD_STORE.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeTile, decodeTile } from "../../src/tiles/tileFile.js";

function tile(count, recLen, compressed, types) {
	var records = new Uint8Array(count * recLen + (compressed ? 3 : 0));
	for (var i = 0; i < records.length; i++) records[i] = (i * 7) & 255;   // bits-ok
	var make = { u8: Uint8Array, i32: Int32Array, f64: Float64Array };
	var columns = types.map(function (t, j) { var c = new make[t](count); for (var i = 0; i < count; i++) c[i] = (i + j) * (t === "f64" ? 0.5 : 1); return c; });
	return { count: count, records: records, compressed: compressed, columns: columns };
}

test("round trip", function () {
	[[0, 20, false, []], [1, 20, true, ["u8"]], [13, 34, false, ["u8", "i32", "f64", "u8", "i32", "f64", "u8"]]].forEach(function (c) {
		var t = tile(c[0], c[1], c[2], c[3]);
		var bytes = encodeTile(t);
		assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), "LLZT");
		var back = decodeTile(bytes, c[3], "n.tile");
		assert.equal(back.count, t.count);
		assert.equal(back.compressed, t.compressed);
		assert.deepEqual(back.records, t.records);
		assert.equal(back.columns.length, t.columns.length);
		back.columns.forEach(function (col, j) {
			assert.deepEqual(col, t.columns[j]);
			assert.equal(col.byteOffset % 8, 0, "column " + j + " starts on 8");
		});
	});
});

test("bad bytes are BAD_STORE", function () {
	var good = encodeTile(tile(5, 20, false, ["i32"]));
	var magic = good.slice(); magic[0] = 0;
	var version = good.slice(); new DataView(version.buffer).setUint16(4, 2, true);
	var cut = good.slice(0, 32 + 40);
	[magic, version, cut, good.slice(0, 10)].forEach(function (b) {
		assert.throws(function () { decodeTile(b, ["i32"], "1-0-1-0.3.tile"); }, function (e) { return e.code === "BAD_STORE" && /1-0-1-0\.3\.tile/.test(e.message); });
	});
	assert.throws(function () { decodeTile(good, ["i32", "u8"], "x.tile"); }, function (e) { return e.code === "BAD_STORE"; });
});
