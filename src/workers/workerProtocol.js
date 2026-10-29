// src/workers/workerProtocol.js
//==========================================================
// Message protocol behind the las-laz-js/worker entry, kept free of
// Worker globals so it can be driven directly (tests, custom hosts).
// Same shape as ecw-js's.
// In:  { id, type, payload }
//   open                { blob | bytes, windowSize? } -> { header, vlrs, evlrs, crs, classNames, extraBytes,
//                                                        extraBytesProblem, compressed, laz }
//   readPoints          readPoints options + colour?  -> PointColumns (+ colours)
//   chunks              chunks options + colour?      -> streams { id, type: "chunk", chunk } per
//                                                        window, then result { count }; colours
//                                                        follow one rule for the whole stream
//                                                        (createChunkColourizer; with a transform the
//                                                        elevation range is the Z range of the 8 corners
//                                                        of the header box after it)
//   readPointsToScratch readPointsToScratch options   -> { count, fields, types, bounds }
//   colourize           { points, by, ramp?, range? } -> Uint8Array
//   abort               { id }                        -> cancels that job (it rejects ABORTED)
//   close                                             -> closes the reader
// Tile stores (one open store per handler; each change returns the manifest, so the main
// thread runs selectTiles on its own copy):
//   buildTiles          { where, ...buildTiles opts } -> { manifest, count } (from the open file;
//                                                        progress posts { phase, done, total })
//   openTiles           { where }                     -> { manifest, count }
//   readTiles           { keys, fields?, localOrigin?, float32?, threads? }
//                                                     -> streams { id, type: "tile", key, points },
//                                                        then result { count }
//   selectBox           { box }                       -> a tile selection { deletes, count, tiles }
//   selectPolygon       { polygon, options? }         -> a tile selection
//   selectClasses       { classes }                   -> a tile selection
//   deletePoints / keepPoints { selection }           -> { removed, manifest }
//   setColumn           { selection, name, value }    -> { manifest }
//   addColumn           { name, type, fill? }         -> { manifest }
//   removeColumn        { name }                      -> { manifest }
//   transform           { transform: { m, t } }       -> { manifest }
//   findDoubleLayer    { cell, minGap, ...selectDoubleLayerStore opts } -> { count, stats, tiles, threads } (kept in the Worker)
//   classifyDoubleLayer { value }                     -> { manifest } (the found points' class)
//   snapDoubleLayer     { mode?, blend? }             -> { moved, batches, manifest } (the found points moved)
//   writeTiles          { scratchId, root?, dir?, ...writeLas opts } -> { scratchId, count }
//                                                        (an OPFS scratch file: getScratchFile)
//   closeTiles                                        -> { closed: true }
// Out: { id, type: "progress", fraction, label } while a job runs, then
//      { id, type: "result", result } or { id, type: "error", code, message }.
// Column buffers are transferred, not copied. One open file per handler.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { openLas } from "../LasReader.js";
import { colourize, createChunkColourizer } from "../colour/colourize.js";
import { checkTransform, transformBounds } from "../ops/transform.js";
import { buildTiles } from "../tiles/build.js";
import { openTiles } from "../tiles/TileStore.js";
import { openScratchSyncWriter } from "../io/ScratchBinaryFile.js";
import { selectDoubleLayerStore, snapToLayerStore } from "../tiles/storeOps.js";

function buffersOf(cols) {
	var out = [];
	Object.keys(cols).forEach(function (k) { if (ArrayBuffer.isView(cols[k])) out.push(cols[k].buffer); });
	return out;
}

/**
 * @param {function(object, Transferable[]=): void} post - postMessage-like sink.
 * @returns {function({id:*, type:string, payload?:object}): Promise<void>} message handler;
 *   its promise settles once the job's final message is posted
 */
