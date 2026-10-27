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

// one tile of findFragmentsParallel: the result without its fragment column (sent as a buffer) or its facets
function fragments(m) {
	var A = m.f32 ? Float32Array : Float64Array;
	var r = findFragments({ count: m.count, x: new A(m.x), y: new A(m.y), z: new A(m.z) }, m.opts);
	var fragment = r.fragment.buffer;
	r.fragment = null; r.facets = null;
	port.post({ id: m.id, result: r, fragment: fragment }, [fragment]);
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
