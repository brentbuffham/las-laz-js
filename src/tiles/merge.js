// src/tiles/merge.js
//==========================================================
// New tile stores from stored points, never the whole cloud in memory:
// - mergeStores: several stores into one (after alignStores, say);
// - splitStore: a selection of a store into a new store, then (by
//   default) deleted from the source.
// The points stream node by node, in world coordinates (each store's
// transform applied), into a LAS in scratch space (OPFS for an OPFS
// target, a temp file for a folder, memory for a memory store), which
// buildTiles builds into the new store; the scratch goes after. The
// point format holds every source's fields (colour when any has it;
// a field a source lacks is written as its default); the scale is the
// finest; the CRS, class names and extra bytes are the first store's
// (extra bytes only when every source has the same ones). Added
// columns are not carried.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { createLasWriter } from "../write/writeLas.js";
import { chooseScaleOffset } from "../write/scaleOffset.js";
import { recordFields } from "../read/decodeRecords.js";
import { keepPoints } from "../ops/apply.js";
import { openLas } from "../LasReader.js";
import { openScratchSyncWriter, getScratchFile, removeScratchFile } from "../io/ScratchBinaryFile.js";
import { buildTiles } from "./build.js";
import { storeNodes } from "./region.js";

var NODE_FS = ["node", "fs"].join(":"), NODE_OS = ["node", "os"].join(":"), NODE_PATH = ["node", "path"].join(":");
var MIN = ["minX", "minY", "minZ"], MAX = ["maxX", "maxY", "maxZ"];
// point formats by what they hold: [gps time, colour] -> the 1.4 format
var FORMAT = { "false,false": 6, "true,false": 6, "false,true": 7, "true,true": 7 };

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function isStore(x) { return !!x && typeof x === "object" && !!x.manifest && typeof x.readTile === "function"; }
function aborted(signal) { if (signal && signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "the run was stopped"); }

// a scratch LAS beside the target: { sink, open (a LasReader on it, once written), remove }
async function scratch(where) {
	var id = "merge-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ".las";
	if (where.opfs !== undefined) {
		var w = await openScratchSyncWriter(id, where.root ? { root: where.root } : undefined);
		// the writer closed before the file is read or removed (an open sync handle blocks both)
		var shut = false, close = function () { if (!shut) { shut = true; w.close(); } };
		return { sink: w, open: async function () { close(); return openLas(await getScratchFile(id, where.root ? { root: where.root } : undefined)); }, remove: function () { close(); return removeScratchFile(id, where.root ? { root: where.root } : undefined); } };
	}
	if (where.dir !== undefined) {
		var fs = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_FS), os = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_OS), path = await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_PATH);
		var file = path.join(os.tmpdir(), id), fh = await fs.promises.open(file, "w+");
		return { sink: fh, open: async function () { await fh.close(); return openLas(file); }, remove: function () { return fs.promises.rm(file, { force: true }); } };
	}
	// memory: the bytes in an array
	var parts = [], size = 0;
	var sink = { write: function (bytes, position) { parts.push([position, bytes.slice()]); size = Math.max(size, position + bytes.length); } };
	return { sink: sink, open: async function () { var all = new Uint8Array(size); parts.forEach(function (p) { all.set(p[1], p[0]); }); parts = []; return openLas(all); }, remove: async function () {} };
}

// the sources' union: format, scale, offset, the fields to read, extra bytes when shared
function plan(sources) {
	var gps = false, rgb = false, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], scale = { x: Infinity, y: Infinity, z: Infinity };
	sources.forEach(function (s) {
		var f = recordFields(s.store.manifest.pointFormat), sc = s.store.manifest.scale, nodes = storeNodes(s.store.manifest);
		if (f.indexOf("gpsTime") >= 0) gps = true;
		if (f.indexOf("red") >= 0) rgb = true;
		scale = { x: Math.min(scale.x, sc.x), y: Math.min(scale.y, sc.y), z: Math.min(scale.z, sc.z) };
		nodes.boxes.forEach(function (b) { for (var a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b[MIN[a]]); hi[a] = Math.max(hi[a], b[MAX[a]]); } });
	});
	var first = sources[0].store, sig = JSON.stringify(first.extraBytes.map(function (e) { return [e.name, e.type]; }));
	var sameExtra = first.extraBytes.length > 0 && sources.every(function (s) { return JSON.stringify(s.store.extraBytes.map(function (e) { return [e.name, e.type]; })) === sig; });
	var bounds = { minX: lo[0], minY: lo[1], minZ: lo[2], maxX: hi[0], maxY: hi[1], maxZ: hi[2] };
	return { pointFormat: FORMAT[gps + "," + rgb], scale: scale, offset: chooseScaleOffset(bounds).offset, extra: sameExtra ? first.extraBytes : null, first: first };
}

