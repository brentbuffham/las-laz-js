// test/helpers/buildLas.js
//==========================================================
// Encode a small LAS file byte by byte from the ASPRS LAS 1.4 R15
// tables, for tests. Written from the SPEC, separately from the
// library's decoder, so a test that reads a built file checks the
// decoder against the spec — not against itself.
//
// buildLas({ version, pointFormat, scale, offset, points, vlrs,
//            evlrs, systemId, software, globalEncoding,
//            legacyCount, countOverride }) -> Uint8Array
// points: [{ x, y, z, intensity, returnNumber, numberOfReturns,
//   scanDirection, edgeOfFlightLine, classification,
//   classificationFlags, scannerChannel, scanAngle (degrees for 1.4
//   formats, rank for 0-5), userData, pointSourceId, gpsTime,
//   red, green, blue, nir, wavePacket: [29 bytes] }]
//==========================================================
/* prettier-ignore-file */

var HEADER_SIZE = { "1.0": 227, "1.1": 227, "1.2": 227, "1.3": 235, "1.4": 375 };
var RECORD_SIZE = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];

function ascii(view, pos, text, max) {
	for (var i = 0; i < max; i++) view.setUint8(pos + i, i < text.length ? text.charCodeAt(i) : 0);
}

function setU64(view, pos, value) {
	view.setUint32(pos, value % 4294967296, true);
	view.setUint32(pos + 4, Math.floor(value / 4294967296), true);
}

// One record at `pos` (ASPRS point data record formats 0-10)
function writeRecord(v, pos, fmt, p, scale, offset) {
	v.setInt32(pos, Math.round((p.x - offset.x) / scale.x), true);
	v.setInt32(pos + 4, Math.round((p.y - offset.y) / scale.y), true);
	v.setInt32(pos + 8, Math.round((p.z - offset.z) / scale.z), true);
	v.setUint16(pos + 12, p.intensity || 0, true);
	var ret = p.returnNumber || 0, num = p.numberOfReturns || 0;
	var dir = p.scanDirection ? 1 : 0, edge = p.edgeOfFlightLine ? 1 : 0;
	var cls = p.classification || 0, flags = p.classificationFlags || 0;
	if (fmt <= 5) {
		v.setUint8(pos + 14, (ret & 7) + (num & 7) * 8 + dir * 64 + edge * 128);
		v.setUint8(pos + 15, (cls & 31) + (flags & 7) * 32);
		v.setInt8(pos + 16, p.scanAngle || 0);
		v.setUint8(pos + 17, p.userData || 0);
		v.setUint16(pos + 18, p.pointSourceId || 0, true);
		var at = pos + 20;
		if (fmt === 1 || fmt === 3 || fmt === 4 || fmt === 5) { v.setFloat64(at, p.gpsTime || 0, true); at += 8; }
		if (fmt === 2 || fmt === 3 || fmt === 5) {
			v.setUint16(at, p.red || 0, true); v.setUint16(at + 2, p.green || 0, true); v.setUint16(at + 4, p.blue || 0, true); at += 6;
		}
		if (fmt === 4 || fmt === 5) writeWave(v, at, p);
	} else {
		v.setUint8(pos + 14, (ret & 15) + (num & 15) * 16);
		v.setUint8(pos + 15, (flags & 15) + ((p.scannerChannel || 0) & 3) * 16 + dir * 64 + edge * 128);
		v.setUint8(pos + 16, cls);
		v.setUint8(pos + 17, p.userData || 0);
		v.setInt16(pos + 18, Math.round((p.scanAngle || 0) / 0.006), true);
		v.setUint16(pos + 20, p.pointSourceId || 0, true);
		v.setFloat64(pos + 22, p.gpsTime || 0, true);
		var at6 = pos + 30;
		if (fmt === 7 || fmt === 8 || fmt === 10) {
			v.setUint16(at6, p.red || 0, true); v.setUint16(at6 + 2, p.green || 0, true); v.setUint16(at6 + 4, p.blue || 0, true); at6 += 6;
		}
		if (fmt === 8 || fmt === 10) { v.setUint16(at6, p.nir || 0, true); at6 += 2; }
		if (fmt === 9 || fmt === 10) writeWave(v, at6, p);
	}
}

function writeWave(v, pos, p) {
	var w = p.wavePacket || [];
	for (var i = 0; i < 29; i++) v.setUint8(pos + i, w[i] || 0);
}

