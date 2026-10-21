// src/laz/pool.js
//==========================================================
// A pool of workers that decode and compress LAZ chunks in parallel
// (chunks are independent, so N cores do about N times the work).
// Browser module Workers or Node worker_threads, running
// src/laz/chunkWorker.js. Tasks queue and go to the next free worker;
// their buffers go there, and the results come back, transferred.
// close() terminates every worker and fails what is still queued, so
// nothing outlives a read or a write. When workers cannot start (no
// Worker, a blocked or failing script), createLazPool returns null and
// the reader or writer works on its own thread.
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
 * How many LAZ workers to use by default: one fewer than the cores, at most 16.
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

// Node worker options: the parent's flags are inherited, except --input-type
// (node --input-type=module -e passes it on, and a worker has no string input
// for it). Only then is execArgv given: an explicit one is checked flag by
// flag, and some parents (the test runner) hold flags a worker may not take.
function nodeWorkerOptions(argv) {
	var isInputType = function (a, i) { return /^--input-type(=|$)/.test(a) || argv[i - 1] === "--input-type"; };
	if (!argv.some(isInputType)) return undefined;
	return { execArgv: argv.filter(function (a, i) { return !isInputType(a, i); }) };
}

// One worker, browser or Node, behind the same small interface. Resolves once
// the worker says it is ready; rejects if it fails or exits first (a blocked
// or broken script), so a pool that cannot start is known before any task.
async function spawn(onMessage, onFail, nodeUrl) {
	var started = false, ready, failed;
	var up = new Promise(function (res, rej) { ready = res; failed = rej; });
	function message(m) { if (m && m.ready) { started = true; ready(); } else onMessage(m); }
	function error(e) { if (started) onFail(e); else failed(e); }
	var handle;
	if (typeof Worker === "function") {
		// written inline so bundlers (Vite, webpack 5) see the worker and emit it
		var w = new Worker(new URL("./chunkWorker.js", import.meta.url), { type: "module" });
		w.onmessage = function (e) { message(e.data); };
		w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); error(new Error(e && e.message ? e.message : "LAZ worker failed")); };
		handle = { post: function (m, t) { w.postMessage(m, t); }, close: function () { w.terminate(); } };
	} else {
		var wt = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_WORKER_THREADS);
		var nw = new wt.Worker(nodeUrl || new URL("./chunkWorker.js", import.meta.url), nodeWorkerOptions(process.execArgv));
		nw.on("message", message);
		nw.on("error", error);
		nw.on("exit", function (code) { if (!started) failed(new Error("LAZ worker exited (" + code + ") before it started")); });
		// Node runs while a worker has a task and not while it is idle, so a forgotten
		// pool never keeps it running (unref after the "message" listener, which refs again)
		handle = { post: function (m, t) { nw.postMessage(m, t); }, close: function () { return nw.terminate(); }, hold: function () { nw.ref(); }, release: function () { nw.unref(); } };
	}
	try { await up; } catch (e) { handle.close(); throw e; }
	if (handle.release) handle.release();
	return handle;
}

/**
 * @param {number} n - workers to start (2 or more)
 * @param {URL} [nodeUrl] - a Node worker entry in place of chunkWorker.js (tests)
 * @returns {Promise<{size:number, decode:function(object): Promise<Uint8Array>, compress:function(object): Promise<{bytes:Uint8Array, sizes:number[]}>, close:function(): void}|null>}
 */
export async function createLazPool(n, nodeUrl) {
	var workers = [], idle = [], queue = [], waiting = new Map(), nextId = 1, closed = false;

	function fail(err) {
		// a worker that dies takes the pool with it: every waiting task fails
		var e = err instanceof LasError ? err : new LasError(ERROR_CODES.UNSUPPORTED, "a LAZ worker failed: " + (err && err.message ? err.message : String(err)));
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
			if (w.hold) w.hold();
			w.post(job.msg, job.transfer);
		}
	}

	function onMessage(m) {
		var job = waiting.get(m.id);
		if (!job) return;
		waiting.delete(m.id);
		if (job.worker.release) job.worker.release();
		idle.push(job.worker);
		if (m.error) job.reject(new LasError(m.error.code || ERROR_CODES.UNSUPPORTED, m.error.message, m.error.offset));
		else job.resolve(job.result(m));
		pump();
	}

	var starts = [];
	for (var i = 0; i < n; i++) starts.push(spawn(onMessage, fail, nodeUrl));
	var settled = await Promise.allSettled(starts);
	workers = settled.filter(function (s) { return s.status === "fulfilled"; }).map(function (s) { return s.value; });
	if (workers.length < n) {
		// any worker that cannot start means the reader decodes on its own thread
		workers.forEach(function (w) { w.close(); });
		return null;
	}
	idle = workers.slice();

	function run(msg, transfer, result) {
		if (closed) return Promise.reject(new LasError(ERROR_CODES.ABORTED, "the LAZ pool is closed"));
		return new Promise(function (resolve, reject) {
			queue.push({ msg: Object.assign({ id: nextId++ }, msg), transfer: transfer, result: result, resolve: resolve, reject: reject });
			pump();
		});
	}

	return {
		size: n,
		/**
		 * Decode chunks from their own copy of the compressed bytes.
		 * @param {{vlr:object, recordLength:number, packed:ArrayBuffer, chunks:Array, base:number}} task
		 * @returns {Promise<Uint8Array>} the chunks' raw LAS records, in order
		 */
		decode: function (task) {
			return run(task, [task.packed], function (m) { return new Uint8Array(m.records); });
		},
		/**
		 * Compress whole chunks from their own copy of the raw records (transferred).
		 * @param {{vlr:object, recordLength:number, records:ArrayBuffer, counts:number[]}} task
		 *   counts: each chunk's points, the chunks back to back from the start of records
		 * @returns {Promise<{bytes:Uint8Array, sizes:number[]}>} the chunks, back to back, and each one's length
		 */
		compress: function (task) {
			return run(Object.assign({ op: "compress" }, task), [task.records], function (m) { return { bytes: new Uint8Array(m.chunks), sizes: m.sizes }; });
		},
		close: function () {
			if (closed) return;
			closed = true;
			fail(new LasError(ERROR_CODES.ABORTED, "the LAZ pool was closed"));
			workers.forEach(function (w) { w.close(); });
		}
	};
}
