// test/helpers/tileFiles.js
//==========================================================
// LAS files for the tile-store tests (buildLas, seeded, UTM-sized
// coordinates, every record distinct), and readers that pull a
// store's records back out node by node for oracle checks. Test-only.
//==========================================================
import { buildLas } from "./buildLas.js";
import { rng } from "./clouds.js";
import { decodeTile } from "../../src/tiles/tileFile.js";
import { createChunkDecoder } from "../../src/laz/decompressChunk.js";

/**
 * A LAS file of n seeded points in a box of `span` metres at a UTM origin.
 * @param {{pointFormat?, version?, n?, seed?, span?, flatZ?, same?, extraBytes?}} o
 */
export function tileLas(o) {
	var r = rng(o.seed || 1), n = o.n === undefined ? 20000 : o.n, span = o.span || 200, fmt = o.pointFormat || 0, pts = [];
	for (var i = 0; i < n; i++) {
		var p = o.same ? { x: 478000.5, y: 6772000.25, z: 312 } : { x: 478000 + r() * span, y: 6772000 + r() * span, z: o.flatZ !== undefined ? o.flatZ : 300 + r() * span / 4 };
		p.intensity = i % 65536; p.userData = (i * 11) % 256; p.returnNumber = 1 + (i % 3); p.numberOfReturns = 3; p.classification = 1 + (i % 7);
		p.gpsTime = i * 0.001; p.pointSourceId = Math.floor(i / 65536); p.red = i % 65536; p.green = (i * 3) % 65536; p.blue = (i * 7) % 65536;
		pts.push(p);
	}
	var bytes = buildLas({ version: o.version || (fmt >= 6 ? "1.4" : "1.2"), pointFormat: fmt, points: pts, offset: { x: 478000, y: 6772000, z: 0 }, extraBytes: o.extraBytes || 0 });
	if (o.extraBytes) {
		var v = new DataView(bytes.buffer), start = v.getUint32(96, true), len = v.getUint16(105, true), base = len - o.extraBytes;
		for (var k = 0; k < n; k++) for (var e = 0; e < o.extraBytes; e++) bytes[start + k * len + base + e] = (k * 13 + e * 5) % 256;
	}
	return bytes;
}

/** The point records of a LAS file (uncompressed), as a sorted list of latin1 strings. */
export function sourceRecords(bytes) {
	var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	var start = v.getUint32(96, true), len = v.getUint16(105, true), out = [];
	var n = (bytes[25] >= 4 ? Number(v.getBigUint64(247, true)) : v.getUint32(107, true));
	for (var i = 0; i < n; i++) out.push(latin1(bytes.subarray(start + i * len, start + (i + 1) * len)));
	return out.sort();
}

function latin1(b) { var s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }

/** A node's raw records (decompressed when the store is compressed). */
export async function nodeRecords(store, key) {
	var m = store.manifest, node = m.nodes[key];
	var t = decodeTile(await store._backend.get(key + "." + node.gen + ".tile"), m.columns.map(function (c) { return c.type; }), key);
	if (!t.compressed) return t.records;
	var out = new Uint8Array(t.count * m.recordLength);
	if (t.count) createChunkDecoder(m.laz, m.recordLength)(t.records, 0, t.records.length, t.count, new DataView(out.buffer), 0, 0);
	return out;
}

/** Every record in the store, as a sorted list of latin1 strings. */
export async function storeRecords(store) {
	var len = store.manifest.recordLength, out = [];
	for (var key of Object.keys(store.manifest.nodes)) {
		var r = await nodeRecords(store, key);
		for (var i = 0; i < r.length; i += len) out.push(latin1(r.subarray(i, i + len)));
	}
	return out.sort();
}
