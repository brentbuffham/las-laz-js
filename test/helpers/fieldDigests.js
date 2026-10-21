// test/helpers/fieldDigests.js
//==========================================================
// One SHA-256 per field over every point of a LAS / LAZ, streamed
// window by window (chunks()), so even a 1 GB file never sits in
// memory whole. Two files with equal digests hold the same points,
// field by field. Source: a path or bytes, as openLas takes.
// Test-only.
//==========================================================
/* prettier-ignore-file */
import { createHash } from "node:crypto";
import { FIELD_TYPES } from "../../src/read/decodeRecords.js";
import { openLas } from "../../src/LasReader.js";

/** Every field the library decodes (fields a format lacks are dropped by the reader). */
export var EVERY_FIELD = Object.keys(FIELD_TYPES);

/**
 * @param {string|Uint8Array} source
 * @param {string[]} [fields] - default EVERY_FIELD
 * @returns {Promise<object>} { count, <field>: hex digest, ... } for the fields the file's format holds
 */
export async function fieldDigests(source, fields) {
	var las = await openLas(source);
	var h0 = las.header;
	fields = (fields || EVERY_FIELD).filter(function (f) { return f !== "gpsTime" || h0.pointFormat === 1 || h0.pointFormat >= 3; });
	var hashes = {};
	fields.forEach(function (f) { hashes[f] = createHash("sha256"); });
	var n = 0;
	for await (var c of las.chunks({ fields: fields })) {
		fields.forEach(function (f) { if (c[f]) hashes[f].update(new Uint8Array(c[f].buffer, c[f].byteOffset, c[f].byteLength)); });
		n += c.count;
	}
	await las.close();
	var out = { count: n };
	fields.forEach(function (f) { out[f] = hashes[f].digest("hex"); });
	return out;
}
