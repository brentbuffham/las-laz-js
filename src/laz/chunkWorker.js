// src/laz/chunkWorker.js
//==========================================================
// Worker entry for parallel LAZ work (src/laz/pool.js): decodes whole
// chunks into raw LAS records, or compresses raw records into whole
// chunks, and sends them back (transferred). Runs as a browser module
// Worker or a Node worker_threads Worker.
// In (decode, no op):  { id, vlr, recordLength, packed: ArrayBuffer, chunks: [{ s, e, count }], base }
//      (s / e index into packed; base is packed's file offset)
// In (compress): { id, op: "compress", vlr, recordLength, records: ArrayBuffer, counts: number[] }
//      (counts: each chunk's points, back to back from the start of records)
// In (octree): { id, op: "octree", records: ArrayBuffer, recordLength, cube, rootKey, opts, laz }
//      (a tile build's chunk: src/tiles/chunkNodes.js)
// Out: { ready: true } once listening, then per task
//      decode { id, records: ArrayBuffer }, compress { id, chunks: ArrayBuffer, sizes: number[] }
//      (the chunks back to back, and each one's length), octree { id, nodes: [{ key, count, records: ArrayBuffer, packed, box }] },
//      or { id, error: { code, message, offset } }
//
// Uses the chunk decoder translated from laz-rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2015 martin isenburg,
// rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: written in JavaScript as a worker entry, Brent Buffham 2026.
//==========================================================

import { createChunkDecoder } from "./decompressChunk.js";
import { createChunkCompressor } from "./compressChunk.js";
import { chunkNodes } from "../tiles/chunkNodes.js";
import { findFragments } from "../fragments/findFragments.js";
import { findFacets } from "../facets/findFacets.js";
import { pointNormals } from "../ops/normals.js";
import { openTiles } from "../tiles/TileStore.js";
import { REGION_JOBS } from "../tiles/regionJobs.js";

// node:worker_threads is named at run time so browser bundlers leave it alone
var NODE_WORKER_THREADS = ["node", "worker_threads"].join(":");

var port = null;
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
	port = { post: function (m, t) { self.postMessage(m, t); } };
	self.onmessage = function (e) { handle(e.data); };
} else {
	var wt = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_WORKER_THREADS);
	port = { post: function (m, t) { wt.parentPort.postMessage(m, t); } };
	wt.parentPort.on("message", handle);
}
port.post({ ready: true });                    // the pool waits for this before sending work

// The decoder and the compressor, each made once per VLR + record length
function cache(make) {
	var key = null, made = null;
	return function (m) {
		var k = JSON.stringify(m.vlr) + "/" + m.recordLength;
		if (key !== k) { made = make(m.vlr, m.recordLength); key = k; }
		return made;
	};
}
var decoder = cache(createChunkDecoder), compressor = cache(createChunkCompressor);

function handle(m) {
	try {
		if (m.op === "compress") compress(m);
		else if (m.op === "octree") octree(m);
		else if (m.op === "fragments") fragments(m);
		else if (m.op === "facets") facets(m);
		else if (REGION_JOBS[m.op]) region(m);
		else decode(m);
	} catch (err) {
		port.post({ id: m.id, error: { code: err && err.code, message: err && err.message ? err.message : String(err), offset: err && err.offset } });
	}
}

function compress(m) {
	var one = compressor(m), records = new Uint8Array(m.records);
	var chunks = [], p = 0, total = 0;
	for (var i = 0; i < m.counts.length; i++) {
		chunks.push(one(records, p, m.counts[i]));
		p += m.counts[i] * m.recordLength;
		total += chunks[i].length;
	}
	var out = new Uint8Array(total), o = 0;
	chunks.forEach(function (c) { out.set(c, o); o += c.length; });
	port.post({ id: m.id, chunks: out.buffer, sizes: chunks.map(function (c) { return c.length; }) }, [out.buffer]);
}

function octree(m) {
	var nodes = chunkNodes(new Uint8Array(m.records), m.recordLength, m.cube, m.rootKey, m.opts, m.laz || null);
	var out = nodes.map(function (n) {
		var r = n.records, whole = r.byteOffset === 0 && r.byteLength === r.buffer.byteLength;
		return { key: n.key, count: n.count, records: whole ? r.buffer : r.slice().buffer, packed: n.packed, box: n.box };
	});
	port.post({ id: m.id, nodes: out }, out.map(function (n) { return n.records; }));
}