export function buildLas(o) {
	var version = o.version || "1.2";
	var fmt = o.pointFormat || 0;
	var points = o.points || [];
	var scale = o.scale || { x: 0.001, y: 0.001, z: 0.001 };
	var offset = o.offset || { x: 0, y: 0, z: 0 };
	var vlrs = o.vlrs || [];
	var evlrs = o.evlrs || [];
	var headerSize = HEADER_SIZE[version];
	var recordSize = RECORD_SIZE[fmt] + (o.extraBytes || 0);
	var vlrBytes = vlrs.reduce(function (s, r) { return s + 54 + r.bytes.length; }, 0);
	var pointStart = headerSize + vlrBytes;
	var evlrStart = pointStart + points.length * recordSize;
	var evlrBytes = evlrs.reduce(function (s, r) { return s + 60 + r.bytes.length; }, 0);
	var out = new Uint8Array(evlrStart + evlrBytes);
	var v = new DataView(out.buffer);

	ascii(v, 0, "LASF", 4);
	v.setUint16(6, o.globalEncoding || 0, true);
	v.setUint8(24, Number(version.split(".")[0]));
	v.setUint8(25, Number(version.split(".")[1]));
	ascii(v, 26, o.systemId || "test", 32);
	ascii(v, 58, o.software || "buildLas", 32);
	v.setUint16(90, 294, true);
	v.setUint16(92, 2026, true);
	v.setUint16(94, headerSize, true);
	v.setUint32(96, pointStart, true);
	v.setUint32(100, vlrs.length, true);
	v.setUint8(104, o.formatByte != null ? o.formatByte : fmt);
	v.setUint16(105, recordSize, true);

	var count = o.countOverride != null ? o.countOverride : points.length;
	var byReturn = new Array(15).fill(0);
	var minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
	points.forEach(function (p) {
		var r = p.returnNumber || 0;
		if (r >= 1 && r <= 15) byReturn[r - 1]++;
		if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
		if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
	});
	if (!points.length) { minX = minY = minZ = maxX = maxY = maxZ = 0; }
	var legacy = o.legacyCount != null ? o.legacyCount : (fmt >= 6 ? 0 : count);
	v.setUint32(107, legacy, true);
	for (var i = 0; i < 5; i++) v.setUint32(111 + i * 4, fmt >= 6 ? 0 : byReturn[i], true);
	v.setFloat64(131, scale.x, true); v.setFloat64(139, scale.y, true); v.setFloat64(147, scale.z, true);
	v.setFloat64(155, offset.x, true); v.setFloat64(163, offset.y, true); v.setFloat64(171, offset.z, true);
	v.setFloat64(179, maxX, true); v.setFloat64(187, minX, true);
	v.setFloat64(195, maxY, true); v.setFloat64(203, minY, true);
	v.setFloat64(211, maxZ, true); v.setFloat64(219, minZ, true);
	if (headerSize >= 235) setU64(v, 227, 0); // start of waveform data packet record
	if (headerSize >= 375) {
		setU64(v, 235, evlrs.length ? evlrStart : 0);
		v.setUint32(243, evlrs.length, true);
		setU64(v, 247, count);
		for (var j = 0; j < 15; j++) setU64(v, 255 + j * 8, byReturn[j]);
	}

	var pos = headerSize;
	vlrs.forEach(function (r) {
		ascii(v, pos + 2, r.userId, 16);
		v.setUint16(pos + 18, r.recordId, true);
		v.setUint16(pos + 20, r.bytes.length, true);
		ascii(v, pos + 22, r.description || "", 32);
		out.set(r.bytes, pos + 54);
		pos += 54 + r.bytes.length;
	});
	points.forEach(function (p, k) { writeRecord(v, pointStart + k * recordSize, fmt, p, scale, offset); });
	pos = evlrStart;
	evlrs.forEach(function (r) {
		ascii(v, pos + 2, r.userId, 16);
		v.setUint16(pos + 18, r.recordId, true);
		setU64(v, pos + 20, r.bytes.length);
		ascii(v, pos + 28, r.description || "", 32);
		out.set(r.bytes, pos + 60);
		pos += 60 + r.bytes.length;
	});
	return out;
}

/** GeoKey directory bytes: header [1,1,0,n] then [key, location 0, count 1, value] per key. */
export function geoKeyBytes(keys) {
	var shorts = [1, 1, 0, keys.length];
	keys.forEach(function (k) { shorts.push(k[0], 0, 1, k[1]); });
	var b = new Uint8Array(shorts.length * 2);
	var v = new DataView(b.buffer);
	shorts.forEach(function (s, i) { v.setUint16(i * 2, s, true); });
	return b;
}

export { RECORD_SIZE };
