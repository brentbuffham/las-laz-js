// src/format/PointFormats.js
//==========================================================
// ASPRS LAS 1.4 R15 point data record formats 0-10: the record
// size and where each field sits. Formats 0-5 are the "legacy"
// layout (3-bit returns, 5-bit class, 8-bit scan angle rank);
// 6-10 the "extended" layout (4-bit returns, 8-bit class, 16-bit
// scan angle in 0.006 degree steps). Bit fields share a byte:
// the decoder reads returnByte / classByte / flagsByte and splits
// them (see read/decodeRecords.js).
//==========================================================

function f(offset, type) { return { offset: offset, type: type }; }

function legacyBase() {
	return {
		x: f(0, "i32"), y: f(4, "i32"), z: f(8, "i32"),
		intensity: f(12, "u16"),
		returnByte: f(14, "u8"),
		classByte: f(15, "u8"),
		scanAngleRank: f(16, "i8"),
		userData: f(17, "u8"),
		pointSourceId: f(18, "u16")
	};
}

function extendedBase() {
	return {
		x: f(0, "i32"), y: f(4, "i32"), z: f(8, "i32"),
		intensity: f(12, "u16"),
		returnByte: f(14, "u8"),
		flagsByte: f(15, "u8"),
		classification: f(16, "u8"),
		userData: f(17, "u8"),
		scanAngle: f(18, "i16"),
		pointSourceId: f(20, "u16"),
		gpsTime: f(22, "f64")
	};
}

function withRgb(fields, at) {
	fields.red = f(at, "u16");
	fields.green = f(at + 2, "u16");
	fields.blue = f(at + 4, "u16");
	return fields;
}

function build() {
	var out = [];
	var p0 = legacyBase();
	out[0] = { id: 0, size: 20, extended: false, fields: p0 };
	var p1 = legacyBase(); p1.gpsTime = f(20, "f64");
	out[1] = { id: 1, size: 28, extended: false, fields: p1 };
	out[2] = { id: 2, size: 26, extended: false, fields: withRgb(legacyBase(), 20) };
	var p3 = legacyBase(); p3.gpsTime = f(20, "f64"); withRgb(p3, 28);
	out[3] = { id: 3, size: 34, extended: false, fields: p3 };
	var p4 = legacyBase(); p4.gpsTime = f(20, "f64"); p4.wavePacket = f(28, "wave");
	out[4] = { id: 4, size: 57, extended: false, fields: p4 };
	var p5 = legacyBase(); p5.gpsTime = f(20, "f64"); withRgb(p5, 28); p5.wavePacket = f(34, "wave");
	out[5] = { id: 5, size: 63, extended: false, fields: p5 };
	out[6] = { id: 6, size: 30, extended: true, fields: extendedBase() };
	out[7] = { id: 7, size: 36, extended: true, fields: withRgb(extendedBase(), 30) };
	var p8 = withRgb(extendedBase(), 30); p8.nir = f(36, "u16");
	out[8] = { id: 8, size: 38, extended: true, fields: p8 };
	var p9 = extendedBase(); p9.wavePacket = f(30, "wave");
	out[9] = { id: 9, size: 59, extended: true, fields: p9 };
	var p10 = withRgb(extendedBase(), 30); p10.nir = f(36, "u16"); p10.wavePacket = f(38, "wave");
	out[10] = { id: 10, size: 67, extended: true, fields: p10 };
	return out;
}

/** Point data record formats 0-10, indexed by format id. */
export var POINT_FORMATS = Object.freeze(build());

/** @returns {boolean} the format carries red / green / blue */
export function formatHasRgb(id) { return !!POINT_FORMATS[id] && !!POINT_FORMATS[id].fields.red; }
