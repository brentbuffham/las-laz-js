// test/helpers/lazFixtureFiles.js
//==========================================================
// Load the committed LAZ fixtures (test/fixtures/laz/) and their
// manifest, and decompress one whole file through the low-level LAZ
// pieces (VLR, chunk table, chunk decoder) — independent of LasReader.
//==========================================================
/* prettier-ignore-file */
import { readFileSync } from "node:fs";
import { parseHeader } from "../../src/format/LasHeader.js";
import { parseVlrs } from "../../src/format/LasVlr.js";
import { MemorySource } from "../../src/io/MemorySource.js";
import { findLazVlr } from "../../src/laz/LazVlr.js";
import { readChunks } from "../../src/laz/chunkTable.js";
import { createChunkDecoder } from "../../src/laz/decompressChunk.js";

/** The manifest's fixtures: { name: { pointFormat, points, recordLength, sha256 } }. */
export var LAZ_MANIFEST = JSON.parse(readFileSync(new URL("../fixtures/laz/manifest.json", import.meta.url), "utf8")).fixtures;

/** A fixture's bytes. */
export function fixtureBytes(name) { return new Uint8Array(readFileSync(new URL("../fixtures/laz/" + name + ".laz", import.meta.url))); }

/** Every record of a LAZ file, decompressed chunk by chunk. */
export async function decompressAll(bytes) {
	var h = parseHeader(new MemorySource(bytes));
	var vlrs = parseVlrs(new MemorySource(bytes), h.headerSize, h.numberOfVlrs, h.offsetToPointData);
	var vlr = findLazVlr(vlrs);
	var src = { size: bytes.length, read: async function (a, b) { return bytes.subarray(a, b); } };
	var chunks = await readChunks(src, h, vlr);
	var out = new Uint8Array(h.pointCount * h.recordLength), view = new DataView(out.buffer);
	var decode = createChunkDecoder(vlr, h.recordLength);
	chunks.forEach(function (c) { decode(bytes, c.start, c.end, c.count, view, c.firstRecord * h.recordLength); });
	return { header: Object.assign({}, h, { compressed: false }), records: out, chunks: chunks };
}