// sources [{ store, sel? }] into a new store at opts.where
async function copyToStore(sources, opts, name) {
	if (!opts || !opts.where) throw bad(name + " needs a where for the new store: { opfs: id }, { dir: path } or { memory: true }");
	var p = plan(sources), sc = await scratch(opts.where), signal = opts.signal, store = null, count = 0, total = 0;
	sources.forEach(function (s) { total += s.sel ? s.sel.count : storeNodes(s.store.manifest).counts.reduce(function (a, b) { return a + b; }, 0); });
	try {
		var crs = p.first.crs && (p.first.crs.wkt || p.first.crs.epsg) ? { wkt: p.first.crs.wkt, epsg: p.first.crs.epsg } : undefined;
		var w = await createLasWriter(sc.sink, { version: "1.4", pointFormat: p.pointFormat, scale: p.scale, offset: p.offset, crs: crs,
			classNames: Object.keys(p.first.classNames || {}).length ? p.first.classNames : undefined, extraBytes: p.extra || undefined });
		for (var i = 0; i < sources.length; i++) {
			var s = sources[i], fields = recordFields(s.store.manifest.pointFormat).concat(p.extra ? ["extra"] : []), nodes = storeNodes(s.store.manifest);
			// the tiles to copy, decoded on the source store's pool a few ahead of the writer (threads: 1 for this thread only)
			var keys = nodes.keys.filter(function (key) { return !s.sel || (s.sel.tiles[key] && s.sel.tiles[key].length); });
			var gen = s.store.readTiles(keys, { fields: fields, threads: opts.threads });
			try {
				for (var got = await gen.next(); !got.done; got = await gen.next()) {
					aborted(signal);
					var pts = got.value.points, pick = s.sel ? s.sel.tiles[got.value.key] : null;
					if (pick) pts = keepPoints(pts, pick);
					await w.writePoints(pts);
					count += pts.count;
					if (opts.onProgress) opts.onProgress(count, 2 * total);   // the copy is half the work, the build the rest
				}
			} finally {
				await gen.return();
			}
		}
		await w.close();
		aborted(signal);
		var las = await sc.open();
		store = await buildTiles(las, { where: opts.where, compress: opts.compress, tilePoints: opts.tilePoints, threads: opts.threads, signal: signal, replace: opts.replace, name: opts.name,
			onProgress: opts.onProgress ? function (q) { opts.onProgress(total + (q.total ? total * q.done / q.total : 0) / 3 + (q.phase === "distribute" ? total / 3 : q.phase === "tiles" ? 2 * total / 3 : 0), 2 * total); } : undefined });
		if (las.close) await las.close();
		return store;
	} finally {
		try { await sc.remove(); } catch (e) { /* gone already */ }
	}
}

/**
 * Merge tile stores into a new one.
 * @param {object[]} stores - open TileStores (each one's transform applied).
 * @param {{where: object, compress?: boolean, tilePoints?: number, threads?: number, replace?: boolean, name?: string,
 *   onProgress?: function(number, number), signal?: AbortSignal}} opts - where: the new store's (buildTiles' options).
 * @returns {Promise<object>} the new TileStore
 */
export async function mergeStores(stores, opts) {
	if (!Array.isArray(stores) || stores.length < 1 || !stores.every(isStore)) throw bad("mergeStores needs an array of open tile stores");
	return copyToStore(stores.map(function (s) { return { store: s }; }), opts, "mergeStores");
}

/**
 * A selection of a tile store into a new store, then (by default) deleted from it.
 * @param {object} store - an open TileStore.
 * @param {object} sel - a selection of it (store.selectPolygon, selectBox, …).
 * @param {object} opts - as mergeStores, and keep (true: the points stay in the source too).
 * @returns {Promise<object>} the new TileStore
 */
export async function splitStore(store, sel, opts) {
	if (!isStore(store)) throw bad("splitStore needs an open tile store");
	if (!sel || !sel.tiles || sel.deletes !== store.manifest.deletes) throw bad("splitStore needs a current selection of the store (store.selectPolygon, selectBox, …)");
	var out = await copyToStore([{ store: store, sel: sel }], opts || {}, "splitStore");
	if (!(opts && opts.keep) && sel.count) await store.deletePoints(sel);
	return out;
}
