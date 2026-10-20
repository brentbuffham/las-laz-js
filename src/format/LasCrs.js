// src/format/LasCrs.js
//==========================================================
// The coordinate system a LAS file declares, from its
// LASF_Projection records: the GeoTIFF GeoKey directory (record
// 34735) and / or OGC WKT (record 2112). Parsed only — the library
// has no projection dependency and never reprojects.
// EPSG comes from ProjectedCSTypeGeoKey (3072), else
// GeographicTypeGeoKey (2048); 32767 means "user-defined", not a code.
//==========================================================

var GEOKEY_DIRECTORY = 34735;
var WKT_RECORD = 2112;
var PROJECTED_CS = 3072;
var GEOGRAPHIC_CS = 2048;
var USER_DEFINED = 32767;

function u16(bytes, i) { return bytes[i] + bytes[i + 1] * 256; }

function parseGeoKeys(bytes) {
	if (bytes.length < 8) return [];
	var n = u16(bytes, 6);
	var keys = [];
	for (var i = 0; i < n && 8 + i * 8 + 8 <= bytes.length; i++) {
		var p = 8 + i * 8;
		keys.push({ keyId: u16(bytes, p), location: u16(bytes, p + 2), count: u16(bytes, p + 4), value: u16(bytes, p + 6) });
	}
	return keys;
}

function epsgFrom(keys) {
	var pick = function (id) {
		for (var i = 0; i < keys.length; i++) {
			var k = keys[i];
			if (k.keyId === id && k.location === 0 && k.value > 0 && k.value < USER_DEFINED) return k.value;
		}
		return null;
	};
	var p = pick(PROJECTED_CS);
	return p !== null ? p : pick(GEOGRAPHIC_CS);
}

function text(bytes) {
	var s = "";
	for (var i = 0; i < bytes.length && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
	return s;
}

/**
 * @param {Array<{userId:string, recordId:number, bytes:Uint8Array}>} records - VLRs and EVLRs.
 * @returns {{kind:("geokeys"|"wkt"|null), epsg:(number|null), wkt?:string, keys?:Array}}
 */
export function parseCrs(records) {
	var keys = null, wkt = null;
	(records || []).forEach(function (r) {
		if (r.userId !== "LASF_Projection") return;
		if (r.recordId === GEOKEY_DIRECTORY && keys === null) keys = parseGeoKeys(r.bytes);
		if (r.recordId === WKT_RECORD && wkt === null) wkt = text(r.bytes);
	});
	var epsg = keys ? epsgFrom(keys) : null;
	if (wkt !== null) {
		var out = { kind: "wkt", epsg: epsg, wkt: wkt };
		if (keys) out.keys = keys;
		return out;
	}
	if (keys) return { kind: "geokeys", epsg: epsg, keys: keys };
	return { kind: null, epsg: null };
}
