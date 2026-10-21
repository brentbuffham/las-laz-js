// src/laz/chunkWorker.js
//==========================================================
// Worker entry for parallel LAZ decoding (src/laz/pool.js): decodes
// whole chunks into raw LAS records and sends them back (transferred).
// Runs as a browser module Worker or a Node worker_threads Worker.
// In:  { id, vlr, recordLength, packed: ArrayBuffer, chunks: [{ s, e, count }], base }
//      (s / e index into packed; base is packed's file offset)
// Out: { ready: true } once listening, then per task
//      { id, records: ArrayBuffer } or { id, error: { code, message, offset } }
//
// Uses the chunk decoder translated from laz-rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2015 martin isenburg,
// rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: written in JavaScript as a worker entry, Brent Buffham 2026.
//==========================================================

import { createChunkDecoder } from "./decompressChunk.js";

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

var cached = { key: null, decode: null };

function handle(m) {
	try {
		var key = JSON.stringify(m.vlr) + "/" + m.recordLength;
		if (cached.key !== key) cached = { key: key, decode: createChunkDecoder(m.vlr, m.recordLength) };
		var bytes = new Uint8Array(m.packed);
		var total = m.chunks.reduce(function (s, c) { return s + c.count; }, 0);
		var out = new ArrayBuffer(total * m.recordLength);
		var view = new DataView(out), o = 0;
		for (var i = 0; i < m.chunks.length; i++) {
			var c = m.chunks[i];
			cached.decode(bytes, c.s, c.e, c.count, view, o, m.base);
			o += c.count * m.recordLength;
		}
		port.post({ id: m.id, records: out }, [out]);
	} catch (err) {
		port.post({ id: m.id, error: { code: err && err.code, message: err && err.message ? err.message : String(err), offset: err && err.offset } });
	}
}
