// src/write/writeLas.js
//==========================================================
// Write LAS 1.0-1.4: writeLas(points, opts) builds a whole file in
// memory; createLasWriter(sink, opts) streams records to a sink
// ({ write(bytes, position) }, e.g. an OPFS sync writer or a Node
// file handle) and patches the header totals on close. Both share
// one header builder, so they produce identical bytes.
//
// With compress: true both write LAZ (point formats 0-3 and 6-8): the same
// records, compressed chunkSize points at a time (LASzip's 50,000 by
// default), after a LASzip VLR; the point data is an 8-byte offset to
// the chunk table, the chunks, then the table — laid out as LAZperf
// (PDAL) writes it. Chunks compress independently, so with threads
// they compress on the LAZ worker pool (src/laz/pool.js), several to a
// task, and are written strictly in chunk order whatever order they
// finish in: the bytes are the same for any thread count.
//
// Ported from Kirra's LASWriter, with two changes: an invalid
// version / format pair is REFUSED (Kirra silently downgraded the
// format), and the coordinate system is written (GeoKey EPSG
// record 34735 and / or a WKT record 2112) — Kirra wrote no VLRs.
//
// extraBytes adds fields after the point format (format/ExtraBytes.js):
// the record grows by their sizes, the Extra Bytes VLR (raw min / max of
// what was written) goes in the header, and LAZ carries them in its
// Byte / Byte14 item.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { POINT_FORMATS } from "../format/PointFormats.js";
import { chooseScaleOffset } from "./scaleOffset.js";
import { encodeRecords, checkExtra } from "./encodeRecords.js";
import { lazVlrFor, LASZIP_USER_ID, LASZIP_RECORD_ID } from "../laz/LazVlr.js";
import { buildClassLookup, CLASS_LOOKUP_USER_ID, CLASS_LOOKUP_RECORD_ID } from "../format/ClassLookup.js";
import { layoutExtraBytes, buildExtraBytes, EXTRA_BYTES_USER_ID, EXTRA_BYTES_RECORD_ID } from "../format/ExtraBytes.js";
import { createChunkCompressor } from "../laz/compressChunk.js";
import { encodeChunkTable } from "../laz/chunkTable.js";
import { createLazPool, defaultThreads } from "../laz/pool.js";

var LE = true;
var HEADER_SIZE = { "1.0": 227, "1.1": 227, "1.2": 227, "1.3": 235, "1.4": 375 };
var DEFAULT_CHUNK_SIZE = 50000;
// 0xFFFFFFFF in the VLR's chunk size field means variable-size chunks
var MAX_CHUNK_SIZE = 4294967294;
// threads, automatic: a pool once a write has this many chunks (as openLas),
// of at most AUTO_MAX_THREADS workers — gains flatten there, while the records
// in flight grow with every worker (an explicit threads is honoured as given)
var AUTO_MIN_CHUNKS = 4;
var AUTO_MAX_THREADS = 4;
// chunks per pool task, and tasks in flight per worker (one working, one queued)
var CHUNKS_PER_TASK = 4;
var TASKS_PER_WORKER = 2;

function ascii(v, pos, text, max) {
	for (var i = 0; i < max; i++) v.setUint8(pos + i, i < text.length ? text.charCodeAt(i) & 0x7F : 0); // bits-ok
}
function setU64(v, pos, value) {
	v.setUint32(pos, value % 4294967296, LE);
	v.setUint32(pos + 4, Math.floor(value / 4294967296), LE);
}

function isGeographic(epsg) { return epsg >= 4000 && epsg < 5000; }

