// src/tiles/build.js
//==========================================================
// buildTiles: a LAS / LAZ file into a tile store in two streamed
// passes, memory bounded whatever the cloud's size:
//  1. count: raw X / Y / Z into a 128³ grid over a cube around the
//     header bounds (a point outside: the pass again on the true bounds)
//  2. chunks: grid cells merged up the octree while they fit chunkPoints
//  3. distribute: each record's bytes appended to its chunk's blob
//  4. tiles: each chunk's octree (octree.js), then the levels above
//     the chunk roots sampled up to the root
//  5. compress (optional): each node one LAZ chunk
//  6. the manifest, last: a store without one is an unfinished build
// Abort or any error removes the partial store.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { lazVlrFor } from "../laz/LazVlr.js";
import { createChunkCompressor } from "../laz/compressChunk.js";
import { openBackend } from "./backends.js";
import { encodeTile, decodeTile } from "./tileFile.js";
import { readManifest, writeManifest, fnv1a, LAYOUT_VERSION } from "./manifest.js";
import { keyOf, parseKey, childKey, buildChunkOctree, sampleParent, MAX_DEPTH, MIN_EDGE } from "./octree.js";
import { TileStore, tileName, toBase64, HEAD_NAME, EVLRS_NAME } from "./TileStore.js";

var GRID = 128, GRID_DEPTH = 7;
var BUFFER_BYTES = 65536;

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

function wholeOption(o, name, dflt) {
	if (o[name] === undefined) return dflt;
	if (typeof o[name] !== "number" || !Number.isInteger(o[name]) || o[name] < 1) throw bad(name + " must be a whole number of 1 or more");
	return o[name];
}

/**
 * The source's fingerprint, as ecw-js keys its cache: name, size, date and an FNV-1a of
 * the first 4 KB.
 * @param {object} las - a LasReader
 * @param {string} [name]
 * @returns {Promise<{name: string, size: number, lastModified: number|null, head: number}>}
 */
export async function fingerprint(las, name) {
	var src = las._src, blob = src._blob;
	var head = await src.read(0, Math.min(4096, src.size));
	return { name: name || (blob && blob.name) || "", size: src.size, lastModified: blob && typeof blob.lastModified === "number" ? blob.lastModified : null, head: fnv1a(new Uint8Array(head)) };
}

function keyOrder(a, b) {
	var p = parseKey(a), q = parseKey(b);
	for (var i = 0; i < 4; i++) if (p[i] !== q[i]) return p[i] - q[i];
	return 0;
}

/**
 * Group the cells of a 128³ count grid into chunks: from the root down, a node whose points
 * fit chunkPoints is one chunk; a single depth-7 cell over it is a chunk of its own.
 * @param {Uint32Array} counts - 128³ cells, index x + 128 (y + 128 z)
 * @param {number} chunkPoints
 * @returns {Array<{key: string, count: number}>} in key order; empty nodes give none
 */
export function planChunks(counts, chunkPoints) {
	var levels = [];
	levels[GRID_DEPTH] = counts;
	for (var d = GRID_DEPTH - 1; d >= 0; d--) {
		var n = Math.pow(2, d), up = levels[d + 1], sums = new Float64Array(n * n * n);
		for (var z = 0; z < 2 * n; z++) for (var y = 0; y < 2 * n; y++) for (var x = 0; x < 2 * n; x++) {
			sums[Math.floor(x / 2) + n * (Math.floor(y / 2) + n * Math.floor(z / 2))] += up[x + 2 * n * (y + 2 * n * z)];
		}
		levels[d] = sums;
	}
	var out = [];
	function visit(d, x, y, z) {
		var n = Math.pow(2, d), s = levels[d][x + n * (y + n * z)];
		if (!s) return;
		if (s <= chunkPoints || d === GRID_DEPTH) { out.push({ key: keyOf(d, x, y, z), count: s }); return; }
		for (var o = 0; o < 8; o++) visit(d + 1, 2 * x + o % 2, 2 * y + Math.floor(o / 2) % 2, 2 * z + Math.floor(o / 4));
	}
	visit(0, 0, 0, 0);
	return out.sort(function (a, b) { return keyOrder(a.key, b.key); });
}

