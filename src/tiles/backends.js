// src/tiles/backends.js
//==========================================================
// Where a tile store's blobs live. Three backends behind one small
// interface (get, put, appender, remove, list, removeAll, lock):
//   { memory: true | Map } - a Map of name -> bytes (gone with the page)
//   { opfs: id, root? }    - OPFS folder las-tiles/<id>, through
//                            ScratchBinaryFile (writes need a Worker:
//                            sync access handles); root for tests
//   { dir: path }          - a Node folder
// A name may hold one "/" (build/<key>.rec): a sub-folder.
// "lock" is the OPFS writer's lock file and is never listed.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { openScratchSyncWriter, getScratchFile, removeScratchFile } from "../io/ScratchBinaryFile.js";

/** The OPFS folder holding every tile store. */
export var TILES_DIR = "las-tiles";

var LOCK = "lock";
var LOCKED_ERRORS = ["NoModificationAllowedError", "InvalidModificationError"];
var NODE_FS = ["node", "fs"].join(":");

function badWhere() { return new LasError(ERROR_CODES.INVALID_ARGUMENT, "where must be { memory }, { opfs: id } or { dir: path }"); }

function split(name) {
	var i = name.lastIndexOf("/");
	return i < 0 ? ["", name] : [name.slice(0, i), name.slice(i + 1)];
}

/**
 * Open the backend a `where` names. Nothing is created until something is written.
 * @param {object} where - { memory: true | Map } | { opfs: id, root?: directory handle } | { dir: path }
 * @returns {Promise<object>} { kind, where, get, put, appender, remove, list, removeAll, lock, unlock }
 * @throws {LasError} INVALID_ARGUMENT for anything else
 */
export async function openBackend(where) {
	if (!where || typeof where !== "object") throw badWhere();
	if (where.memory !== undefined) {
		if (where.memory === true) return memoryBackend(new Map());
		if (where.memory instanceof Map) return memoryBackend(where.memory);
		throw badWhere();
	}
	if (where.opfs !== undefined) {
		if (typeof where.opfs !== "string" || !where.opfs || /[/\\]/.test(where.opfs)) throw badWhere();
		return opfsBackend(where);
	}
	if (where.dir !== undefined) {
		if (typeof where.dir !== "string" || !where.dir) throw badWhere();
		return dirBackend(where, await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_FS));
	}
	throw badWhere();
}

function memoryBackend(map) {
	return {
		kind: "memory",
		where: { memory: map },
		get: async function (name) { return map.has(name) ? map.get(name) : null; },
		put: async function (name, bytes) { map.set(name, bytes.slice()); },
		appender: async function (name) {
			var parts = [], total = 0;
			return {
				write: function (bytes) { if (bytes.length) { parts.push(bytes.slice()); total += bytes.length; } },
				close: async function () {
					var all = new Uint8Array(total), o = 0;
					parts.forEach(function (p) { all.set(p, o); o += p.length; });
					map.set(name, all);
				}
			};
		},
		remove: async function (name) { map.delete(name); },
		list: async function () { return Array.from(map.keys()).sort(); },
		removeAll: async function () { map.clear(); },
		lock: async function () {},
		unlock: function () {}
	};
}

// OPFS writes go through sync access handles, which only a Worker has
function needWorker(err) {
	if (err instanceof TypeError) return new LasError(ERROR_CODES.UNSUPPORTED, "writing a tile store in OPFS needs a Worker (synchronous file access)");
	return err;
}

async function folder(root, path, create) {
	var dir = root || await navigator.storage.getDirectory();
	var segs = path.split("/");
	for (var i = 0; i < segs.length; i++) if (segs[i]) dir = await dir.getDirectoryHandle(segs[i], { create: create });
	return dir;
}

