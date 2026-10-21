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
// Out: { ready: true } once listening, then per task
//      decode { id, records: ArrayBuffer }, compress { id, chunks: ArrayBuffer, sizes: number[] }
//      (the chunks back to back, and each one's length), or { id, error: { code, message, offset } }
//
// Uses the chunk decoder translated from laz-rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2015 martin isenburg,
// rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: written in JavaScript as a worker entry, Brent Buffham 2026.
//==========================================================

import { createChunkDecoder } from "./decompressChunk.js";
import { createChunkCompressor } from "./compressChunk.js";

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
