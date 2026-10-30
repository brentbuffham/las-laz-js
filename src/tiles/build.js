// src/tiles/build.js
//==========================================================
// buildTiles: a LAS / LAZ file into a tile store in two streamed
// passes, memory bounded whatever the cloud's size:
//  1. count: raw X / Y / Z into a 128³ grid over a cube around the
//     header bounds (a point outside: the pass again on the true bounds)
//  2. chunks: grid cells merged up the octree while they fit chunkPoints;
//     a cell still over it (a far outlier stretches the cube, a dense
//     spot) is counted again on a finer grid below it, one more read a
//     round, until every chunk fits or cannot split
//  3. distribute: each record's bytes appended to its chunk's blob
//     (with a pool, each window grouped by chunk in a worker, the
//     windows written in order)
//  4. tiles: each chunk's octree (octree.js), then the levels above
//     the chunk roots sampled up to the root
//     (compress: each node one LAZ chunk, packed by the chunk's worker;
//     the chunk roots and the levels above them at the end, in the pool)
//  6. the manifest, last: a store without one is an unfinished build
// Abort or any error removes the partial store.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { lazVlrFor } from "../laz/LazVlr.js";
import { createChunkCompressor } from "../laz/compressChunk.js";
import { createLazPool, defaultThreads } from "../laz/pool.js";
import { openBackend } from "./backends.js";
import { encodeTile, decodeTile } from "./tileFile.js";
import { readManifest, writeManifest, fnv1a, LAYOUT_VERSION } from "./manifest.js";
import { keyOf, parseKey, childKey, sampleParent, compareKeys as keyOrder, MAX_DEPTH, MIN_EDGE } from "./octree.js";
import { chunkNodes, rawBox } from "./chunkNodes.js";
import { makeLocator, GRID_DEPTH, SUB } from "./locate.js";
import { TileStore, tileName, toBase64, HEAD_NAME, EVLRS_NAME } from "./TileStore.js";

var SPACE_FACTOR = 1.15;   // the raw records once (distribute) and the tiles as they are written
var PUTS = 8;   // node files written at once (OPFS: about 12 ms a file one by one, 4 ms eight at a time)
var PACK_WAIT = 30000;   // ms a pool may take over one node's compression (about 0.3 s of work) before it is packed on this thread
var GRID = 128;
var BUFFER_BYTES = 65536;
var BUCKETS = 4;   // distribute windows grouped in the pool at once
var plans = 0;   // a build's id for the pool's workers (each keeps the build's locator)
var READ_WINDOW = 16 * 1048576;   // the build's own read window (the reader's default is 64 MB): several LAZ chunks, so they decode in parallel

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


/**
 * Group the cells of a count grid into chunks: from its top down, a node whose points fit
 * chunkPoints is one chunk; a finest cell over it is a chunk of its own.
 * @param {Uint32Array} counts - (2^levels)³ cells, index x + n (y + n z)
 * @param {number} chunkPoints
 * @param {number} [levels=7] - the grid's levels below base
 * @param {number[]} [base=[0, 0, 0, 0]] - the parsed key of the node the grid covers
 * @returns {Array<{key: string, count: number}>} in key order; empty nodes give none
 */
export function planChunks(counts, chunkPoints, levels, base) {
	levels = levels || GRID_DEPTH;
	base = base || [0, 0, 0, 0];
	var sums = [];
	sums[levels] = counts;
	for (var d = levels - 1; d >= 0; d--) {
		var n = Math.pow(2, d), up = sums[d + 1], s = new Float64Array(n * n * n);
		for (var z = 0; z < 2 * n; z++) for (var y = 0; y < 2 * n; y++) for (var x = 0; x < 2 * n; x++) {
			s[Math.floor(x / 2) + n * (Math.floor(y / 2) + n * Math.floor(z / 2))] += up[x + 2 * n * (y + 2 * n * z)];
		}
		sums[d] = s;
	}
	var out = [];
	function visit(d, x, y, z) {
		var n = Math.pow(2, d), s = sums[d][x + n * (y + n * z)];
		if (!s) return;
		if (s <= chunkPoints || d === levels) { out.push({ key: keyOf(base[0] + d, base[1] * n + x, base[2] * n + y, base[3] * n + z), count: s }); return; }
		for (var o = 0; o < 8; o++) visit(d + 1, 2 * x + o % 2, 2 * y + Math.floor(o / 2) % 2, 2 * z + Math.floor(o / 4));
	}
	visit(0, 0, 0, 0);
	return out.sort(function (a, b) { return keyOrder(a.key, b.key); });
}

