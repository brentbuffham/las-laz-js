// src/laz/pool.js
//==========================================================
// A pool of workers that decode LAZ chunks in parallel (chunks are
// independent, so N cores decode about N times as fast). Browser module
// Workers or Node worker_threads, running src/laz/chunkWorker.js. Tasks
// queue and go to the next free worker; results come back as transferred
// buffers. close() terminates every worker and fails what is still
// queued, so nothing outlives a read. When workers cannot start (no
// Worker, a blocked script), createLazPool returns null and the reader
// decodes on its own thread.
//
// Uses the chunk decoder translated from laz-rs (https://github.com/laz-rs/laz-rs),
// itself a port of LASzip by rapidlasso. (c) 2007-2015 martin isenburg,
// rapidlasso; (c) 2019-2023 Thomas Montaigu.
// Licensed under the Apache License, Version 2.0 (see LICENSE-APACHE and
// NOTICE). Changes: written in JavaScript as a worker pool, Brent Buffham 2026.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

var NODE_WORKER_THREADS = ["node", "worker_threads"].join(":");
var NODE_OS = ["node", "os"].join(":");
var MAX_THREADS = 16;

/**
 * How many decode workers to use by default: one fewer than the cores, at most 16.
 * @returns {Promise<number>}
 */
export async function defaultThreads() {
	var cores = 1;
	if (typeof navigator !== "undefined" && navigator.hardwareConcurrency) cores = navigator.hardwareConcurrency;
	else {
		try {
			var os = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_OS);
			cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
		} catch (e) { cores = 1; }
	}
	return Math.max(1, Math.min(MAX_THREADS, cores - 1));
}

// One worker, browser or Node, behind the same small interface
async function spawn(onMessage, onFail) {
	var url = new URL("./chunkWorker.js", import.meta.url);
	if (typeof Worker === "function") {
		var w = new Worker(url, { type: "module" });
		w.onmessage = function (e) { onMessage(e.data); };
		w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); onFail(new Error(e && e.message ? e.message : "LAZ worker failed")); };
		return { post: function (m, t) { w.postMessage(m, t); }, close: function () { w.terminate(); } };
	}
	var wt = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_WORKER_THREADS);
	var nw = new wt.Worker(url);
	nw.unref();                                  // a forgotten pool never keeps Node running
	nw.on("message", onMessage);
	nw.on("error", onFail);
	return { post: function (m, t) { nw.postMessage(m, t); }, close: function () { return nw.terminate(); } };
}

/**
 * @param {number} n - workers to start (2 or more)
 * @returns {Promise<{size:number, decode:function(object): Promise<Uint8Array>, close:function(): void}|null>}
 */
export async function createLazPool(n) {
	var workers = [], idle = [], queue = [], waiting = new Map(), nextId = 1, closed = false;

	function fail(err) {
		// a worker that dies takes the pool with it: every waiting task fails
		var e = err instanceof LasError ? err : new LasError(ERROR_CODES.UNSUPPORTED, "a LAZ decode worker failed: " + (err && err.message ? err.message : String(err)));
		waiting.forEach(function (job) { job.reject(e); });
		waiting.clear();
		queue.forEach(function (job) { job.reject(e); });
		queue = [];
	}

	function pump() {
		while (idle.length && queue.length) {
			var w = idle.pop(), job = queue.shift();
			job.worker = w;
			waiting.set(job.msg.id, job);
			w.post(job.msg, [job.msg.packed]);
		}
	}

	function onMessage(m) {
		var job = waiting.get(m.id);
		if (!job) return;
		waiting.delete(m.id);
		idle.push(job.worker);
		if (m.error) job.reject(new LasError(m.error.code || ERROR_CODES.UNSUPPORTED, m.error.message, m.error.offset));
		else job.resolve(new Uint8Array(m.records));
		pump();
	}

	try {
		for (var i = 0; i < n; i++) workers.push(await spawn(onMessage, fail));
	} catch (e) {
		workers.forEach(function (w) { w.close(); });
		return null;
	}
	idle = workers.slice();

	return {
		size: n,
		/**
		 * Decode chunks from their own copy of the compressed bytes.
		 * @param {{vlr:object, recordLength:number, packed:ArrayBuffer, chunks:Array, base:number}} task
		 * @returns {Promise<Uint8Array>} the chunks' raw LAS records, in order
		 */
		decode: function (task) {
			if (closed) return Promise.reject(new LasError(ERROR_CODES.ABORTED, "the LAZ decode pool is closed"));
			return new Promise(function (resolve, reject) {
				queue.push({ msg: Object.assign({ id: nextId++ }, task), resolve: resolve, reject: reject });
				pump();
			});
		},
		close: function () {
			if (closed) return;
			closed = true;
			fail(new LasError(ERROR_CODES.ABORTED, "the read stopped"));
			workers.forEach(function (w) { w.close(); });
		}
	};
}