// Each value once, climbing; the total only from finish()
function phase(onProgress, name, total) {
	var last = -1;
	return {
		tick: function (done) {
			if (!onProgress) return;
			if (done > total - 1) done = total - 1;
			if (done > last && (last < 0 || done - last >= Math.max(1, total / 100))) { last = done; onProgress({ phase: name, done: done, total: total }); }
		},
		finish: function () { if (onProgress && total > last) { last = total; onProgress({ phase: name, done: total, total: total }); } }
	};
}

function rawCube(min, max) {
	var edge = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
	return { min: min.slice(), edge: edge };
}

function cellIndexer(cube) {
	var e = cube.edge / GRID;
	function c(v, m) { var k = Math.floor((v - m) / e); return k < 0 ? 0 : k >= GRID ? GRID - 1 : k; }
	return function (X, Y, Z) { return c(X, cube.min[0]) + GRID * (c(Y, cube.min[1]) + GRID * c(Z, cube.min[2])); };
}

function aborted(signal) { if (signal && signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "tile build aborted"); }

/**
 * Build a tile store from a LAS / LAZ file.
 * @param {object} las - a LasReader (openLas)
 * @param {object} opts - where (required); compress (false); tilePoints (50,000); chunkPoints
 *   (2,000,000); threads; signal; onProgress({ phase, done, total }); replace (false); name
 * @returns {Promise<TileStore>}
 * @throws {LasError} INVALID_ARGUMENT (options, an existing store), UNSUPPORTED (compress for
 *   formats 4, 5, 9, 10), ABORTED
 */