// Split the chunks over chunkPoints that the octree could still split: one more read counts
// their points on an 8³ grid three levels below each (fewer near the depth limit)
async function refineChunks(las, cube, len, chunks, chunkPoints, signal) {
	for (;;) {
		var over = [], slot = new Int32Array(chunks.length).fill(-1);
		chunks.forEach(function (c, ci) {
			var k = parseKey(c.key);
			if (c.count > chunkPoints && k[0] < MAX_DEPTH && cube.edge / Math.pow(2, k[0]) >= 2 * MIN_EDGE) {
				var levels = Math.min(SUB, MAX_DEPTH - k[0]), n = Math.pow(2, levels);
				slot[ci] = over.length;
				over.push({ k: k, levels: levels, n: n, counts: new Uint32Array(n * n * n) });
			}
		});
		if (!over.length) return chunks;
		var locate = makeLocator(cube, chunks);
		for await (var w of las._rawWindows(signal, READ_WINDOW)) {
			var r = w.bytes, v = new DataView(r.buffer, r.byteOffset, r.byteLength);
			for (var p = 0; p < r.length; p += len) {
				var X = v.getInt32(p, true), Y = v.getInt32(p + 4, true), Z = v.getInt32(p + 8, true), s = slot[locate(X, Y, Z)];
				if (s < 0) continue;
				var o = over[s], D = o.k[0] + o.levels, N = Math.pow(2, D), e = cube.edge / N;
				var cx = Math.min(N - 1, Math.max(0, Math.floor((X - cube.min[0]) / e))) - o.k[1] * o.n;
				var cy = Math.min(N - 1, Math.max(0, Math.floor((Y - cube.min[1]) / e))) - o.k[2] * o.n;
				var cz = Math.min(N - 1, Math.max(0, Math.floor((Z - cube.min[2]) / e))) - o.k[3] * o.n;
				o.counts[cx + o.n * (cy + o.n * cz)]++;
			}
		}
		var next = chunks.filter(function (c, ci) { return slot[ci] < 0; });
		over.forEach(function (o) { next = next.concat(planChunks(o.counts, chunkPoints, o.levels, o.k)); });
		chunks = next.sort(function (a, b) { return keyOrder(a.key, b.key); });
	}
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
 *   (2,000,000); threads; signal; onProgress({ phase, done, total }) (phases "count", "distribute", "tiles", and with
 *   compress also "pack"); replace (false); name
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
	var threads = wholeOption(opts, "threads", 0);   // 0 = automatic
	var h = las.header, len = h.recordLength, signal = opts.signal, onProgress = opts.onProgress;
	var laz = opts.compress ? lazVlrFor(h.pointFormat, len, 0).vlr : null;   // UNSUPPORTED for formats 4, 5, 9, 10
	await roomFor(opts.where, h.pointCount * len * SPACE_FACTOR, h.pointCount);
	var backend = await openBackend(opts.where);
	var existing = await readManifest(backend);
	if (existing && !opts.replace) throw bad("a tile store already exists at that where; pass replace: true to rebuild it");
	await backend.lock();   // before anything is deleted: a thread that cannot write refuses here
	if (existing) {
		await backend.removeAll();
		await backend.lock();
	}
	var open = [], pool = null;
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
		var chunks = await refineChunks(las, cube, len, planChunks(counted.counts, chunkPoints), chunkPoints, signal);
		counted = null;
		if (typeof opts._chunks === "function") opts._chunks(chunks.map(function (c) { return { key: c.key, count: c.count }; }));   // tests
		if (threads !== 1 && chunks.length >= 2) {
			var want = Math.min(threads || await defaultThreads(), chunks.length);
			if (want >= 2) pool = await createLazPool(want);   // null when workers cannot start: this thread
		}
		// 3. distribute
		await distribute(las, cube, len, chunks, backend, open, signal, phase(onProgress, "distribute", h.pointCount), pool);
		// 4. tiles
		var nodes = {}, sizes = {}, rawKeys = new Set();
		// a node's file; n: { count, records, packed, box (raw ints) } or raw records
		var put = async function (key, n) {
			if (n instanceof Uint8Array) n = { count: n.length / len, records: n, packed: false, box: rawBox(n, len) };
			var bytes = encodeTile({ count: n.count, records: n.records, compressed: n.packed, columns: [] });
			await backend.put(tileName(key, 0), bytes);
			var b = n.box;
			nodes[key] = { count: n.count, gen: 0, box: b ? [b[0] * s.x + o.x, b[1] * s.y + o.y, b[2] * s.z + o.z, b[3] * s.x + o.x, b[4] * s.y + o.y, b[5] * s.z + o.z] : null };
			sizes[key] = bytes.length;
			if (n.packed) rawKeys.delete(key); else rawKeys.add(key);
		};
		var tiles = phase(onProgress, "tiles", chunks.length + 1);
		var tileOpts = { tilePoints: tilePoints, maxDepth: MAX_DEPTH, minEdge: MIN_EDGE };
		// at most 2 x pool.size chunks in flight; each settles (its node files written, PUTS at a time: OPFS
		// spends most of a small write waiting) in chunk order on one chain, so the pool is fed while the
		// files of earlier chunks are still being written
		var inflight = [], settled = 0, chain = Promise.resolve();
		var settle = async function (job) {
			var built = await job.nodes;
			for (var n = 0; n < built.length; n += PUTS) {
				var batch = [];
				for (var b2 = n; b2 < Math.min(built.length, n + PUTS); b2++) batch.push(put(built[b2].key, built[b2]));
				await Promise.all(batch);
			}
			await backend.remove(job.blob);
			tiles.tick(++settled);
		};
		var queueSettle = function (job) { var next = chain.then(function () { return settle(job); }); chain = next; return next; };
		for (var c = 0; c < chunks.length; c++) {
			aborted(signal);
			var blob = "build/" + chunks[c].key + ".rec", recs = await backend.get(blob);
			if (!pool) { await settle({ blob: blob, nodes: chunkNodes(recs, len, cube, chunks[c].key, tileOpts, laz) }); continue; }
			var job = { blob: blob, nodes: pool.octree({ records: recs.slice().buffer, recordLength: len, cube: cube, rootKey: chunks[c].key, opts: tileOpts, laz: laz }) };
			job.nodes.catch(function () {});   // awaited in settle; an abort must not leave it unhandled
			job.done = queueSettle(job);
			job.done.catch(function () {});
			inflight.push(job);
			if (inflight.length >= 2 * pool.size) await inflight.shift().done;
		}
		await chain;
		await upperLevels(chunks, cube, len, backend, put);
		tiles.finish();
		// 5. compress what is still raw: the chunk roots and the levels above them (few nodes)
		if (laz) {
			// A pool that does not answer (a lost reply stalled a 177 M point build in Chrome for good) must not hold the
			// build: after PACK_WAIT with no reply, or on any pool failure, this and every later node is packed on this thread.
			var pack = createChunkCompressor(laz, len), rest = Array.from(rawKeys).sort(keyOrder);
			var wait = opts._packWait === undefined ? PACK_WAIT : opts._packWait, poolDown = !pool;
			var viaPool = function (t) {
				return new Promise(function (resolve) {
					var timer = setTimeout(function () { resolve(null); }, wait);
					pool.compress({ vlr: laz, recordLength: len, records: t.records.slice().buffer, counts: [t.count] }).then(
						function (r) { clearTimeout(timer); resolve(r.bytes); },
						function () { clearTimeout(timer); resolve(null); });
				});
			};
			var packOne = async function (key) {
				var t = decodeTile(await backend.get(tileName(key, 0)), [], key), box = rawBox(t.records, len), packed = null;
				if (!poolDown) { packed = await viaPool(t); if (!packed) poolDown = true; }
				if (!packed) packed = pack(t.records, 0, t.count);
				await put(key, { count: t.count, records: packed, packed: true, box: box });
			};
			var step = pool ? 2 * pool.size : 1, packing = phase(onProgress, "pack", rest.length);   // its own phase: "tiles" ends at the last chunk
			for (var k = 0; k < rest.length; k += step) {
				aborted(signal);
				await Promise.all(rest.slice(k, k + step).map(packOne));
				packing.tick(Math.min(rest.length, k + step));
			}
			packing.finish();
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
		var seq = await writeManifest(backend, body);
		var store = new TileStore(backend, body, head, las.evlrs.filter(function (e) { return e.bytes; }), seq);
		backend.unlock();
		return store;
	} catch (err) {
		if (pool) { pool.close(); pool = null; }
		for (var a = 0; a < open.length; a++) { try { await open[a].close(); } catch (e) { /* already closed */ } }
		await backend.removeAll();
		throw err;
	} finally {
		if (pool) pool.close();
	}
}

