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
import { decodeRecords, resolveFields, columnType } from "./read/decodeRecords.js";
import { windows, lazWindows } from "./read/windows.js";
import { findLazVlr } from "./laz/LazVlr.js";
import { readChunks } from "./laz/chunkTable.js";
import { createChunkDecoder } from "./laz/decompressChunk.js";
import { makeKeep, countKept } from "./filter/filters.js";
import { dedupe } from "./filter/dedupe.js";
import { openScratchSyncWriter } from "./io/ScratchBinaryFile.js";

var DEFAULT_WINDOW = 64 * 1024 * 1024;

function memorySource(bytes) {
	return { size: bytes.length, read: async function (a, b) {
		if (b > bytes.length) throw new LasError(ERROR_CODES.TRUNCATED, "read past end of " + bytes.length + "-byte buffer", b);
		return bytes.subarray(a, b);
	} };
}

// A caller's own { size, read } source: every read must hand back exactly
// the bytes asked for, or a short read would silently drop points
function checkedSource(src) {
	function check(got, a, b) {
		if (got instanceof ArrayBuffer) got = new Uint8Array(got);
		if (!(got instanceof Uint8Array)) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "source.read(" + a + ", " + b + ") must return a Uint8Array or ArrayBuffer");
		if (got.length !== b - a) throw new LasError(ERROR_CODES.TRUNCATED, "source.read(" + a + ", " + b + ") returned " + got.length + " bytes, not " + (b - a), a + Math.min(got.length, b - a));
		return got;
	}
	var out = { size: src.size, read: async function (a, b) { return check(await src.read(a, b), a, b); } };
	if (typeof src.readInto === "function") out.readInto = async function (a, b, t) { return check(await src.readInto(a, b, t), a, b); };
	if (typeof src.close === "function") out.close = function () { return src.close(); };
	return out;
}

async function toSource(source) {
	if (source instanceof Uint8Array) return memorySource(source);
	if (source instanceof ArrayBuffer) return memorySource(new Uint8Array(source));
	if (typeof source === "string") return NodeFileSource.open(source);
	if (source && typeof source.slice === "function" && typeof source.size === "number" && typeof source.read !== "function") return new BlobSource(source);
	if (source && typeof source.size === "number" && typeof source.read === "function") return checkedSource(source);
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
		evlrs = await walkEvlrs(src, header.evlrStart, header.numberOfEvlrs);
	}
	return new LasReader(src, header, vlrs, evlrs, (opts && opts.windowSize) || DEFAULT_WINDOW);
}

// EVLRs sit after the points and can be huge (waveform data): read each
// 60-byte header, keep the bytes of small and coordinate-system records,
// and leave the rest on disk for readEvlrBytes.
var EVLR_EAGER = 65536;
async function walkEvlrs(src, start, count) {
	var out = [], pos = start;
	for (var i = 0; i < count; i++) {
		if (pos + 60 > src.size) throw new LasError(ERROR_CODES.BAD_VLR, "EVLR " + (i + 1) + " starts past the end of the file", pos);
		var e = parseEvlrs(new MemorySource(await src.read(pos, pos + 60)), 0, 1, true)[0];
		if (pos + 60 + e.length > src.size) throw new LasError(ERROR_CODES.BAD_VLR, "EVLR " + (i + 1) + " runs past the end of the file", pos);
		e.start = pos + 60;
		e.bytes = e.length <= EVLR_EAGER || e.userId === "LASF_Projection" ? new Uint8Array(await src.read(e.start, e.start + e.length)) : null;
		out.push(e);
		pos += 60 + e.length;
	}
	return out;
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
	/** The parsed LASzip VLR of a LAZ file (compressor, chunk size, items), else null. */
	this.laz = null;
	if (header.compressed) { try { this.laz = findLazVlr(vlrs); } catch (e) { this.laz = null; } }   // a bad VLR fails on read, not open
}

// How to read this file's points: the windows, and how to turn one into raw
// LAS records (a LAS window is read as it is; a LAZ window is a run of whole
// chunks, decompressed into the scan's buffer). Built once per reader.
LasReader.prototype._plan = async function () {
	if (this._planned) return this._planned;
	var h = this.header, src = this._src, len = h.recordLength;
	var plan;
	if (!h.compressed) {
		var end = h.offsetToPointData + h.pointCount * len;
		if (end > src.size) {
			throw new LasError(ERROR_CODES.TRUNCATED, "the header promises " + h.pointCount + " points ending at byte " + end + " but the file is " + src.size + " bytes", src.size);
		}
		var list = windows(h, this._windowSize);
		plan = {
			list: list,
			// a source that can fill one reused buffer gets one (no bytes outlive a window)
			bufferSize: typeof src.readInto === "function" && list.length ? list[0].end - list[0].start : 0,
			records: function (win, buf) { return buf ? src.readInto(win.start, win.end, buf) : src.read(win.start, win.end); }
		};
	} else {
		var vlr = findLazVlr(this.vlrs);
		if (!vlr) throw new LasError(ERROR_CODES.BAD_VLR, "this LAZ file has no LASzip VLR (user \"laszip encoded\", record 22204), so its points cannot be decompressed");
		var decode = createChunkDecoder(vlr, len);
		var lazList = lazWindows(await readChunks(src, h, vlr), len, this._windowSize);
		plan = {
			list: lazList,
			bufferSize: lazList.reduce(function (m, w) { return Math.max(m, w.count * len); }, 0),
			records: async function (win, buf) {
				var packed = await src.read(win.start, win.end);
				var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
				win.chunks.forEach(function (c) { decode(packed, c.start - win.start, c.end - win.start, c.count, view, (c.firstRecord - win.firstRecord) * len, win.start); });
				return buf.subarray(0, win.count * len);
			}
		};
	}
	this._planned = plan;
	return plan;
};