function opfsBackend(where) {
	var base = TILES_DIR + "/" + where.opfs, held = null;
	function opts(sub) { return { root: where.root, dir: sub ? base + "/" + sub : base }; }
	function missing(e) { return e && e.name === "NotFoundError"; }
	async function names(dir, prefix, out) {
		for await (var h of dir.values()) {
			if (h.kind === "directory") await names(h, prefix + h.name + "/", out);
			else if (prefix || h.name !== LOCK) out.push(prefix + h.name);
		}
		return out;
	}
	return {
		kind: "opfs",
		where: where,
		get: async function (name) {
			var p = split(name);
			try {
				var file = await getScratchFile(p[1], opts(p[0]));
				return new Uint8Array(await file.arrayBuffer());
			} catch (e) {
				if (missing(e)) return null;
				throw e;
			}
		},
		put: async function (name, bytes) {
			var p = split(name), w;
			try { w = await openScratchSyncWriter(p[1], opts(p[0])); } catch (e) { throw needWorker(e); }
			try { w.write(bytes); } finally { w.close(); }
		},
		appender: async function (name) {
			var p = split(name), w;
			try { w = await openScratchSyncWriter(p[1], opts(p[0])); } catch (e) { throw needWorker(e); }
			return { write: function (bytes) { if (bytes.length) w.write(bytes); }, close: async function () { w.close(); } };
		},
		remove: async function (name) { var p = split(name); await removeScratchFile(p[1], opts(p[0])); },
		list: async function () {
			try { return (await names(await folder(where.root, base, false), "", [])).sort(); } catch (e) { if (missing(e)) return []; throw e; }
		},
		removeAll: async function () {
			this.unlock();
			try {
				var parent = await folder(where.root, TILES_DIR, false);
				await parent.removeEntry(where.opfs, { recursive: true });
			} catch (e) { if (!missing(e)) throw e; }
		},
		lock: async function () {
			if (held) return;
			var dir = await folder(where.root, base, true);
			var fh = await dir.getFileHandle(LOCK, { create: true });
			try { held = await fh.createSyncAccessHandle(); } catch (e) {
				if (e && LOCKED_ERRORS.indexOf(e.name) >= 0) throw new LasError(ERROR_CODES.BAD_STORE, "store " + where.opfs + " is open for writing in another tab or worker");
				throw needWorker(e);
			}
		},
		unlock: function () { if (held) { held.close(); held = null; } }
	};
}

function dirBackend(where, fs) {
	var base = where.dir.replace(/[/\\]+$/, "");
	function full(name) { return base + "/" + name; }
	function missing(e) { return e && e.code === "ENOENT"; }
	function parentOf(name) { var p = split(name); return p[0] ? full(p[0]) : base; }
	function names(dir, prefix, out) {
		fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
			if (d.isDirectory()) names(dir + "/" + d.name, prefix + d.name + "/", out);
			else out.push(prefix + d.name);
		});
		return out;
	}
	return {
		kind: "dir",
		where: where,
		get: async function (name) {
			try { var b = await fs.promises.readFile(full(name)); return new Uint8Array(b.buffer, b.byteOffset, b.length); } catch (e) { if (missing(e)) return null; throw e; }
		},
		put: async function (name, bytes) {
			await fs.promises.mkdir(parentOf(name), { recursive: true });
			await fs.promises.writeFile(full(name), bytes);
		},
		appender: async function (name) {
			await fs.promises.mkdir(parentOf(name), { recursive: true });
			var fd = fs.openSync(full(name), "w");
			return { write: function (bytes) { if (bytes.length) fs.writeSync(fd, bytes); }, close: async function () { fs.closeSync(fd); } };
		},
		remove: async function (name) { try { await fs.promises.unlink(full(name)); } catch (e) { if (!missing(e)) throw e; } },
		list: async function () { try { return names(base, "", []).sort(); } catch (e) { if (missing(e)) return []; throw e; } },
		removeAll: async function () { await fs.promises.rm(base, { recursive: true, force: true }); },
		lock: async function () {},
		unlock: function () {}
	};
}
