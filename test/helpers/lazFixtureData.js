// test/helpers/lazFixtureData.js
//==========================================================
// The seeded, synthetic point clouds behind test/fixtures/laz/*.laz.
// _dev/makeLazFixtures.mjs builds each LAS here and compresses it with
// PDAL (an encoder independent of this library); the tests rebuild the
// same LAS here and require the LAZ to decode to exactly its records.
// 51,000 points = two LASzip chunks of 50,000 (the second short).
// Fields move like a survey: pulses of 1-3 returns, classes in runs,
// slowly drifting scan angle and colour, GPS time rising with jumps,
// a flight-line change, and extra bytes where asked.
//==========================================================
/* prettier-ignore-file */
import { buildLas } from "./buildLas.js";

/** The fixtures: file name, LAS version, point format, extra bytes, points.
 *  f3 and f7 span two chunks (51,000 points); the rest are one chunk, to keep the repo small.
 *  Extra bytes need LAS 1.4 (PDAL drops them from 1.2). PDAL pads format 8 with 2 bytes. */
export var LAZ_FIXTURES = [
	{ name: "f0", version: "1.2", pointFormat: 0, extra: 0, points: 6000 },
	{ name: "f1", version: "1.2", pointFormat: 1, extra: 0, points: 6000 },
	{ name: "f2", version: "1.2", pointFormat: 2, extra: 0, points: 6000 },
	{ name: "f3", version: "1.2", pointFormat: 3, extra: 0, points: 51000 },
	{ name: "f3x", version: "1.4", pointFormat: 3, extra: 3, points: 6000 },
	{ name: "f6", version: "1.4", pointFormat: 6, extra: 0, points: 6000 },
	{ name: "f7", version: "1.4", pointFormat: 7, extra: 0, points: 51000 },
	{ name: "f8", version: "1.4", pointFormat: 8, extra: 0, points: 6000 },
	{ name: "f7x", version: "1.4", pointFormat: 7, extra: 3, points: 6000 }
];

