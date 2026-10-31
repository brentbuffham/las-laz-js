// src/tiles/movePoints.js
//==========================================================
// New positions written into a tile's raw records, in place, and a
// tile's tight box: the part of an edit that moves points, shared by
// the calling thread and the pool's workers so both write the same
// bytes. A point's position is raw * scale + offset, then the store
// transform (world); a new world position goes back through the
// store transform's inverse, then the scale and offset, rounded.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

var INT32_MAX = 2147483647, INT32_MIN = -2147483648;

/**
 * Move points in a tile's raw records (written in place).
 * @param {Uint8Array} records - whole records, X, Y, Z first (int32 each)
 * @param {number} len - the record length
 * @param {{index: Uint32Array, scale: object, offset: object, storeT?: object, inv?: object, T?: object, x?: Float64Array, y?: Float64Array, z?: Float64Array}} spec
 *   index: the points to move (a point's place in the tile); T: { m, t }: each becomes m * p + t in world
 *   coordinates (after the store transform storeT); else x, y, z give each one's world position;
 *   inv: the inverse of the store transform, when the store has one
 * @throws {LasError} INVALID_ARGUMENT for a position that does not fit the scale and offset
 */
export function movePoints(records, len, spec) {
	var v = new DataView(records.buffer, records.byteOffset, records.byteLength), idx = spec.index, s = spec.scale, o = spec.offset;
	var S = spec.storeT || null, I = spec.inv || null, T = spec.T || null;
	for (var i = 0; i < idx.length; i++) {
		var p = idx[i] * len, x, y, z, nx, ny, nz;
		if (T) {
			x = v.getInt32(p, true) * s.x + o.x; y = v.getInt32(p + 4, true) * s.y + o.y; z = v.getInt32(p + 8, true) * s.z + o.z;
			if (S) {
				nx = S.m[0] * x + S.m[1] * y + S.m[2] * z + S.t[0]; ny = S.m[3] * x + S.m[4] * y + S.m[5] * z + S.t[1]; nz = S.m[6] * x + S.m[7] * y + S.m[8] * z + S.t[2];
				x = nx; y = ny; z = nz;
			}
			nx = T.m[0] * x + T.m[1] * y + T.m[2] * z + T.t[0]; ny = T.m[3] * x + T.m[4] * y + T.m[5] * z + T.t[1]; nz = T.m[6] * x + T.m[7] * y + T.m[8] * z + T.t[2];
			x = nx; y = ny; z = nz;
		} else {
			x = spec.x[i]; y = spec.y[i]; z = spec.z[i];
		}
		if (I) {
			nx = I.m[0] * x + I.m[1] * y + I.m[2] * z + I.t[0]; ny = I.m[3] * x + I.m[4] * y + I.m[5] * z + I.t[1]; nz = I.m[6] * x + I.m[7] * y + I.m[8] * z + I.t[2];
			x = nx; y = ny; z = nz;
		}
		var X = Math.round((x - o.x) / s.x), Y = Math.round((y - o.y) / s.y), Z = Math.round((z - o.z) / s.z);
		if (X > INT32_MAX || X < INT32_MIN || Y > INT32_MAX || Y < INT32_MIN || Z > INT32_MAX || Z < INT32_MIN) {
			throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "point " + idx[i] + " does not fit the scale and offset (int32 overflow); use a coarser scale");
		}
		v.setInt32(p, X, true); v.setInt32(p + 4, Y, true); v.setInt32(p + 8, Z, true);
	}
}
