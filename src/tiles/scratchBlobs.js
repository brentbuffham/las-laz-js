// src/tiles/scratchBlobs.js
//==========================================================
// Scratch blobs beside a tile store, for results that must wait until
// a run's readers are done (a store edit replaces node files, so it
// cannot run while workers still read them): OPFS scratch files for an
// OPFS store, a temp folder for a folder store, a Map for a store in
// memory. Never inside the store: its folder belongs to its manifest.
//==========================================================

import { openScratchSyncWriter, getScratchFile, removeScratchFile } from "../io/ScratchBinaryFile.js";

var NODE_FS = ["node", "fs"].join(":"), NODE_OS = ["node", "os"].join(":"), NODE_PATH = ["node", "path"].join(":");

/**
 * @param {object} where - the store's where.
 * @returns {Promise<{put: function(string, Uint8Array): Promise, get: function(string): Promise<Uint8Array>,
 *   remove: function(string): Promise, close: function(): Promise}>} close removes what is left
 */
export async function scratchBlobs(where) {
	var tag = "blobs-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + "-", names = new Set();
	if (where && where.opfs !== undefined) {
		var o = where.root ? { root: where.root } : undefined;
		return {
			put: async function (name, bytes) { var w = await openScratchSyncWriter(tag + name, o); try { w.write(bytes); } finally { w.close(); } names.add(name); },
			get: async function (name) { return new Uint8Array(await (await getScratchFile(tag + name, o)).arrayBuffer()); },
			remove: async function (name) { names.delete(name); await removeScratchFile(tag + name, o); },
			close: async function () { for (var n of Array.from(names)) await this.remove(n); }
		};
	}
	if (where && where.dir !== undefined) {
		var fs = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_FS), os = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_OS), path = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_PATH);
		var dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "las-laz-js-" + tag));
		return {
			put: function (name, bytes) { return fs.promises.writeFile(path.join(dir, name), bytes); },
			get: async function (name) { var b = await fs.promises.readFile(path.join(dir, name)); return new Uint8Array(b.buffer, b.byteOffset, b.length); },
			remove: function (name) { return fs.promises.rm(path.join(dir, name), { force: true }); },
			close: function () { return fs.promises.rm(dir, { recursive: true, force: true }); }
		};
	}
	var map = new Map();
	return {
		put: async function (name, bytes) { map.set(name, bytes); },
		get: async function (name) { return map.get(name); },
		remove: async function (name) { map.delete(name); },
		close: async function () { map.clear(); }
	};
}