function rng(seed) { return function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

/** Seeded points for one fixture. */
export function fixturePoints(fx) {
	var n = fx.points;
	var r = rng(1000 + fx.pointFormat * 10 + fx.extra), pts = [];
	var ext = fx.pointFormat >= 6;
	var cls = 2, t = 345678.25, angle = 0, red = 20000, green = 30000, blue = 25000, nir = 40000;
	var lines = [345678.25, 345990.5], line = 0, bounce = false;
	for (var i = 0; i < n;) {
		// The first 40 points repeat everything with intensity 0: LASzip's "nothing changed" path
		var quiet = i < 40;
		// two interleaved flight lines: LASzip tracks both and switches back to the other; half the
		// time it switches straight back after a one-point pulse (a switch from a sequence with no difference yet)
		var sw = !quiet && (bounce || r() < 0.004);
		if (sw) bounce = !bounce && r() < 0.5;
		var returns = quiet || (sw && bounce) ? 1 : r() < 0.7 ? 1 : r() < 0.6 ? 2 : 3;
		var bx = 477000 + (i % 400) * 0.25 + r() * 0.05, by = 6770000 + Math.floor(i / 400) * 0.25 + r() * 0.05;
		var bz = 300 + 5 * Math.sin(bx / 30) + 3 * Math.cos(by / 20);
		if (!quiet && r() < 0.02) cls = [1, 2, 3, 5, 6, 9][Math.floor(r() * 6)];
		if (!quiet) { angle += (r() - 0.5) * 0.4; if (angle > 25) angle = 25; if (angle < -25) angle = -25; }
		// Time steps as multiples of a base step, so every LASzip GPS branch is used:
		// same time, x1, x2-9, x10-499, x500+, backwards x1-9 and x10+, and big jumps
		var u = r(), mult = u < 0.55 ? 1 : u < 0.62 ? 0 : u < 0.72 ? 2 + Math.floor(r() * 8) : u < 0.8 ? 10 + Math.floor(r() * 490) : u < 0.83 ? 500 + Math.floor(r() * 300) : u < 0.91 ? -1 - Math.floor(r() * 9) : u < 0.95 ? -10 - Math.floor(r() * 20) : 0;
		if (sw) { lines[line] = t; line = 1 - line; t = lines[line]; }
		t += u >= 0.95 && u < 0.97 ? 12.5 + r() : mult * 0.000025;
		red = Math.max(0, Math.min(65535, red + Math.round((r() - 0.5) * 900)));
		green = Math.max(0, Math.min(65535, green + Math.round((r() - 0.5) * 900)));
		blue = Math.max(0, Math.min(65535, blue + Math.round((r() - 0.5) * 900)));
		nir = Math.max(0, Math.min(65535, nir + Math.round((r() - 0.5) * 900)));
		// a 3-return pulse sometimes loses its middle return (return number jumps 1 -> 3)
		var skip = returns === 3 && r() < 0.15 ? 2 : 0;
		for (var k = 1; k <= returns && i < n; k++) {
			if (k === skip) continue;
			pts.push({
				x: Math.round((bx + (k - 1) * 0.01) * 1000) / 1000, y: Math.round(by * 1000) / 1000,
				z: Math.round((bz - (k - 1) * 1.5) * 1000) / 1000,
				intensity: i === 0 ? 77 : quiet ? 0 : Math.round(800 + 600 * Math.sin(i / 50) + r() * 100) + (k - 1) * 200,
				returnNumber: k, numberOfReturns: returns,
				scanDirection: (i >> 7) & 1, edgeOfFlightLine: !quiet && i % 997 === 0 ? 1 : 0,
				classification: k === returns ? cls : 1,
				classificationFlags: !quiet && r() < 0.01 ? (ext ? 5 : 1) : 0,
				// channels in blocks that come back (0, 1, 0, 2, 1, 3, 0 ...): every context switch path
				scannerChannel: ext ? [0, 1, 0, 2, 1, 3, 0][Math.floor(i / 700) % 7] : 0,
				scanAngle: ext ? Math.round(angle / 0.006) * 0.006 : Math.round(angle),
				userData: Math.floor(i / 5000),
				pointSourceId: i < n / 2 ? 101 : 102,
				gpsTime: t,                            // the returns of one pulse share its time
				// grey (r = g = b) in the quiet stretch, as many scanners write: LASzip's one-channel path
				red: red, green: quiet ? red : green, blue: quiet ? red : blue, nir: nir
			});
			i++;
		}
	}
	return pts;
}

// One Extra Bytes descriptor (LAS 1.4 R15, 192 bytes): an unsigned char called `name`
function extraBytesDescriptor(name) {
	var d = new Uint8Array(192);
	d[2] = 1;                                                // data type 1 = unsigned char
	for (var i = 0; i < name.length; i++) d[4 + i] = name.charCodeAt(i);
	return d;
}

/** A fixture's extra bytes as columns extra0, extra1, … (u8): byte j of point i is (i * (j + 3) + (i >> 4)) % 256. */
export function fixtureExtraColumns(fx) {
	var out = {};
	for (var j = 0; j < fx.extra; j++) {
		var c = new Uint8Array(fx.points);
		for (var i = 0; i < fx.points; i++) c[i] = (i * (j + 3) + (i >> 4)) % 256;
		out["extra" + j] = c;
	}
	return out;
}

/** The uncompressed LAS file a fixture was made from. */
export function fixtureLas(fx) {
	var pts = fixturePoints(fx);
	var vlrs = [];
	if (fx.extra) {
		var desc = new Uint8Array(192 * fx.extra);
		for (var e = 0; e < fx.extra; e++) desc.set(extraBytesDescriptor("extra" + e), e * 192);
		vlrs.push({ userId: "LASF_Spec", recordId: 4, description: "Extra Bytes", bytes: desc });
	}
	var bytes = buildLas({ version: fx.version, pointFormat: fx.pointFormat, scale: { x: 0.001, y: 0.001, z: 0.001 }, offset: { x: 477000, y: 6770000, z: 0 }, points: pts, vlrs: vlrs, extraBytes: fx.extra });
	if (fx.extra) {
		var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		var start = v.getUint32(96, true), len = v.getUint16(105, true), base = len - fx.extra, cols = fixtureExtraColumns(fx);
		for (var i = 0; i < pts.length; i++) for (var j = 0; j < fx.extra; j++) bytes[start + i * len + base + j] = cols["extra" + j][i];
	}
	return bytes;
}