/**
 * Iterate the selected points window by window.
 * @param {object} [opts] - fields, classes, returns, bounds, maxPoints, localOrigin, float32, onProgress, signal
 * @returns {AsyncGenerator<object>} PointColumns per window
 */
LasReader.prototype.chunks = async function* (opts) {
	opts = opts || {};
	if (opts.dedupe) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "dedupe needs every point at once: use readPoints, not chunks");
	yield* this._scan(opts, null);
};

// The window loop behind chunks and readPoints. into(win, n) -> { cols, at }
// makes decodeRecords write straight into readPoints' result columns.
LasReader.prototype._scan = async function* (opts, into) {
	var h = this.header;
	var plan = await this._plan();
	var keep = makeKeep(opts, h);
	var fields = resolveFields(h, opts.fields);
	var list = plan.list;
	var buf = plan.bufferSize ? new Uint8Array(plan.bufferSize) : null;
	var thin = null;
	if (opts.maxPoints > 0) {
		// Thin the points that pass the filters; with filters set, count them first (a second read)
		var passing = keep ? await this._countPassing(plan, buf, keep, opts.signal) : h.pointCount;
		if (passing > opts.maxPoints) thin = { total: passing, target: opts.maxPoints, acc: 0 };
	}
	var kept = 0;
	for (var w = 0; w < list.length; w++) {
		if (opts.signal && opts.signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "read aborted");
		var win = list[w];
		var bytes = await plan.records(win, buf);
		var cols = decodeRecords(bytes, h, { fields: fields, keep: keep, thin: thin, localOrigin: opts.localOrigin, float32: opts.float32, into: into ? into(win) : null });
		kept += cols.count;
		if (typeof opts.onProgress === "function") opts.onProgress((w + 1) / list.length, "read " + kept + " points");
		yield cols;
	}
	if (opts.signal && opts.signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "read aborted");
};

LasReader.prototype._countPassing = async function (plan, buf, keep, signal) {
	var n = 0;
	for (var w = 0; w < plan.list.length; w++) {
		if (signal && signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "read aborted");
		n += countKept(await plan.records(plan.list[w], buf), this.header.recordLength, keep);
	}
	return n;
};

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
	// Allocate once when the count is known (no filters: every point, or
	// maxPoints of them; filters + maxPoints: at most maxPoints), so the
	// peak is the result itself. Filters alone: grow by doubling.
	var filtered = !!makeKeep(opts, h);
	var cap = !filtered ? (opts.maxPoints > 0 ? Math.min(opts.maxPoints, h.pointCount) : h.pointCount)
		: (opts.maxPoints > 0 ? Math.min(opts.maxPoints, h.pointCount) : 0);
	var acc = {}, n = 0;
	fields.forEach(function (f) { acc[f] = new (columnType(f, opts))(cap || 1024); });
	function into(win) {
		// A known cap is never exceeded, so it never grows; filters alone grow by doubling
		if (!cap && n + win.count > acc[fields[0]].length) {
			var size = Math.max(n + win.count, acc[fields[0]].length * 2);
			fields.forEach(function (f) { var g = new acc[f].constructor(size); g.set(acc[f].subarray(0, n)); acc[f] = g; });
		}
		return { cols: acc, at: n };
	}
	for await (var c of this._scan(chunkOpts, into)) n += c.count;
	var out = { count: n };
	fields.forEach(function (f) { out[f] = acc[f].length === n ? acc[f] : acc[f].slice(0, n); });
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

/**
 * The bytes of an EVLR — big ones are not read by openLas (bytes: null).
 * @param {number} index - into reader.evlrs
 * @returns {Promise<Uint8Array>}
 */
LasReader.prototype.readEvlrBytes = async function (index) {
	var e = this.evlrs[index];
	if (!e) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "no EVLR " + index + " (the file has " + this.evlrs.length + ")");
	if (e.bytes) return e.bytes;
	return new Uint8Array(await this._src.read(e.start, e.start + e.length));
};

/** Close the underlying file (Node). */
LasReader.prototype.close = async function () {
	if (this._src && typeof this._src.close === "function") await this._src.close();
};
