// src/tiles/TileStore.js
//==========================================================
// A tile store: an additive octree of LAS records in a backend
// (memory, OPFS, a Node folder), with its manifest. Built by
// buildTiles (build.js); opened again with openTiles. The store keeps
// the source's header and VLR bytes (source.head) and its small EVLRs
// (source.evlrs, JSON) so it parses them as LasReader does: crs,
// classNames, extraBytes.
// Node files are "<key>.<generation>.tile"; blobs no manifest names
// (old generations, build/*) are removed when a store is opened by a
// thread that can take its write lock.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { MemorySource } from "../io/MemorySource.js";
import { parseHeader } from "../format/LasHeader.js";
import { parseVlrs } from "../format/LasVlr.js";
import { parseCrs } from "../format/LasCrs.js";
import { parseClassLookup } from "../format/ClassLookup.js";
import { parseExtraBytes } from "../format/ExtraBytes.js";
import { openBackend, TILES_DIR } from "./backends.js";
import { readManifest, LAYOUT_VERSION } from "./manifest.js";

/** The blob holding the source's header and VLR bytes. */
export var HEAD_NAME = "source.head";
/** The blob holding the source's small EVLRs (JSON). */
export var EVLRS_NAME = "source.evlrs";

/** A node's file name. */
export function tileName(key, gen) { return key + "." + gen + ".tile"; }