// OPFS: refuse up front when the browser says the build will not fit (the distribute pass holds every record
// raw before the tiles are written); a write past the quota later is NO_SPACE too, and the partial store goes
export async function roomFor(where, need, points) {
	if (!where || where.opfs === undefined || typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.estimate !== "function") return;
	var e;
	try { e = await navigator.storage.estimate(); } catch (x) { return; }
	if (!(e && e.quota > 0)) return;
	var free = e.quota - (e.usage || 0);
	function mb(n) { return Math.round(n / 1048576).toLocaleString("en") + " MB"; }
	if (free < need) throw new LasError(ERROR_CODES.NO_SPACE, "the tile store needs about " + mb(need) + " of browser storage for " + points.toLocaleString("en") + " points; " + mb(Math.max(0, free)) + " is free (of " + mb(e.quota) + "): remove other tile stores or site data, or build from fewer points");
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
	for await (var w of las._rawWindows(signal, READ_WINDOW)) {
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

// A chunk's run of records: through its buffer when small, else flushed and written as it is
function append(out, bytes, cap) {
	if (out.fill + bytes.length <= cap) { out.buf.set(bytes, out.fill); out.fill += bytes.length; if (out.fill === cap) { out.ap.write(out.buf); out.fill = 0; } return; }
	if (out.fill) { out.ap.write(out.buf.subarray(0, out.fill)); out.fill = 0; }
	if (bytes.length < cap) { out.buf.set(bytes); out.fill = bytes.length; } else out.ap.write(bytes);
}

async function distribute(las, cube, len, chunks, backend, open, signal, progress, pool) {
	var cap = Math.max(1, Math.floor(BUFFER_BYTES / len)) * len, outs = [];
	for (var i = 0; i < chunks.length; i++) {
		var ap = await backend.appender("build/" + chunks[i].key + ".rec");
		open.push(ap);
		outs.push({ ap: ap, buf: new Uint8Array(cap), fill: 0 });
	}
	var done = 0;
	if (pool || chunks.length === 1) {
		// one chunk: each window as it is; a pool: each window grouped by chunk in a worker, BUCKETS at once,
		// written in window order (so each chunk's records stay in file order)
		var plan = ++plans, keys = chunks.map(function (c) { return c.key; }), inflight = [];
		var write = async function (job) {
			var g = await job, o = 0;
			for (var q = 0; q < g.runs.length; q += 2) {
				var size = g.runs[q + 1] * len;
				append(outs[g.runs[q]], g.bytes.subarray(o, o + size), cap);
				o += size;
			}
			done += g.bytes.length / len;
			progress.tick(done);
		};
		try {
			for await (var win of las._rawWindows(signal, READ_WINDOW)) {
				var bytes = win.bytes, job;
				if (!pool) job = Promise.resolve({ bytes: bytes, runs: [0, bytes.length / len] });
				else {
					if (!win.owned || bytes.byteOffset || bytes.byteLength !== bytes.buffer.byteLength) bytes = bytes.slice();
					job = pool.bucket({ records: bytes.buffer, recordLength: len, cube: cube, chunks: keys, plan: plan });
					job.catch(function () {});   // awaited in order below; an abort must not leave it unhandled
				}
				if (!pool) { await write(job); continue; }
				inflight.push(job);
				if (inflight.length >= BUCKETS) await write(inflight.shift());
			}
			while (inflight.length) await write(inflight.shift());
		} finally {
			inflight.length = 0;
		}
		return closeAll(outs, open, progress);
	}
	var locate = makeLocator(cube, chunks);
	for await (var w of las._rawWindows(signal, READ_WINDOW)) {
		var r = w.bytes, v = new DataView(r.buffer, r.byteOffset, r.byteLength);
		for (var p = 0; p < r.length; p += len) {
			var out = outs[locate(v.getInt32(p, true), v.getInt32(p + 4, true), v.getInt32(p + 8, true))];
			var dst = out.buf, f = out.fill;
			for (var b = 0; b < len; b++) dst[f + b] = r[p + b];   // a byte loop: no subarray object per point
			out.fill = f + len;
			if (out.fill === cap) { out.ap.write(out.buf); out.fill = 0; }
		}
		done += r.length / len;
		progress.tick(done);
	}
	return closeAll(outs, open, progress);
}

async function closeAll(outs, open, progress) {
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