// LAS 1.4 R15: point formats 6-10 carry the CRS as OGC WKT only; GeoTIFF
// keys belong to formats 0-5. The library does not turn an EPSG code into
// WKT (that needs a projection database), so an EPSG-only CRS is refused there.
function crsRecords(crs, fmt) {
	var out = [];
	if (!crs) return out;
	if (fmt >= 6 && !crs.wkt && crs.epsg) {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "point format " + fmt + " must carry its coordinate system as WKT (LAS 1.4); pass crs.wkt — an EPSG code alone is GeoTIFF keys, which formats 6-10 do not allow");
	}
	if (crs.epsg && fmt < 6) {
		var geo = isGeographic(crs.epsg);
		var keys = [[1024, geo ? 2 : 1], [1025, 1], [geo ? 2048 : 3072, crs.epsg]];
		var b = new Uint8Array(8 + keys.length * 8);
		var v = new DataView(b.buffer);
		[1, 1, 0, keys.length].forEach(function (s, i) { v.setUint16(i * 2, s, LE); });
		keys.forEach(function (k, i) { v.setUint16(8 + i * 8, k[0], LE); v.setUint16(8 + i * 8 + 2, 0, LE); v.setUint16(8 + i * 8 + 4, 1, LE); v.setUint16(8 + i * 8 + 6, k[1], LE); });
		out.push({ userId: "LASF_Projection", recordId: 34735, description: "GeoKeyDirectoryTag", bytes: b });
	}
	if (crs.wkt) {
		var w = new Uint8Array(crs.wkt.length + 1);
		for (var i = 0; i < crs.wkt.length; i++) w[i] = crs.wkt.charCodeAt(i) & 0x7F; // bits-ok
		out.push({ userId: "LASF_Projection", recordId: 2112, description: "OGC WKT", bytes: w });
	}
	return out;
}

function settle(points, opts) {
	opts = opts || {};
	if (!points || !(points.x && points.y) || typeof points.count !== "number") {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "writeLas needs point columns with count, x and y");
	}
	var version = opts.version || "1.2";
	if (!HEADER_SIZE[version]) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "LAS version " + version + " is not writable (1.0-1.4)");
	var fmt = opts.pointFormat != null ? opts.pointFormat : (points.red ? 3 : 0);
	if (!(fmt >= 0 && fmt <= 10) || fmt % 1 !== 0) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "point format " + fmt + " does not exist (0-10)");
	var minor = Number(version.split(".")[1]);
	if (fmt >= 6 && minor < 4) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "point format " + fmt + " needs LAS 1.4 (asked for " + version + ")");
	if ((fmt === 4 || fmt === 5) && minor < 3) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "point format " + fmt + " needs LAS 1.3 or later (asked for " + version + ")");
	var classLookup = opts.classNames === undefined ? null : buildClassLookup(opts.classNames);
	var extra = layoutExtraBytes(opts.extraBytes === undefined || opts.extraBytes === null ? [] : opts.extraBytes, POINT_FORMATS[fmt].size);
	return { version: version, minor: minor, fmt: fmt, opts: opts, classLookup: classLookup, extra: extra.fields.length ? extra : null, recordLength: extra.recordLength, laz: lazSetup(fmt, opts, extra.recordLength) };
}

// compress: the LASzip VLR and the chunk compressor. chunkSize is ignored without compress.
function lazSetup(fmt, opts, recordLength) {
	if (!opts.compress) return null;
	var chunkSize = opts.chunkSize == null ? DEFAULT_CHUNK_SIZE : opts.chunkSize;
	if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "chunkSize must be a whole number of points from 1 to " + MAX_CHUNK_SIZE + " (got " + chunkSize + ")");
	}
	var len = recordLength;
	var made = lazVlrFor(fmt, len, chunkSize);   // UNSUPPORTED for formats 4, 5, 9, 10
	return { chunkSize: chunkSize, vlr: made.vlr, vlrBytes: made.bytes, compress: createChunkCompressor(made.vlr, len) };
}

// extra: per extra-bytes field, the raw { min, max } written so far (null: none yet)
function freshTotals(s) {
	return { count: 0, byReturn: new Array(15).fill(0), bounds: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }, extra: s.extra ? s.extra.fields.map(function () { return null; }) : null };
}