export function createWorkerHandler(post) {
	var reader = null, store = null, doubleFound = null;   // doubleFound: the last findDoubleLayer, until the store changes
	var jobs = new Map();

	function needStore() {
		if (!store) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "no tile store is open; send \"buildTiles\" or \"openTiles\" first");
		return store;
	}

	function opened(s) {
		if (store && store !== s) store.close();
		store = s;
		return { result: { manifest: s.manifest, count: s.count } };
	}

	function selection(sel) {
		var transfer = Object.keys(sel.tiles).map(function (k) { return sel.tiles[k].buffer; });
		return { result: sel, transfer: transfer };
	}

	function changed(extra) { doubleFound = null; return { result: Object.assign({ manifest: store.manifest }, extra || {}) }; }

	function needDouble() {
		if (!doubleFound) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "no double layer is found for this store; send \"findDoubleLayer\" first (an edit clears it)");
		return doubleFound;
	}

	function needReader() {
		if (!reader) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "no LAS file is open; send \"open\" first");
		return reader;
	}

	// The fields a colour mode reads, added to an explicit field list
	var COLOUR_FIELDS = { rgb: ["red", "green", "blue"], elevation: ["z"], intensity: ["intensity"], classification: ["classification"] };

	function readOptions(id, payload, controller) {
		var o = Object.assign({}, payload, {
			signal: controller.signal,
			onProgress: function (fraction, label) { post({ id: id, type: "progress", fraction: fraction, label: label }); }
		});
		delete o.colour;
		if (payload.colour && Array.isArray(o.fields)) {
			(COLOUR_FIELDS[payload.colour.by] || []).forEach(function (f) { if (o.fields.indexOf(f) < 0) o.fields = o.fields.concat([f]); });
		}
		return o;
	}

	function withColour(cols, colour) {
		if (colour) cols.colours = colourize(cols, colour);
		return cols;
	}

	var handlers = {
		open: async function (id, payload) {
			if (reader) await reader.close();
			reader = null;
			reader = await openLas((payload && (payload.blob || payload.bytes)), { windowSize: payload && payload.windowSize });
			return { result: { header: reader.header, vlrs: reader.vlrs, evlrs: reader.evlrs, crs: reader.crs, classNames: reader.classNames, extraBytes: reader.extraBytes, extraBytesProblem: reader.extraBytesProblem, compressed: reader.compressed, laz: reader.laz } };
		},
		readPoints: async function (id, payload, controller) {
			var cols = withColour(await needReader().readPoints(readOptions(id, payload, controller)), payload && payload.colour);
			return { result: cols, transfer: buffersOf(cols) };
		},
		chunks: async function (id, payload, controller) {
			var count = 0, r = needReader();
			// with a transform, the default elevation range is the Z of the transformed header box
			var hb = r.header.bounds;
			if (payload.colour && payload.transform && hb) hb = transformBounds(checkTransform(payload.transform, "transform"), hb);
			var paint = payload.colour ? createChunkColourizer(payload.colour, hb, payload.localOrigin) : null;
			for await (var c of r.chunks(readOptions(id, payload, controller))) {
				if (paint) c.colours = paint(c);
				count += c.count;
				post({ id: id, type: "chunk", chunk: c }, buffersOf(c));
			}
			return { result: { count: count } };
		},
		readPointsToScratch: async function (id, payload, controller) {
			return { result: await needReader().readPointsToScratch(readOptions(id, payload, controller)) };
		},
		colourize: async function (id, payload) {
			var colours = colourize(payload.points, payload);
			return { result: colours, transfer: [colours.buffer] };
		},
		abort: async function (id, payload) {
			var job = jobs.get(payload && payload.id);
			if (job) job.abort();
			return { result: { aborted: !!job } };
		},
		close: async function () {
			if (reader) await reader.close();
			reader = null;
			return { result: { closed: true } };
		},
		buildTiles: async function (id, payload, controller) {
			var o = Object.assign({}, payload, {
				signal: controller.signal,
				onProgress: function (p) { post({ id: id, type: "progress", phase: p.phase, done: p.done, total: p.total, fraction: p.total ? p.done / p.total : 1, label: p.phase }); }
			});
			return opened(await buildTiles(needReader(), o));
		},
		openTiles: async function (id, payload) { return opened(await openTiles(payload.where)); },
		readTiles: async function (id, payload) {
			var count = 0;
			for await (var t of needStore().readTiles(payload.keys || [], payload)) {
				count += t.points.count;
				post({ id: id, type: "tile", key: t.key, points: t.points }, buffersOf(t.points));
			}
			return { result: { count: count } };
		},
		selectBox: async function (id, payload) { return selection(await needStore().selectBox(payload.box)); },
		selectPolygon: async function (id, payload) { return selection(await needStore().selectPolygon(payload.polygon, payload.options)); },
		selectClasses: async function (id, payload) { return selection(await needStore().selectClasses(payload.classes)); },
		deletePoints: async function (id, payload) { return changed(await needStore().deletePoints(payload.selection)); },
		keepPoints: async function (id, payload) { return changed(await needStore().keepPoints(payload.selection)); },
		setColumn: async function (id, payload) { await needStore().setColumn(payload.selection, payload.name, payload.value); return changed(); },
		addColumn: async function (id, payload) { await needStore().addColumn(payload.name, payload.type, payload.fill); return changed(); },
		removeColumn: async function (id, payload) { await needStore().removeColumn(payload.name); return changed(); },
		transform: async function (id, payload) { await needStore().transform(payload.transform); return changed(); },
		findDoubleLayer: async function (id, payload, controller) {
			var o = Object.assign({}, payload, {
				signal: controller.signal,
				onProgress: function (done, total) { post({ id: id, type: "progress", fraction: total ? done / total : 1, label: "double layer" }); }
			});
			doubleFound = await selectDoubleLayerStore(needStore(), o);
			return { result: { count: doubleFound.count, stats: doubleFound.stats, tiles: doubleFound.tiles, threads: doubleFound.threads, partner: !!doubleFound.partner } };
		},
		classifyDoubleLayer: async function (id, payload) {
			var found = needDouble();
			await needStore().setColumn(found.selection, "classification", payload.value);
			var keep = doubleFound;   // a class does not move an index
			var out = changed();
			doubleFound = keep;
			return out;
		},
		snapDoubleLayer: async function (id, payload) {
			var r = await snapToLayerStore(needStore(), needDouble(), payload);
			return changed({ moved: r.moved, batches: r.batches });
		},
		writeTiles: async function (id, payload) {
			var s = needStore(), o = Object.assign({}, payload);
			if (typeof o.scratchId !== "string" || !o.scratchId) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "writeTiles needs a scratchId (the OPFS scratch file to write)");
			var sink = await openScratchSyncWriter(o.scratchId, { root: o.root, dir: o.dir });
			try {
				var r = await s.writeLas(sink, { compress: o.compress, chunkSize: o.chunkSize, threads: o.threads, version: o.version, pointFormat: o.pointFormat });
				return { result: { scratchId: o.scratchId, count: r.count } };
			} finally {
				sink.close();
			}
		},
		closeTiles: async function () {
			if (store) store.close();
			store = null;
			return { result: { closed: true } };
		}
	};

	return async function (msg) {
		var id = msg && msg.id;
		var handler = msg && Object.prototype.hasOwnProperty.call(handlers, msg.type) ? handlers[msg.type] : null;
		if (!handler) {
			post({ id: id, type: "error", code: ERROR_CODES.INVALID_ARGUMENT, message: "unknown message type " + (msg && msg.type) });
			return;
		}
		// Registered before the first await so an "abort" right after can find it
		var controller = new AbortController();
		jobs.set(id, controller);
		try {
			var out = await handler(id, msg.payload || {}, controller);
			post({ id: id, type: "result", result: out.result }, out.transfer || []);
		} catch (err) {
			post({ id: id, type: "error", code: (err && err.code) || "ERROR", message: err && err.message ? err.message : String(err) });
		} finally {
			jobs.delete(id);
		}
	};
}
