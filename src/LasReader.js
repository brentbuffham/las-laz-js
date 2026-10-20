// src/LasReader.js
//==========================================================
// openLas(source) -> LasReader. Opening reads only the header and
// the VLRs; points are read later in windows of whole records
// (default 64 MiB), so a file far larger than memory streams
// through and is never held whole — Kirra's current import reads
// the whole file into one ArrayBuffer; this does not.
//
// Sources: a File / Blob, an ArrayBuffer / Uint8Array, a Node file
// path, or any async source { size, read(start, end) }.
//==========================================================

import { LasError, ERROR_CODES } from "./errors.js";
import { BlobSource } from "./io/BlobSource.js";
import { MemorySource } from "./io/MemorySource.js";
import { NodeFileSource } from "./io/NodeFileSource.js";
import { parseHeader } from "./format/LasHeader.js";
import { parseVlrs, parseEvlrs } from "./format/LasVlr.js";
import { parseCrs } from "./format/LasCrs.js";
import { decodeRecords, resolveFields } from "./read/decodeRecords.js";
import { windows } from "./read/windows.js";
import { makeKeep, strideFor } from "./filter/filters.js";
import { dedupe } from "./filter/dedupe.js";
import { openScratchSyncWriter } from "./io/ScratchBinaryFile.js";

var DEFAULT_WINDOW = 64 * 1024 * 1024;

function memorySource(bytes) {
	return { size: bytes.length, read: async function (a, b) {
		if (b > bytes.length) throw new LasError(ERROR_CODES.TRUNCATED, "read past end of " + bytes.length + "-byte buffer", b);
		return bytes.subarray(a, b);
	} };
}

async function toSource(source) {
	if (source instanceof Uint8Array) return memorySource(source);
	if (source instanceof ArrayBuffer) return memorySource(new Uint8Array(source));
	if (typeof source === "string") return NodeFileSource.open(source);
	if (source && typeof source.slice === "function" && typeof source.size === "number" && typeof source.read !== "function") return new BlobSource(source);
	if (source && typeof source.size === "number" && typeof source.read === "function") return source;
	throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "openLas needs a File / Blob, ArrayBuffer, Uint8Array, file path or { size, read } source");
}

/**
 * Open a LAS (or LAZ) file and read its header and VLRs.
 * @param {*} source
 * @param {{windowSize?: number}} [opts]
 * @returns {Promise<LasReader>}
 */
export async function openLas(source, opts) {
	var src = await toSource(source);
	var headBytes = await src.read(0, Math.min(src.size, 375));
	var header = parseHeader(new MemorySource(headBytes));
	var vlrs = [];
	if (header.numberOfVlrs > 0) {
		var vlrEnd = Math.min(header.offsetToPointData, src.size);
		var vlrBytes = await src.read(0, vlrEnd);
		vlrs = parseVlrs(new MemorySource(vlrBytes), header.headerSize, header.numberOfVlrs, vlrEnd);
	}
	var evlrs = [];
	if (header.numberOfEvlrs > 0 && header.evlrStart > 0 && header.evlrStart < src.size) {
		var evBytes = await src.read(header.evlrStart, src.size);
		evlrs = parseEvlrs(new MemorySource(evBytes), 0, header.numberOfEvlrs).map(function (e) {
			return Object.assign({}, e, { start: e.start + header.evlrStart });
		});
	}
	return new LasReader(src, header, vlrs, evlrs, (opts && opts.windowSize) || DEFAULT_WINDOW);
}

/**
 * A LAS file opened for reading. Create with openLas().
 */
export function LasReader(src, header, vlrs, evlrs, windowSize) {
	this._src = src;
	this._windowSize = windowSize;
	/** Public header. */
	this.header = header;
	/** Variable length records. */
	this.vlrs = vlrs;
	/** Extended variable length records (LAS 1.4). */
	this.evlrs = evlrs;
	/** Declared coordinate system (never reprojected). */
	this.crs = parseCrs(vlrs.concat(evlrs));
	/** True for LAZ (compressed points). */
	this.compressed = header.compressed;
}

LasReader.prototype._check = function () {
	var h = this.header;
	if (h.compressed) {
		throw new LasError(ERROR_CODES.COMPRESSED_LAZ, "this file is LAZ (compressed); reading LAZ points is supported from las-laz-js 0.2.0");
	}
	var end = h.offsetToPointData + h.pointCount * h.recordLength;
	if (end > this._src.size) {
		throw new LasError(ERROR_CODES.TRUNCATED, "the header promises " + h.pointCount + " points ending at byte " + end + " but the file is " + this._src.size + " bytes", this._src.size);
	}
};

/**
 * Iterate the selected points window by window.
 * @param {object} [opts] - fields, classes, returns, bounds, maxPoints, localOrigin, float32, onProgress, signal
 * @returns {AsyncGenerator<object>} PointColumns per window
 */