// Header + VLR bytes for the given totals
function headerBytes(s, so, totals) {
	var o = s.opts;
	var headerSize = HEADER_SIZE[s.version];
	var vlrs = crsRecords(o.crs, s.fmt);
	if (s.classLookup) vlrs.push({ userId: CLASS_LOOKUP_USER_ID, recordId: CLASS_LOOKUP_RECORD_ID, description: "Classification", bytes: s.classLookup });
	if (s.extra) vlrs.push({ userId: EXTRA_BYTES_USER_ID, recordId: EXTRA_BYTES_RECORD_ID, description: "Extra Bytes", bytes: buildExtraBytes(s.extra, totals.extra) });
	if (s.laz) vlrs.push({ userId: LASZIP_USER_ID, recordId: LASZIP_RECORD_ID, description: "http://laszip.org", bytes: s.laz.vlrBytes });
	var vlrSize = vlrs.reduce(function (n, r) { return n + 54 + r.bytes.length; }, 0);
	var out = new Uint8Array(headerSize + vlrSize);
	var v = new DataView(out.buffer);
	var date = o.date || new Date();
	var yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
	var day = Math.floor((date.getTime() - yearStart) / 86400000) + 1;
	var fmt = POINT_FORMATS[s.fmt];
	var b = totals.count ? totals.bounds : { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };

	ascii(v, 0, "LASF", 4);
	v.setUint16(4, o.fileSourceId || 0, LE);
	v.setUint16(6, (o.globalEncoding || 0) + (o.crs && o.crs.wkt && !((o.globalEncoding || 0) & 16) ? 16 : 0), LE); // bits-ok
	v.setUint8(24, 1);
	v.setUint8(25, s.minor);
	ascii(v, 26, o.systemId || "las-laz-js", 32);
	ascii(v, 58, o.software || "las-laz-js", 32);
	v.setUint16(90, day, LE);
	v.setUint16(92, date.getUTCFullYear(), LE);
	v.setUint16(94, headerSize, LE);
	v.setUint32(96, headerSize + vlrSize, LE);
	v.setUint32(100, vlrs.length, LE);
	v.setUint8(104, s.laz ? s.fmt + 128 : s.fmt);   // bit 7: compressed
	v.setUint16(105, s.recordLength, LE);
	var legacyOk = s.fmt < 6 && totals.count < 4294967296;
	v.setUint32(107, legacyOk ? totals.count : 0, LE);
	for (var i = 0; i < 5; i++) v.setUint32(111 + i * 4, legacyOk ? totals.byReturn[i] : 0, LE);
	v.setFloat64(131, so.scale.x, LE); v.setFloat64(139, so.scale.y, LE); v.setFloat64(147, so.scale.z, LE);
	v.setFloat64(155, so.offset.x, LE); v.setFloat64(163, so.offset.y, LE); v.setFloat64(171, so.offset.z, LE);
	v.setFloat64(179, b.maxX, LE); v.setFloat64(187, b.minX, LE);
	v.setFloat64(195, b.maxY, LE); v.setFloat64(203, b.minY, LE);
	v.setFloat64(211, b.maxZ, LE); v.setFloat64(219, b.minZ, LE);
	if (headerSize >= 235) setU64(v, 227, 0);
	if (headerSize >= 375) {
		setU64(v, 235, 0);
		v.setUint32(243, 0, LE);
		setU64(v, 247, totals.count);
		for (var j = 0; j < 15; j++) setU64(v, 255 + j * 8, totals.byReturn[j]);
	}
	var pos = headerSize;
	vlrs.forEach(function (r) {
		ascii(v, pos + 2, r.userId, 16);
		v.setUint16(pos + 18, r.recordId, LE);
		v.setUint16(pos + 20, r.bytes.length, LE);
		ascii(v, pos + 22, r.description, 32);
		out.set(r.bytes, pos + 54);
		pos += 54 + r.bytes.length;
	});
	return out;
}

function boundsOfPoints(points, origin) {
	var ox = origin && isFinite(origin.x) ? origin.x : 0, oy = origin && isFinite(origin.y) ? origin.y : 0, oz = origin && isFinite(origin.z) ? origin.z : 0;
	var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
	for (var i = 0; i < points.count; i++) {
		var x = points.x[i] + ox, y = points.y[i] + oy, z = (points.z ? points.z[i] : 0) + oz;
		if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
		if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
		if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
	}
	if (!points.count) b = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
	return b;
}

/**
 * Write a whole LAS file, or LAZ with compress: true (point formats 0-3 and 6-8).
 * @param {object} points - PointColumns (world coordinates, or relative to opts.localOrigin)
 * @param {object} [opts] - version, pointFormat, scale, offset, crs {epsg|wkt}, classNames ({ code: name }, written as
 *   the Classification Lookup VLR), software, systemId, date, localOrigin, as ("bytes" | "blob"),
 *   compress (write LAZ), chunkSize (points per LAZ chunk, default 50000; only with compress),
 *   threads (LAZ compression workers: default automatic, from 4 chunks and at most 4 workers; 1 = this thread; n = n workers),
 *   extraBytes (fields after the point format: [{ name, type ("u8" … "f64", "raw"), column?, size? (raw), scale?, offset?,
 *   noData? (raw), description? }], values from points[column || name]; a reader's extraBytes can be passed as they are)
 * @returns {Promise<Uint8Array|Blob>}
 */
