// src/workers/workerProtocol.js
//==========================================================
// Message protocol behind the las-laz-js/worker entry, kept free of
// Worker globals so it can be driven directly (tests, custom hosts).
// Same shape as ecw-js's.
// In:  { id, type, payload }
//   open                { blob | bytes, windowSize? } -> { header, vlrs, evlrs, crs, classNames, compressed, laz }
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
// Out: { id, type: "progress", fraction, label } while a job runs, then
//      { id, type: "result", result } or { id, type: "error", code, message }.
// Column buffers are transferred, not copied. One open file per handler.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { openLas } from "../LasReader.js";
import { colourize, createChunkColourizer } from "../colour/colourize.js";
import { checkTransform, transformBounds } from "../ops/transform.js";

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
	var reader = null;
	var jobs = new Map();

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
			return { result: { header: reader.header, vlrs: reader.vlrs, evlrs: reader.evlrs, crs: reader.crs, classNames: reader.classNames, compressed: reader.compressed, laz: reader.laz } };
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