LasReader.prototype.chunks = async function* (opts) {
	opts = opts || {};
	if (opts.dedupe) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "dedupe needs every point at once: use readPoints, not chunks");
	this._check();
	var h = this.header;
	var keep = makeKeep(opts, h);
	var stride = strideFor(h.pointCount, opts.maxPoints);
	var cap = opts.maxPoints > 0 ? opts.maxPoints : Infinity;
	var fields = resolveFields(h, opts.fields);
	var list = windows(h, this._windowSize);
	var kept = 0;
	for (var w = 0; w < list.length && kept < cap; w++) {
		if (opts.signal && opts.signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "read aborted");
		var win = list[w];
		var bytes = await this._src.read(win.start, win.end);
		var cols = decodeRecords(bytes, h, { fields: fields, keep: keep, stride: stride, firstIndex: win.firstRecord, localOrigin: opts.localOrigin, float32: opts.float32 });
		if (kept + cols.count > cap) cols = trim(cols, fields, cap - kept);
		kept += cols.count;
		if (typeof opts.onProgress === "function") opts.onProgress(kept >= cap ? 1 : (w + 1) / list.length, "read " + kept + " points");
		yield cols;
	}
	if (opts.signal && opts.signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "read aborted");
};

function trim(cols, fields, n) {
	var out = { count: n };
	fields.forEach(function (f) { out[f] = cols[f].slice(0, n); });
	return out;
}

/**
 * Read the selected points into one set of columns.
 * @param {object} [opts] - chunks() options plus dedupe (tolerance) and dedupeZ
 * @returns {Promise<object>} PointColumns plus bounds and stats
 */
LasReader.prototype.readPoints = async function (opts) {
	opts = opts || {};
	var h = this.header;
	var chunkOpts = Object.assign({}, opts);
	delete chunkOpts.dedupe;
	var fields = resolveFields(h, opts.fields);
	var acc = null, n = 0;
	for await (var c of this.chunks(chunkOpts)) {
		if (!acc) {
			acc = {};
			var guess = Math.max(c.count, 1024);
			fields.forEach(function (f) { acc[f] = new c[f].constructor(guess); });
		}
		if (n + c.count > acc[fields[0]].length) {
			var size = Math.max(n + c.count, acc[fields[0]].length * 2);
			fields.forEach(function (f) { var g = new acc[f].constructor(size); g.set(acc[f].subarray(0, n)); acc[f] = g; });
		}
		for (var i = 0; i < fields.length; i++) acc[fields[i]].set(c[fields[i]], n);
		n += c.count;
	}
	var out = { count: n };
	fields.forEach(function (f) { out[f] = acc ? acc[f].slice(0, n) : new Float64Array(0); });
	if (opts.dedupe) out = dedupe(out, opts.dedupe, { z: !!opts.dedupeZ });
	out.bounds = boundsOf(out, opts.localOrigin);
	out.stats = statsOf(out);
	return out;
};

function emptyBounds() { return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }; }

// Grow raw (stored-value) bounds over one set of columns
function extendBounds(b, c) {
	for (var i = 0; i < c.count; i++) {
		var x = c.x[i], y = c.y ? c.y[i] : 0, z = c.z ? c.z[i] : 0;
		if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
		if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
		if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
	}
	return b;
}

// Raw bounds -> world bounds (origin added back), to the stored precision
function worldBounds(b, origin) {
	if (!(b.minX <= b.maxX)) return null;
	var ox = origin && isFinite(origin.x) ? origin.x : 0;
	var oy = origin && isFinite(origin.y) ? origin.y : 0;
	var oz = origin && isFinite(origin.z) ? origin.z : 0;
	var r = function (v) { return Math.round(v * 1e6) / 1e6; };
	return { minX: r(b.minX + ox), maxX: r(b.maxX + ox), minY: r(b.minY + oy), maxY: r(b.maxY + oy), minZ: r(b.minZ + oz), maxZ: r(b.maxZ + oz) };
}

function boundsOf(c, origin) {
	if (!c.x || !c.count) return null;
	return worldBounds(extendBounds(emptyBounds(), c), origin);
}

function statsOf(c) {
	var s = { count: c.count };
	if (c.classification) {
		var counts = {};
		for (var i = 0; i < c.count; i++) { var k = c.classification[i]; counts[k] = (counts[k] || 0) + 1; }
		s.classCounts = counts;
	}
	return s;
}

/**
 * Read the selected points straight into OPFS scratch files — one per
 * field, raw little-endian typed-array bytes — for selections too big
 * for memory (browser, in a worker: OPFS sync handles are worker-only).
 * @param {object} [opts] - chunks() options plus root / dir (OPFS) and prefix (file names)
 * @returns {Promise<{count:number, fields:Object<string,string>, types:Object<string,string>, bounds:object}>}
 */
LasReader.prototype.readPointsToScratch = async function (opts) {
	opts = opts || {};
	var fields = resolveFields(this.header, opts.fields);
	var prefix = opts.prefix || ("las-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
	var where = { root: opts.root, dir: opts.dir };
	var writers = {}, ids = {}, types = {};
	for (var f = 0; f < fields.length; f++) {
		ids[fields[f]] = prefix + "-" + fields[f];
		writers[fields[f]] = await openScratchSyncWriter(ids[fields[f]], where);
	}
	var count = 0, b = emptyBounds();
	try {
		for await (var c of this.chunks(opts)) {
			fields.forEach(function (name) {
				var col = c[name];
				types[name] = col.constructor.name;
				writers[name].write(new Uint8Array(col.buffer, col.byteOffset, col.byteLength));
			});
			if (c.x) extendBounds(b, c);
			count += c.count;
		}
	} finally {
		fields.forEach(function (name) { writers[name].close(); });
	}
	return { count: count, fields: ids, types: types, bounds: worldBounds(b, opts.localOrigin) };
};

/** Close the underlying file (Node). */
LasReader.prototype.close = async function () {
	if (this._src && typeof this._src.close === "function") await this._src.close();
};