export async function writeLas(points, opts) {
	var s = settle(points, opts);
	var o = s.opts;
	var so = (o.scale && o.offset) ? { scale: o.scale, offset: o.offset } : chooseScaleOffset(boundsOfPoints(points, o.localOrigin));
	if (o.scale && !o.offset) so = { scale: o.scale, offset: chooseScaleOffset(boundsOfPoints(points, o.localOrigin)).offset };
	var len = s.recordLength;
	var totals = freshTotals(s);
	if (s.laz) {
		var parts = await lazParts(points, s, so, len, totals);
		return o.as === "blob" ? new Blob(parts, { type: "application/octet-stream" }) : joinParts(parts);
	}
	// One buffer: records are encoded in place after the header, whose
	// size does not depend on the totals; the header is filled in last
	var headLength = headerBytes(s, so, totals).length;
	var out = new Uint8Array(headLength + points.count * len);
	encodeRecords(points, s.fmt, len, so, o.localOrigin, new DataView(out.buffer), headLength, totals, 0, extraFields(s));
	totals.count = points.count;
	out.set(headerBytes(s, so, totals), 0);
	return o.as === "blob" ? new Blob([out], { type: "application/octet-stream" }) : out;
}

function extraFields(s) { return s.extra ? s.extra.fields : null; }

// Columns a..b of a PointColumns (views where the columns are typed arrays); a column of k values
// a point (an extra-bytes raw or array column) is cut at a * k .. b * k
function rangeOf(cols, a, b) {
	if (a === 0 && b === cols.count) return cols;
	var out = { count: b - a };
	for (var k in cols) {
		var c = cols[k];
		if (k === "count" || !c || typeof c.length !== "number") continue;
		var w = cols.count && Number.isInteger(c.length / cols.count) ? c.length / cols.count : 1;
		out[k] = typeof c.subarray === "function" ? c.subarray(a * w, b * w) : c.slice(a * w, b * w);
	}
	return out;
}

function joinParts(parts) {
	var total = parts.reduce(function (n, p) { return n + p.length; }, 0);
	var out = new Uint8Array(total), at = 0;
	parts.forEach(function (p) { out.set(p, at); at += p.length; });
	return out;
}

// The i64 offset to the chunk table (an absolute file position), as two u32 halves
function tableOffsetBytes(tablePos) {
	var b = new Uint8Array(8);
	setU64(new DataView(b.buffer), 0, tablePos);
	return b;
}

// threads as openLas: 0 = automatic
function threadsOf(opts) { return opts.threads > 0 ? Math.floor(opts.threads) : 0; }

// A pool of up to `most` workers (one per chunk at most, when the count is known), or null;
// automatic: at most AUTO_MAX_THREADS
async function startPool(opts, most) {
	var n = Math.min(threadsOf(opts) || Math.min(AUTO_MAX_THREADS, await defaultThreads()), most);
	if (n < 2) return null;
	return opts._createPool ? opts._createPool(n) : createLazPool(n);
}