export async function buildTiles(las, opts) {
	opts = opts || {};
	if (!las || !las.header || typeof las._rawWindows !== "function") throw bad("buildTiles needs a LasReader (openLas)");
	if (!opts.where) throw bad("buildTiles needs a where: { memory: true }, { opfs: id } or { dir: path }");
	var tilePoints = wholeOption(opts, "tilePoints", 50000), chunkPoints = wholeOption(opts, "chunkPoints", 2000000);
	if (opts.onProgress !== undefined && typeof opts.onProgress !== "function") throw bad("onProgress must be a function");
	var h = las.header, len = h.recordLength, signal = opts.signal, onProgress = opts.onProgress;
	var laz = opts.compress ? lazVlrFor(h.pointFormat, len, 0).vlr : null;   // UNSUPPORTED for formats 4, 5, 9, 10
	var backend = await openBackend(opts.where);
	if (await readManifest(backend)) {
		if (!opts.replace) throw bad("a tile store already exists at that where; pass replace: true to rebuild it");
		await backend.removeAll();
	}
	await backend.lock();
	var open = [];
	try {
		var src = await fingerprint(las, opts.name);
		var s = h.scale, o = h.offset, b = h.bounds;
		function raw(v, off, sc) { return (v - off) / sc; }
		var cube = rawCube([Math.floor(raw(b.minX, o.x, s.x) - 0.5), Math.floor(raw(b.minY, o.y, s.y) - 0.5), Math.floor(raw(b.minZ, o.z, s.z) - 0.5)],
			[Math.ceil(raw(b.maxX, o.x, s.x) + 0.5), Math.ceil(raw(b.maxY, o.y, s.y) + 0.5), Math.ceil(raw(b.maxZ, o.z, s.z) + 0.5)]);

		// 1. count
		var counted = await countPass(las, cube, len, signal, phase(onProgress, "count", h.pointCount));
		if (counted.outside) {
			cube = rawCube(counted.min, counted.max);
			counted = await countPass(las, cube, len, signal, null);
		}
		// 2. chunks
		var chunks = planChunks(counted.counts, chunkPoints);
		counted = null;
		// 3. distribute
		await distribute(las, cube, len, chunks, backend, open, signal, phase(onProgress, "distribute", h.pointCount));
		// 4. tiles
		var nodes = {}, sizes = {};
		var put = async function (key, records) {
			var bytes = encodeTile({ count: records.length / len, records: records, compressed: false, columns: [] });
			await backend.put(tileName(key, 0), bytes);
			nodes[key] = { count: records.length / len, gen: 0, box: tightBox(records, len, s, o) };
			sizes[key] = bytes.length;
		};
		var tiles = phase(onProgress, "tiles", chunks.length + 1);
		var tileOpts = { tilePoints: tilePoints, maxDepth: MAX_DEPTH, minEdge: MIN_EDGE };
		for (var c = 0; c < chunks.length; c++) {
			aborted(signal);
			var blob = "build/" + chunks[c].key + ".rec";
			var built = buildChunkOctree(await backend.get(blob), len, cube, chunks[c].key, tileOpts);
			for (var n = 0; n < built.length; n++) await put(built[n].key, built[n].records);
			await backend.remove(blob);
			tiles.tick(c + 1);
		}
		await upperLevels(chunks, cube, len, backend, put);
		tiles.finish();
		// 5. compress
		if (laz) {
			var keys = Object.keys(nodes).sort(keyOrder), pack = createChunkCompressor(laz, len);
			var comp = phase(onProgress, "compress", keys.length);
			for (var k = 0; k < keys.length; k++) {
				aborted(signal);
				var t = decodeTile(await backend.get(tileName(keys[k], 0)), [], keys[k]);
				var bytes = encodeTile({ count: t.count, records: pack(t.records, 0, t.count), compressed: true, columns: [] });
				await backend.put(tileName(keys[k], 0), bytes);
				sizes[keys[k]] = bytes.length;
				comp.tick(k + 1);
			}
			comp.finish();
		}
		// 6. the source's header and VLRs, then the manifest
		var head = new Uint8Array(await las._src.read(0, h.offsetToPointData));
		await backend.put(HEAD_NAME, head);
		var evlrs = las.evlrs.filter(function (e) { return e.bytes; }).map(function (e) { return { userId: e.userId, recordId: e.recordId, description: e.description, bytes: toBase64(e.bytes) }; });
		await backend.put(EVLRS_NAME, new TextEncoder().encode(JSON.stringify(evlrs)));
		var total = head.length;
		Object.keys(sizes).forEach(function (key) { total += sizes[key]; });
		var body = {
			layout: LAYOUT_VERSION, source: src, pointCount: h.pointCount, built: Date.now(),
			pointFormat: h.pointFormat, recordLength: len, scale: s, offset: o, laz: laz, cube: cube,
			nodes: sortedNodes(nodes), columns: [], transform: null, edits: 0, deletes: 0, bytes: total
		};
		await writeManifest(backend, body);
		var store = new TileStore(backend, body, head, las.evlrs.filter(function (e) { return e.bytes; }));
		backend.unlock();
		return store;
	} catch (err) {
		for (var a = 0; a < open.length; a++) { try { await open[a].close(); } catch (e) { /* already closed */ } }
		await backend.removeAll();
		throw err;
	}
}

function sortedNodes(nodes) {
	var out = {};
	Object.keys(nodes).sort(keyOrder).forEach(function (k) { out[k] = nodes[k]; });
	return out;
}

// [minX, minY, minZ, maxX, maxY, maxZ] in world units, or null for no points
export function tightBox(records, len, s, o) {
	if (!records.length) return null;
	var v = new DataView(records.buffer, records.byteOffset, records.byteLength);
	var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (var p = 0; p < records.length; p += len) {
		for (var a = 0; a < 3; a++) {
			var r = v.getInt32(p + 4 * a, true);
			if (r < lo[a]) lo[a] = r;
			if (r > hi[a]) hi[a] = r;
		}
	}
	return [lo[0] * s.x + o.x, lo[1] * s.y + o.y, lo[2] * s.z + o.z, hi[0] * s.x + o.x, hi[1] * s.y + o.y, hi[2] * s.z + o.z];
}

