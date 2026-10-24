// test/helpers/tileStores.js
//==========================================================
// Runs a store test on every backend: memory (a Map), OPFS (the
// in-memory fake root) and a Node temp folder (removed after).
// eachBackend(title, fn) registers one test per backend, calling
// fn(where, kind) with a fresh `where` each time.
//==========================================================
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeRoot } from "./fakeOpfs.js";

var serial = 0;

/** A fresh `where` for a backend kind, and a cleanup. */
export function makeWhere(kind) {
	serial++;
	if (kind === "memory") return { where: { memory: new Map() }, done: function () {} };
	if (kind === "opfs") return { where: { opfs: "t" + serial, root: createFakeRoot("root") }, done: function () {} };
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), "las-tiles-"));
	return { where: { dir: dir }, done: function () { fs.rmSync(dir, { recursive: true, force: true }); } };
}

export var BACKEND_KINDS = ["memory", "opfs", "dir"];

/** Register one test per backend kind. */
export function eachBackend(title, fn) {
	BACKEND_KINDS.forEach(function (kind) {
		test(title + " [" + kind + "]", async function () {
			var w = makeWhere(kind);
			try { await fn(w.where, kind); } finally { w.done(); }
		});
	});
}