function fromBase64(text) {
	var bin = atob(text), out = new Uint8Array(bin.length);
	for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Base64 of bytes (for the EVLR blob). */
export function toBase64(bytes) {
	var s = "";
	for (var i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
	return btoa(s);
}

function describe(where) {
	if (where && where.opfs) return "{ opfs: \"" + where.opfs + "\" }";
	if (where && where.dir) return "{ dir: \"" + where.dir + "\" }";
	return "{ memory }";
}

/**
 * A tile store. Create with buildTiles or openTiles.
 * @param {object} backend - from openBackend
 * @param {object} body - the manifest
 * @param {Uint8Array} head - the source's header and VLR bytes
 * @param {Array} evlrs - the source's small EVLRs ({ userId, recordId, description, bytes })
 * @param {number} seq - the manifest's sequence number (an edit refuses a store changed since)
 */
export function TileStore(backend, body, head, evlrs, seq) {
	this._backend = backend;
	this._seq = seq;
	/** The manifest (plain JSON: post it to another thread for selectTiles). */
	this.manifest = body;
	/** Where the store lives. */
	this.where = backend.where;
	/** The source's header, as LasReader gives it. */
	this.header = parseHeader(new MemorySource(head));
	var vlrs = this.header.numberOfVlrs > 0 ? parseVlrs(new MemorySource(head), this.header.headerSize, this.header.numberOfVlrs, head.length) : [];
	var all = vlrs.concat(evlrs);
	this.vlrs = vlrs;
	this.evlrs = evlrs;
	this.crs = parseCrs(all);
	this.classNames = {};
	try { this.classNames = parseClassLookup(all); } catch (e) { this.classNames = {}; }
	this.extraBytes = parseExtraBytes(all, this.header).fields;
	this._head = head;
}

Object.defineProperty(TileStore.prototype, "count", {
	get: function () {
		var n = 0, nodes = this.manifest.nodes;
		Object.keys(nodes).forEach(function (k) { n += nodes[k].count; });
		return n;
	}
});

/** Release the store's write lock, if this thread holds it, and its tile-decoding workers. */
TileStore.prototype.close = function () {
	this._backend.unlock();
	if (this._pool) { this._pool.close(); this._pool = null; }
};

/**
 * True when the store was built from this source (same size and first 4 KB; name and date
 * too when both sides know them).
 * @param {File|Blob|Uint8Array|ArrayBuffer|string|object} source - a file, bytes, a path or a LasReader
 * @returns {Promise<boolean>}
 */
TileStore.prototype.matches = async function (source) {
	var { openLas } = await import("../LasReader.js");
	var { fingerprint } = await import("./build.js");
	var las;
	try { las = source && source.header && source._src ? source : await openLas(source); } catch (e) { return false; }
	var f = await fingerprint(las), s = this.manifest.source;
	if (las !== source) await las.close();
	if (f.size !== s.size || f.head !== s.head) return false;
	if (f.name && s.name && f.name !== s.name) return false;
	if (f.lastModified !== null && s.lastModified !== null && f.lastModified !== s.lastModified) return false;
	return true;
};

async function loadSource(backend, where) {
	var head = await backend.get(HEAD_NAME);
	if (!head) throw new LasError(ERROR_CODES.BAD_STORE, "the tile store at " + describe(where) + " has lost its source header (" + HEAD_NAME + ")");
	var ev = await backend.get(EVLRS_NAME), evlrs = [];
	if (ev) evlrs = JSON.parse(new TextDecoder().decode(ev)).map(function (e) { return { userId: e.userId, recordId: e.recordId, description: e.description, bytes: fromBase64(e.bytes) }; });
	return { head: head, evlrs: evlrs };
}

// Remove blobs no manifest names, when this thread can take the write lock (a writer
// elsewhere may be mid-edit, its next generation not yet in the manifest). The manifest is read
// again under the lock (an edit may have landed since it was first read); the newest is returned.
async function sweep(backend, m) {
	try { await backend.lock(); } catch (e) { return m; }
	try {
		var now = await readManifest(backend) || m, body = now.body;
		var keep = new Set(["store-a.json", "store-b.json", HEAD_NAME, EVLRS_NAME]);
		Object.keys(body.nodes).forEach(function (k) { keep.add(tileName(k, body.nodes[k].gen)); });
		var names = await backend.list();
		for (var i = 0; i < names.length; i++) if (!keep.has(names[i])) await backend.remove(names[i]);
		return now;
	} finally {
		backend.unlock();
	}
}

/**
 * Open a tile store built earlier (after a reload, too).
 * @param {object} where - { memory: Map } | { opfs: id, root? } | { dir: path }
 * @returns {Promise<TileStore>}
 * @throws {LasError} BAD_STORE when there is no store; UNSUPPORTED for a newer layout
 */
export async function openTiles(where) {
	var backend = await openBackend(where);
	var m = await readManifest(backend);
	if (!m) throw new LasError(ERROR_CODES.BAD_STORE, "no tile store at " + describe(where));
	if (m.body.layout > LAYOUT_VERSION) throw new LasError(ERROR_CODES.UNSUPPORTED, "the tile store at " + describe(where) + " was built by a newer las-laz-js (layout " + m.body.layout + "); rebuild it");
	var src = await loadSource(backend, where);
	m = await sweep(backend, m);
	return new TileStore(backend, m.body, src.head, src.evlrs, m.seq);
}

/**
 * The tile stores in OPFS; unfinished builds (no manifest) are removed.
 * @param {{root?: object}} [opts] - an OPFS directory handle (tests)
 * @returns {Promise<Array<{id: string, points: number, bytes: number, source: object, built: number}>>}
 */
export async function listTiles(opts) {
	var root = (opts && opts.root) || await navigator.storage.getDirectory(), out = [];
	var dir;
	try { dir = await root.getDirectoryHandle(TILES_DIR); } catch (e) { if (e && e.name === "NotFoundError") return out; throw e; }
	var ids = [];
	for await (var h of dir.values()) if (h.kind === "directory") ids.push(h.name);
	ids.sort();
	for (var i = 0; i < ids.length; i++) {
		var backend = await openBackend({ opfs: ids[i], root: opts && opts.root });
		var m = await readManifest(backend);
		if (!m) {
			try { await backend.lock(); await backend.removeAll(); } catch (e) { /* being built elsewhere */ }
			continue;
		}
		var points = 0;
		Object.keys(m.body.nodes).forEach(function (k) { points += m.body.nodes[k].count; });
		out.push({ id: ids[i], points: points, bytes: m.body.bytes, source: m.body.source, built: m.body.built });
	}
	return out;
}

/**
 * Remove a tile store and every file in it.
 * @param {object} where
 * @returns {Promise<void>}
 */
export async function removeTiles(where) {
	var backend = await openBackend(where);
	await backend.removeAll();
}

/**
 * One node as point columns, as readPoints gives them.
 * @param {string} key
 * @param {{fields?: string[], localOrigin?: {x, y, z}, float32?: boolean}} [opts] - fields as
 *   readPoints (standard fields, "extra", the file's extra columns) plus added columns
 * @returns {Promise<object>} PointColumns
 */
TileStore.prototype.readTile = async function (key, opts) {
	var { readTile } = await import("./read.js");
	return readTile(this, key, opts);
};

/**
 * Nodes as point columns, in the order given (LAZ nodes decode on a pool).
 * @param {string[]} keys
 * @param {{fields?, localOrigin?, float32?, threads?: number}} [opts]
 * @returns {AsyncGenerator<{key: string, points: object}>}
 */
TileStore.prototype.readTiles = async function* (keys, opts) {
	var { readTiles } = await import("./read.js");
	yield* readTiles(this, keys, opts);
};

// Edits (src/tiles/edit.js); each runs where the store's blobs are writable (a Worker for OPFS)
function editing(name) {
	return async function () {
		var edit = await import("./edit.js");
		return edit[name].apply(null, [this].concat(Array.prototype.slice.call(arguments)));
	};
}

/**
 * Select points tile by tile: fn(cols, { key, count, box }) returns ascending indices or null.
 * @function
 * @param {function} fn
 * @param {{fields?: string[], box?: object, signal?: AbortSignal, onProgress?: function({phase, done, total}), threads?: number}} [opts] -
 *   fields read (x, y, z); only tiles meeting box; signal and onProgress ({ phase: "select" }, by tile read) as selectBox,
 *   selectPolygon, selectScreen and selectClasses take them too
 * @returns {Promise<{deletes: number, count: number, tiles: object}>} a tile selection
 */
TileStore.prototype.select = editing("select");
/** The points inside a box (world, after the store transform). @function */
TileStore.prototype.selectBox = editing("selectBox");
/** The points inside an XY polygon (selectPolygon's options). @function */
TileStore.prototype.selectPolygon = editing("selectPolygon");
/** The points inside a shape drawn on the screen (selectScreen's rule). @function */
TileStore.prototype.selectScreen = editing("selectScreen");
/** The points of some classes. @function */
TileStore.prototype.selectClasses = editing("selectClasses");
/** Delete the selected points; opts { signal, onProgress } (phase "edit", by tile). @function @returns {Promise<{removed: number}>} */
TileStore.prototype.deletePoints = editing("deletePoints");
/** Keep only the selected points; opts { signal, onProgress } as deletePoints. @function @returns {Promise<{removed: number}>} */
TileStore.prototype.keepPoints = editing("keepPoints");
/** Set a field for the selected points: a value, or { key: typed array }; opts { signal, onProgress } as deletePoints. @function */
TileStore.prototype.setColumn = editing("setColumn");
/** Add a column (name, type "u8" ... "f64", fill) to every point. @function */
TileStore.prototype.addColumn = editing("addColumn");
/** Remove an added column. @function */
TileStore.prototype.removeColumn = editing("removeColumn");
/** Compose a transform ({ m, t }, as makeTransform) onto the store's. @function */
TileStore.prototype.transform = editing("transform");
/** Move points: { key: { index, x, y, z } } in world coordinates (after the store transform); opts { signal, onProgress, threads }. @function */
TileStore.prototype.setPositions = editing("setPositions");
/** Move the selected points by a transform { m, t } (world, after the store transform); opts { signal, onProgress, threads }. @function @returns {Promise<{moved: number}>} */
TileStore.prototype.transformPoints = editing("transformPoints");

/**
 * Write the store as LAS / LAZ, node by node (src/tiles/write.js).
 * @param {object} sink - as createLasWriter: an OPFS scratch writer, a Node FileHandle, or any { write(bytes, position) }
 * @param {{compress?: boolean, chunkSize?: number, threads?: number, version?: string, pointFormat?: number}} [opts]
 * @returns {Promise<{count: number}>}
 */
TileStore.prototype.writeLas = async function (sink, opts) {
	var { writeTilesLas } = await import("./write.js");
	return writeTilesLas(this, sink, opts);
};
