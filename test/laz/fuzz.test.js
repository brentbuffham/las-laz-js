// test/laz/fuzz.test.js
//==========================================================
// Damaged LAZ files (every fixture, deterministic mutations): cut short
// at many places, bytes flipped in the point data, the chunk table's
// offset and entries scrambled. Reading one (on this thread and on the
// pool) either succeeds - a flip can decode to other numbers - or fails
// with a LasError; never a TypeError, RangeError or any other raw error,
// and never a hang (each read is timed).
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openLas, LasError } from "../../src/index.js";

var DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/laz");
var FILES = fs.readdirSync(DIR).filter(function (f) { return /\.laz$/.test(f); }).sort();
function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6d2b79f5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// read every point of a (maybe damaged) file; "ok" or the LasError's code; anything else fails the test
async function read(bytes, threads, what) {
	var t0 = Date.now(), las;
	try {
		las = await openLas(bytes, { threads: threads });
		var n = 0;
		for await (var c of las.chunks({})) n += c.count;
		await las.close();
		return "ok";
	} catch (e) {
		if (las) try { await las.close(); } catch (x) { /* closed */ }
		if (!(e instanceof LasError)) throw new Error(what + ": a raw " + (e && e.name) + " escaped: " + (e && e.message));
		return e.code;
	} finally {
		assert.ok(Date.now() - t0 < 10000, what + " took " + (Date.now() - t0) + " ms");
	}
}

// where the point data and the chunk table are
function layout(bytes) {
	var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), data = v.getUint32(96, true);
	var table = Number(v.getBigInt64(data, true));
	return { data: data, table: table };
}

FILES.forEach(function (name) {
	test("damaged " + name + ": a LasError or a read, never a raw error or a hang", { timeout: 120000 }, async function () {
		var good = new Uint8Array(fs.readFileSync(path.join(DIR, name))), L = layout(good), r = rng(name.length * 7919 + good.length), codes = {};
		function note(c) { codes[c] = (codes[c] || 0) + 1; }
		// cut short: in the header, the VLRs, the point data, the chunk table
		for (var k = 0; k < 24; k++) {
			var cut = k < 4 ? Math.floor(r() * L.data) : k < 20 ? L.data + Math.floor(r() * (L.table - L.data)) : L.table + Math.floor(r() * (good.length - L.table));
			note(await read(good.slice(0, cut), 1, name + " cut at " + cut));
		}
		// bytes flipped in the point data (past the chunk-table offset)
		for (k = 0; k < 24; k++) {
			var b = good.slice(), flips = 1 + Math.floor(r() * 16);
			for (var f = 0; f < flips; f++) b[L.data + 8 + Math.floor(r() * (L.table - L.data - 8))] ^= 1 + Math.floor(r() * 255);
			note(await read(b, k % 2 ? 1 : 2, name + " flip " + k));
		}
		// the chunk table: its offset, and its entries
		for (k = 0; k < 12; k++) {
			var t = good.slice(), dv = new DataView(t.buffer);
			if (k < 4) dv.setBigInt64(L.data, BigInt([0, t.length + 100, L.data + 1, 2 ** 40][k]), true);
			else for (var g = 0; g < 4; g++) t[L.table + Math.floor(r() * (t.length - L.table))] ^= 1 + Math.floor(r() * 255);
			note(await read(t, k % 2 ? 1 : 2, name + " table " + k));
		}
		assert.ok(Object.keys(codes).some(function (c) { return c !== "ok"; }), name + ": no mutation was refused: " + JSON.stringify(codes));
	});
});
