// test/helpers/tileClouds.js
//==========================================================
// Raw LAS-like records for the octree tests: int32 X / Y / Z at
// 0 / 4 / 8 and the point's index as a u32 at 12, so every record is
// distinct and a test can tell which point went where. Test-only.
//==========================================================
import { rng } from "./clouds.js";

/** Records for raw [X, Y, Z] points (recordLength >= 16). */
export function rawRecords(points, recordLength) {
	var out = new Uint8Array(points.length * recordLength), v = new DataView(out.buffer);
	points.forEach(function (p, i) {
		var at = i * recordLength;
		v.setInt32(at, p[0], true); v.setInt32(at + 4, p[1], true); v.setInt32(at + 8, p[2], true);
		v.setUint32(at + 12, i, true);
	});
	return out;
}

/** [X, Y, Z, index] per record. */
export function pointsOf(records, recordLength) {
	var v = new DataView(records.buffer, records.byteOffset, records.byteLength), out = [];
	for (var at = 0; at < records.length; at += recordLength) out.push([v.getInt32(at, true), v.getInt32(at + 4, true), v.getInt32(at + 8, true), v.getUint32(at + 12, true)]);
	return out;
}

/** n seeded random raw points in [lo, lo + span) on each axis. */
export function randomRaw(n, seed, lo, span) {
	var r = rng(seed), out = [];
	for (var i = 0; i < n; i++) out.push([lo + Math.floor(r() * span), lo + Math.floor(r() * span), lo + Math.floor(r() * span)]);
	return out;
}