// The chunk loop both LAZ writers share. Records fill a buffer; each full
// chunk is compressed on this thread, until the poolAt-th full chunk calls
// makePool — from then on chunks go to the pool's workers CHUNKS_PER_TASK
// at a time (or, with no pool, still to this thread). place(bytes) gets
// each task's chunks, back to back, strictly in chunk order: a task that
// finishes early waits for the ones before it. Records are encoded before
// write()'s first await, so calls made without waiting keep their
// order. write() returns once fewer than TASKS_PER_WORKER tasks per
// worker are in flight (on this thread, once its chunks are placed), so
// memory is bounded. Any error — on a worker, on this thread, in place()
// or reported through fail(err) — stops the loop for good and closes the
// pool, as finish() does once it has placed the last chunk; after
// finish() is called, write() refuses more points (ABORTED).
function lazChunks(s, so, len, totals, place, poolAt, makePool) {
	var size = s.laz.chunkSize;
	var buf = new Uint8Array(0), view = null, filled = 0, full = 0;
	var pooled = null, closing = false, failure = null, ended = false;
	var order = Promise.resolve(), inflight = [], chunks = [];

	// grow the buffer to hold n records (doubling; one chunk on this thread, a task's on the pool)
	function room(n) {
		if (buf.length >= n * len) return;
		var most = pooled ? CHUNKS_PER_TASK * size : size;
		var grown = new Uint8Array(Math.max(n, Math.min(most, 2 * buf.length / len)) * len);
		grown.set(buf.subarray(0, filled * len));
		buf = grown;
		view = new DataView(buf.buffer);
	}
	function shut() {
		if (!pooled || closing) return;
		closing = true;
		pooled.then(function (pool) { if (pool) pool.close(); });
	}
	function stop(err) {
		if (!failure) failure = err;
		shut();
	}
	function refuse() {
		if (failure) throw failure;
		if (ended) throw new LasError(ERROR_CODES.ABORTED, "the LAZ writer is closed");
	}
	function onThisThread(records, counts) {
		var parts = [], p = 0;
		counts.forEach(function (n) { parts.push(s.laz.compress(records, p, n)); p += n * len; });
		return { bytes: parts.length === 1 ? parts[0] : joinParts(parts), sizes: parts.map(function (c) { return c.length; }) };
	}
	function submit(records, counts) {
		// on this thread now (its buffer is reused); on the pool from records the task then owns.
		// An error on this thread rejects the task, as a worker's does, so it stops the loop below
		var task;
		if (!pooled) {
			try { task = Promise.resolve(onThisThread(records, counts)); } catch (err) { task = Promise.reject(err); }
		} else {
			task = pooled.then(function (pool) {
				return pool ? pool.compress({ vlr: s.laz.vlr, recordLength: len, records: records.buffer, counts: counts }) : onThisThread(records, counts);
			});
		}
		task.catch(function () {});              // tasks after a failure are never waited for
		var placed = order.then(function () { return task; }).then(function (r) {
			r.sizes.forEach(function (n, i) { chunks.push({ pointCount: counts[i], byteCount: n }); });
			return place(r.bytes);
		});
		placed.catch(stop);
		order = placed;
		inflight.push(placed);
	}
	// everything in the buffer as one task: full chunks, then a partial one at the end
	function submitBuffer() {
		var counts = [];
		for (var k = 0; k < filled; k += size) counts.push(Math.min(size, filled - k));
		var records = buf;
		buf = new Uint8Array(0);
		view = null;
		filled = 0;
		submit(records, counts);
	}
	function chunkFull() {
		full++;
		if (!pooled && full >= poolAt) pooled = makePool().catch(function () { return null; });
		if (!pooled) { submit(buf, [size]); filled = 0; }
		else if (filled === CHUNKS_PER_TASK * size) submitBuffer();
	}
	return {
		// points, the first of which is point `first` of the caller's (for error messages)
		write: async function (points, first) {
			refuse();
			// a bad extra value refuses this batch before any of it is encoded, so the writer carries on
			if (s.extra) checkExtra(points, s.extra.fields, first);
			try {
				for (var a = 0; a < points.count;) {
					var n = Math.min(size - filled % size, points.count - a);
					room(filled + n);
					encodeRecords(rangeOf(points, a, a + n), s.fmt, len, so, s.opts.localOrigin, view, filled * len, totals, first + a, extraFields(s));
					filled += n;
					a += n;
					totals.count += n;
					if (filled % size === 0) chunkFull();
				}
			} catch (err) {
				stop(err);
				throw err;
			}
			var pool = pooled ? await pooled : null;
			var limit = pool ? TASKS_PER_WORKER * pool.size : 0;
			while (inflight.length && inflight.length >= limit) await inflight.shift();
		},
		finish: async function () {
			refuse();
			ended = true;
			try {
				if (filled) submitBuffer();
				await order;
			} catch (err) {
				stop(err);
				throw err;
			} finally { shut(); }
			return chunks;
		},
		fail: stop
	};
}

// A whole LAZ file as parts: header + VLRs, table offset, chunks, chunk table.
// The points go through the chunk loop a task's worth at a time, so only
// the tasks in flight hold encoded records.
async function lazParts(points, s, so, len, totals) {
	var size = s.laz.chunkSize, count = Math.ceil(points.count / size), t = threadsOf(s.opts);
	if (s.extra) checkExtra(points, s.extra.fields, 0);   // whole columns, before they are cut into tasks
	var parts = [null, null];
	var poolAt = t === 1 || (!t && count < AUTO_MIN_CHUNKS) ? Infinity : 1;
	var loop = lazChunks(s, so, len, totals, function (bytes) { parts.push(bytes); }, poolAt, function () { return startPool(s.opts, count); });
	var step = CHUNKS_PER_TASK * size;
	for (var a = 0; a < points.count; a += step) await loop.write(rangeOf(points, a, Math.min(points.count, a + step)), a);
	var chunks = await loop.finish();
	// the header's size does not depend on the totals
	var tablePos = chunks.reduce(function (n, c) { return n + c.byteCount; }, headerBytes(s, so, totals).length + 8);
	parts.push(encodeChunkTable(chunks, false));
	parts[0] = headerBytes(s, so, totals);
	parts[1] = tableOffsetBytes(tablePos);
	return parts;
}

