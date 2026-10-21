// src/write/writeLas.js
//==========================================================
// Write LAS 1.0-1.4: writeLas(points, opts) builds a whole file in
// memory; createLasWriter(sink, opts) streams records to a sink
// ({ write(bytes, position) }, e.g. an OPFS sync writer or a Node
// file handle) and patches the header totals on close. Both share
// one header builder, so they produce identical bytes.
//
// Ported from Kirra's LASWriter, with two changes: an invalid
// version / format pair is REFUSED (Kirra silently downgraded the
// format), and the coordinate system is written (GeoKey EPSG
// record 34735 and / or a WKT record 2112) — Kirra wrote no VLRs.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { POINT_FORMATS } from "../format/PointFormats.js";
import { chooseScaleOffset } from "./scaleOffset.js";
import { encodeRecords } from "./encodeRecords.js";

var LE = true;
var HEADER_SIZE = { "1.0": 227, "1.1": 227, "1.2": 227, "1.3": 235, "1.4": 375 };

function ascii(v, pos, text, max) {
	for (var i = 0; i < max; i++) v.setUint8(pos + i, i < text.length ? text.charCodeAt(i) & 0x7F : 0); // bits-ok
}
function setU64(v, pos, value) {
	v.setUint32(pos, value % 4294967296, LE);
	v.setUint32(pos + 4, Math.floor(value / 4294967296), LE);
}

function isGeographic(epsg) { return epsg >= 4000 && epsg < 5000; }

function crsRecords(crs) {
	var out = [];
	if (!crs) return out;
	if (crs.epsg) {
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
	return { version: version, minor: minor, fmt: fmt, opts: opts };
}

function freshTotals() {
	return { count: 0, byReturn: new Array(15).fill(0), bounds: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity } };
}

// Header + VLR bytes for the given totals
function headerBytes(s, so, totals) {
	var o = s.opts;
	var headerSize = HEADER_SIZE[s.version];
	var vlrs = crsRecords(o.crs);
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
	v.setUint8(104, s.fmt);
	v.setUint16(105, fmt.size, LE);
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
 * Write a whole LAS file.
 * @param {object} points - PointColumns (world coordinates, or relative to opts.localOrigin)
 * @param {object} [opts] - version, pointFormat, scale, offset, crs {epsg|wkt}, software, systemId, date, localOrigin, as ("bytes" | "blob")
 * @returns {Promise<Uint8Array|Blob>}
 */
export async function writeLas(points, opts) {
	var s = settle(points, opts);
	var o = s.opts;
	var so = (o.scale && o.offset) ? { scale: o.scale, offset: o.offset } : chooseScaleOffset(boundsOfPoints(points, o.localOrigin));
	if (o.scale && !o.offset) so = { scale: o.scale, offset: chooseScaleOffset(boundsOfPoints(points, o.localOrigin)).offset };
	var len = POINT_FORMATS[s.fmt].size;
	var totals = freshTotals();
	// One buffer: records are encoded in place after the header, whose
	// size does not depend on the totals; the header is filled in last
	var headLength = headerBytes(s, so, totals).length;
	var out = new Uint8Array(headLength + points.count * len);
	encodeRecords(points, s.fmt, len, so, o.localOrigin, new DataView(out.buffer), headLength, totals);
	totals.count = points.count;
	out.set(headerBytes(s, so, totals), 0);
	return o.as === "blob" ? new Blob([out], { type: "application/octet-stream" }) : out;
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

/**
 * Stream a LAS file to a sink. Header totals are patched on close().
 * @param {object} sink - an OPFS scratch writer (openScratchSyncWriter), a Node
 *   FileHandle, or any { write(bytes, position) }
 * @param {object} opts - as writeLas; scale and offset are required (the bounds are not known yet)
 * @returns {Promise<{writePoints: function(object): Promise, close: function(): Promise<{count:number}>}>}
 */
export async function createLasWriter(sink, opts) {
	opts = opts || {};
	if (!opts.scale || !opts.offset) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "createLasWriter needs scale and offset up front (the bounds are not known until the end)");
	var s = settle({ count: 0, x: [], y: [] }, opts); // no columns yet: format defaults to 0
	var so = { scale: opts.scale, offset: opts.offset };
	var len = POINT_FORMATS[s.fmt].size;
	var totals = freshTotals();
	var put = positionedWrite(sink);
	var start = headerBytes(s, so, totals).length;
	var pending = [];
	await put(headerBytes(s, so, totals), 0);
	return {
		writePoints: async function (points) {
			var buf = new Uint8Array(points.count * len);
			encodeRecords(points, s.fmt, len, so, opts.localOrigin, new DataView(buf.buffer), 0, totals);
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