async function countPass(las, cube, len, signal, progress) {
	var counts = new Uint32Array(GRID * GRID * GRID), cell = cellIndexer(cube), done = 0, outside = false;
	var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	var lo = cube.min, hi = [cube.min[0] + cube.edge, cube.min[1] + cube.edge, cube.min[2] + cube.edge];
	for await (var w of las._rawWindows(signal)) {
		var r = w.bytes, v = new DataView(r.buffer, r.byteOffset, r.byteLength);
		for (var p = 0; p < r.length; p += len) {
			var X = v.getInt32(p, true), Y = v.getInt32(p + 4, true), Z = v.getInt32(p + 8, true);
			if (X < min[0]) min[0] = X; if (X > max[0]) max[0] = X;
			if (Y < min[1]) min[1] = Y; if (Y > max[1]) max[1] = Y;
			if (Z < min[2]) min[2] = Z; if (Z > max[2]) max[2] = Z;
			if (X < lo[0] || X > hi[0] || Y < lo[1] || Y > hi[1] || Z < lo[2] || Z > hi[2]) outside = true;
			counts[cell(X, Y, Z)]++;
		}
		done += r.length / len;
		if (progress) progress.tick(done);
	}
	if (progress) progress.finish();
	return { counts: counts, outside: outside, min: min, max: max };
}

async function distribute(las, cube, len, chunks, backend, open, signal, progress) {
	var cellChunk = new Int32Array(GRID * GRID * GRID).fill(-1);
	chunks.forEach(function (c, ci) {
		var k = parseKey(c.key), span = Math.pow(2, GRID_DEPTH - k[0]);
		for (var z = k[3] * span; z < (k[3] + 1) * span; z++) for (var y = k[2] * span; y < (k[2] + 1) * span; y++) for (var x = k[1] * span; x < (k[1] + 1) * span; x++) cellChunk[x + GRID * (y + GRID * z)] = ci;
	});
	var cap = Math.max(1, Math.floor(BUFFER_BYTES / len)) * len, outs = [];
	for (var i = 0; i < chunks.length; i++) {
		var ap = await backend.appender("build/" + chunks[i].key + ".rec");
		open.push(ap);
		outs.push({ ap: ap, buf: new Uint8Array(cap), fill: 0 });
	}
	var cell = cellIndexer(cube), done = 0;
	for await (var w of las._rawWindows(signal)) {
		var r = w.bytes, v = new DataView(r.buffer, r.byteOffset, r.byteLength);
		for (var p = 0; p < r.length; p += len) {
			var out = outs[cellChunk[cell(v.getInt32(p, true), v.getInt32(p + 4, true), v.getInt32(p + 8, true))]];
			out.buf.set(r.subarray(p, p + len), out.fill);
			out.fill += len;
			if (out.fill === cap) { out.ap.write(out.buf); out.fill = 0; }
		}
		done += r.length / len;
		progress.tick(done);
	}
	for (var j = 0; j < outs.length; j++) {
		if (outs[j].fill) outs[j].ap.write(outs[j].buf.subarray(0, outs[j].fill));
		await outs[j].ap.close();
	}
	open.length = 0;
	progress.finish();
}

// Sample the levels above the chunk roots up to the root, depth first, so only one path of
// nodes is in memory; each child is rewritten with what the sampling left it
async function upperLevels(chunks, cube, len, backend, put) {
	var isChunk = new Set(chunks.map(function (c) { return c.key; }));
	if (isChunk.has("0-0-0-0")) return;
	if (!chunks.length) { await put("0-0-0-0", new Uint8Array(0)); return; }
	var above = new Set();
	chunks.forEach(function (c) {
		var k = parseKey(c.key);
		for (var d = k[0] - 1; d >= 0; d--) {
			var f = Math.pow(2, k[0] - d);
			above.add(keyOf(d, Math.floor(k[1] / f), Math.floor(k[2] / f), Math.floor(k[3] / f)));
		}
	});
	async function records(key) {
		if (isChunk.has(key)) return decodeTile(await backend.get(tileName(key, 0)), [], key).records.slice();
		var kids = [];
		for (var o = 0; o < 8; o++) {
			var ck = childKey(key, o);
			if (isChunk.has(ck) || above.has(ck)) kids.push({ key: ck, records: await records(ck) });
		}
		var s = sampleParent(cube, key, kids, len);
		for (var i = 0; i < s.children.length; i++) await put(s.children[i].key, s.children[i].records);
		return s.parent;
	}
	await put("0-0-0-0", await records("0-0-0-0"));
}