// a tile's options with its own normals (cut from the whole cloud's), when it was given them
function withNormals(m) {
	var o = Object.assign({}, m.opts, { onProgress: tileProgress(m, 0, 1) });
	if (m.normal) o.normals = { normal: new Float32Array(m.normal), residual: new Float32Array(m.residual) };
	return o;
}
// a tile's progress as a share (from + span x done), posted at most every 2 %
function tileProgress(m, from, span) {
	var last = -1;
	return function (d, t) { var f = from + span * (t ? d / t : 1); if (f - last >= 0.02 || f >= 1) { last = f; port.post({ id: m.id, progress: f }); } };
}

// one tile of findFragmentsParallel: the result without its fragment column (sent as a buffer) or its facets
function fragments(m) {
	var A = m.f32 ? Float32Array : Float64Array;
	var r = findFragments({ count: m.count, x: new A(m.x), y: new A(m.y), z: new A(m.z) }, withNormals(m));
	var fragment = r.fragment.buffer;
	r.fragment = null; r.facets = null;
	port.post({ id: m.id, result: r, fragment: fragment }, [fragment]);
}

// one tile of findFacetsParallel: the result with its facet column sent as a buffer
function facets(m) {
	var A = m.f32 ? Float32Array : Float64Array;
	var cols = { count: m.count, x: new A(m.x), y: new A(m.y), z: new A(m.z) }, o = withNormals(m), nm = null;
	if (m.keepNormals && !o.normals) {
		// the normals made here, to hand back (the slowest stage: half the progress)
		nm = pointNormals(cols, { k: o.k || 16, maxDistance: o.maxDistance, onProgress: tileProgress(m, 0, 0.5) });
		o.normals = nm; o.onProgress = tileProgress(m, 0.5, 0.5);
	}
	var r = findFacets(cols, o);
	var facet = r.facet.buffer, out = { id: m.id, result: r, facet: facet }, transfer = [facet];
	r.facet = null;
	if (nm) { out.normal = nm.normal.buffer; out.residual = nm.residual.buffer; transfer.push(out.normal, out.residual); }
	port.post(out, transfer);
}

// one work tile of a parallel run on a tile store: the store opened here, once a run (a run after an
// edit opens the edited store), read on this thread (no pool inside a worker)
var runStore = { run: null, store: null };
function storeFor(m) {
	if (runStore.run !== m.run) {
		if (runStore.store) runStore.store.then(function (s) { s.close(); }, function () {});
		runStore = { run: m.run, store: openTiles(m.where) };
	}
	return runStore.store;
}
function region(m) {
	storeFor(m).then(function (store) {
		var t = Object.assign({}, m.task, { onProgress: tileProgress(m, 0, 1) });
		return REGION_JOBS[m.op](store, t);
	}).then(function (out) {
		var transfer = [out.node.buffer, out.index.buffer];
		if (out.gid || out.fid) transfer.push((out.gid || out.fid).buffer);
		if (out.x && out.x.buffer && !out.kept) transfer.push(out.x.buffer, out.y.buffer, out.z.buffer);
		if (out.value) transfer.push(out.value.buffer);
		if (out.core) transfer.push(out.core.buffer);
		if (out.win) transfer.push(out.win.hit.buffer, out.win.held.buffer);
		port.post({ id: m.id, result: out }, transfer);
	}, function (err) {
		port.post({ id: m.id, error: { code: err && err.code, message: err && err.message ? err.message : String(err), offset: err && err.offset } });
	});
}

function decode(m) {
	var dec = decoder(m);
	var bytes = new Uint8Array(m.packed);
	var total = m.chunks.reduce(function (s, c) { return s + c.count; }, 0);
	var out = new ArrayBuffer(total * m.recordLength);
	var view = new DataView(out), o = 0;
	for (var i = 0; i < m.chunks.length; i++) {
		var c = m.chunks[i];
		dec(bytes, c.s, c.e, c.count, view, o, m.base);
		o += c.count * m.recordLength;
	}
	port.post({ id: m.id, records: out }, [out]);
}
