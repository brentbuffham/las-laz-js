// src/tiles/tightBox.js
//==========================================================
// A tile's tight box from its raw records (shared by the tile build,
// the edits and the pool's workers).
//==========================================================

// [minX, minY, minZ, maxX, maxY, maxZ] in world units, or null for no points
export function tightBox(records, len, s, o) {
	if (!records.length) return null;
	var v = new DataView(records.buffer, records.byteOffset, records.byteLength);
	var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (var p = 0; p < records.length; p += len) {
		for (var a = 0; a < 3; a++) {
			var r = v.getInt32(p + 4 * a, true);
			if (r < lo[a]) lo[a] = r;
			if (r > hi[a]) hi[a] = r;
		}
	}
	return [lo[0] * s.x + o.x, lo[1] * s.y + o.y, lo[2] * s.z + o.z, hi[0] * s.x + o.x, hi[1] * s.y + o.y, hi[2] * s.z + o.z];
}
