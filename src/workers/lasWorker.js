// src/workers/lasWorker.js
//==========================================================
// Module Worker entry, exported as "las-laz-js/worker":
//   new Worker(new URL("las-laz-js/worker", import.meta.url), { type: "module" })
// Speaks the protocol in workerProtocol.js. Inside a Worker it is the
// natural home for readPointsToScratch, which needs sync OPFS access,
// and keeps multi-GB reads off the page's main thread.
// Importing it outside a Worker does nothing.
//==========================================================

import { createWorkerHandler } from "./workerProtocol.js";

if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
	var handle = createWorkerHandler(function (msg, transfer) { self.postMessage(msg, transfer || []); });
	self.onmessage = function (event) { handle(event.data); };
}
