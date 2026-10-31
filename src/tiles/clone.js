// src/tiles/clone.js
//==========================================================
// cloneStore: a copy of a tile store in another place (memory, OPFS,
// a folder): its node files as they are (packed or raw, with their
// added columns), its source header and EVLRs, then the manifest,
// last, so a copy cut short is an unfinished store that the next
// opening removes. Nothing is decoded. The copy runs in the source's
// edit queue (no edit on this thread lands half-way through it) and
// is refused when the store changed in another tab or worker before
// it ended. Abort or any error removes the partial copy.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { openBackend } from "./backends.js";
import { readManifest, writeManifest } from "./manifest.js";
import { TileStore, tileName, HEAD_NAME, EVLRS_NAME } from "./TileStore.js";
import { roomFor } from "./build.js";
import { queued } from "./edit.js";
import { compareKeys as keyOrder } from "./octree.js";

var PUTS = 32;   // files copied at once (OPFS spends about 2 ms creating a file whatever its size: more in flight hides the waits)

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function aborted(signal) { if (signal && signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "the copy was stopped"); }

function samePlace(a, b) {
	if (a.memory !== undefined || b.memory !== undefined) return a.memory === b.memory;
	if (a.opfs !== undefined || b.opfs !== undefined) return a.opfs === b.opfs && (a.root || null) === (b.root || null);
	return a.dir !== undefined && b.dir !== undefined && String(a.dir).replace(/[\\/]+$/, "") === String(b.dir).replace(/[\\/]+$/, "");
}

/**
 * Copy a tile store to another place.
 * @param {object} store - a TileStore
 * @param {object} where - { memory: Map } | { opfs: id, root? } | { dir: path }
 * @param {{replace?: boolean, signal?: AbortSignal, onProgress?: function({phase: string, done: number, total: number})}} [opts]
 *   replace: a store already there is removed first (else refused); onProgress phase "clone", done and total in files
 * @returns {Promise<TileStore>} the copy, open
 * @throws {LasError} INVALID_ARGUMENT (the same place, a store already there), BAD_STORE (the source changed
 *   elsewhere, a file missing), NO_SPACE, ABORTED
 */
export function cloneStore(store, where, opts) {
	opts = opts || {};
	if (!store || !store.manifest || !store._backend) return Promise.reject(bad("cloneStore needs a TileStore (buildTiles or openTiles)"));
	if (!where || typeof where !== "object") return Promise.reject(bad("cloneStore needs a where: { memory: new Map() }, { opfs: id } or { dir: path }"));
	if (opts.onProgress !== undefined && typeof opts.onProgress !== "function") return Promise.reject(bad("onProgress must be a function"));
	if (samePlace(where, store.where || {})) return Promise.reject(bad("cloneStore needs another where than the store's own"));
	return queued(store, function () { return copy(store, where, opts); });
}

async function copy(store, where, opts) {
	var signal = opts.signal, m = JSON.parse(JSON.stringify(store.manifest)), src = store._backend;
	delete m.snapshots;   // the copy is the store as it is: the files a snapshot keeps are not copied
	await roomFor(where, m.bytes, store.count);
	var target = await openBackend(where);
	var existing = await readManifest(target);
	if (existing && !opts.replace) throw bad("a tile store already exists at that where; pass replace: true to replace it");
	await target.lock();
	if (existing) {
		await target.removeAll();
		await target.lock();
	}
	try {
		var names = [HEAD_NAME, EVLRS_NAME].concat(Object.keys(m.nodes).sort(keyOrder).map(function (k) { return tileName(k, m.nodes[k].gen); }));
		var done = 0, total = names.length;
		var one = async function (name) {
			var bytes = await src.get(name);
			if (!bytes) {
				if (name === EVLRS_NAME) return;   // a store with no EVLR blob
				throw new LasError(ERROR_CODES.BAD_STORE, "the tile store has lost " + name + " (changed in another tab or worker?); open it again");
			}
			await target.put(name, bytes, { flush: false });   // the manifest, last, is flushed; a cut-short copy is removed
		};
		for (var i = 0; i < names.length; i += PUTS) {
			aborted(signal);
			await Promise.all(names.slice(i, i + PUTS).map(one));
			done = Math.min(total, i + PUTS);
			if (opts.onProgress) opts.onProgress({ phase: "clone", done: done, total: total });
		}
		aborted(signal);   // a stop that came with the last file
		var now = await readManifest(src);
		if (!now || now.seq !== store._seq) throw new LasError(ERROR_CODES.BAD_STORE, "the tile store changed in another tab or worker during the copy; open it again and copy it then");
		var seq = await writeManifest(target, m);
		var copyOf = new TileStore(target, m, store._head, store.evlrs, seq);
		target.unlock();
		return copyOf;
	} catch (err) {
		await target.removeAll();
		throw err;
	}
}