// One positioned write for any sink: an OPFS scratch writer (writeAt),
// a Node FileHandle (write(buffer, offset, length, position), which may
// write short), or a plain { write(bytes, position) }
function positionedWrite(sink) {
	if (typeof sink.writeAt === "function") return async function (bytes, pos) { await sink.writeAt(bytes, pos); };
	if (typeof sink.fd === "number" && typeof sink.write === "function") {
		return async function (bytes, pos) {
			for (var done = 0; done < bytes.length;) {
				var r = await sink.write(bytes, done, bytes.length - done, pos + done);
				if (!(r && r.bytesWritten > 0)) throw new LasError(ERROR_CODES.TRUNCATED, "the file handle stopped writing", pos + done);
				done += r.bytesWritten;
			}
		};
	}
	if (typeof sink.write === "function") return async function (bytes, pos) { await sink.write(bytes, pos); };
	throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "createLasWriter needs a sink with writeAt(bytes, position) or write(bytes, position)");
}

// The streaming LAZ writer: the chunk loop, placing chunks at the running
// position. close() places the partial chunk, writes the chunk table after
// it, then patches the table offset and the header totals. A failed write
// there fails the loop too, so later calls keep rejecting (ruling R11); once
// close() has begun, writePoints and close reject (ABORTED).
async function createLazWriter(s, so, len, totals, put, start) {
	var pos = start + 8, t = threadsOf(s.opts);
	// until close(), the table offset is LASzip's "not written yet" (-1)
	await put(joinParts([headerBytes(s, so, totals), new Uint8Array(8).fill(255)]), 0);
	var poolAt = t === 1 ? Infinity : t ? 1 : AUTO_MIN_CHUNKS;
	var loop = lazChunks(s, so, len, totals, function (bytes) {
		var at = pos;
		pos += bytes.length;
		return put(bytes, at);
	}, poolAt, function () { return startPool(s.opts, Infinity); });
	return {
		writePoints: function (points) { return loop.write(points, 0); },
		close: async function () {
			var chunks = await loop.finish();
			var tablePos = pos;
			try {
				await put(encodeChunkTable(chunks, false), tablePos);
				await put(tableOffsetBytes(tablePos), start);
				await put(headerBytes(s, so, totals), 0);
			} catch (err) {
				loop.fail(err);
				throw err;
			}
			return { count: totals.count };
		}
	};
}

/**
 * Stream a LAS (or, with compress: true, LAZ) file to a sink. Header totals are patched on close().
 * @param {object} sink - an OPFS scratch writer (openScratchSyncWriter), a Node
 *   FileHandle, or any { write(bytes, position) }
 * @param {object} opts - as writeLas; scale and offset are required (the bounds are not known yet).
 *   With compress and threads automatic, the pool (at most 4 workers) starts at the 4th full chunk
 * @returns {Promise<{writePoints: function(object): Promise, close: function(): Promise<{count:number}>}>}
 */
export async function createLasWriter(sink, opts) {
	opts = opts || {};
	if (!opts.scale || !opts.offset) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "createLasWriter needs scale and offset up front (the bounds are not known until the end)");
	var s = settle({ count: 0, x: [], y: [] }, opts); // no columns yet: format defaults to 0
	var so = { scale: opts.scale, offset: opts.offset };
	var len = s.recordLength;
	var totals = freshTotals(s);
	var put = positionedWrite(sink);
	var start = headerBytes(s, so, totals).length;
	if (s.laz) return createLazWriter(s, so, len, totals, put, start);
	var pending = [];
	await put(headerBytes(s, so, totals), 0);
	return {
		writePoints: async function (points) {
			var buf = new Uint8Array(points.count * len);
			encodeRecords(points, s.fmt, len, so, opts.localOrigin, new DataView(buf.buffer), 0, totals, 0, extraFields(s));
			// Reserve this batch's place BEFORE awaiting, so calls made without
			// waiting for each other never land on the same bytes
			var pos = start + totals.count * len;
			totals.count += points.count;
			var job = put(buf, pos);
			pending.push(job);
			await job;
		},
		close: async function () {
			await Promise.all(pending);
			await put(headerBytes(s, so, totals), 0);
			return { count: totals.count };
		}
	};
}
