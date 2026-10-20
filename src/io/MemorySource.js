// src/io/MemorySource.js
//==========================================================
// The sync source contract over an in-memory Uint8Array.
// Pure decoders read through this contract so the same code
// runs on a header window, a block, or an OPFS ScratchSource:
//   length(), slice(start, end), getUint8(pos),
//   getUint16/getUint32/getInt16/getInt32/getFloat64(pos, littleEndian)
// Out-of-range reads throw LasError TRUNCATED naming the offset.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

/**
 * Sync byte source over a Uint8Array. Use with `new`.
 * @param {Uint8Array} bytes
 */
export function MemorySource(bytes) {
	if (!(bytes instanceof Uint8Array)) {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "MemorySource needs a Uint8Array");
	}
	this._bytes = bytes;
	this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function check(source, pos, size) {
	if (pos < 0 || pos + size > source._bytes.length) {
		throw new LasError(ERROR_CODES.TRUNCATED, "read of " + size + " bytes past end of " + source._bytes.length + "-byte source", pos);
	}
}

/** @returns {number} byte length */
MemorySource.prototype.length = function () {
	return this._bytes.length;
};

/**
 * View of bytes [start, end). Callers must not mutate it.
 * @returns {Uint8Array}
 */
MemorySource.prototype.slice = function (start, end) {
	if (start < 0 || end < start) {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "bad slice range " + start + ".." + end);
	}
	if (end > this._bytes.length) {
		throw new LasError(ERROR_CODES.TRUNCATED, "slice past end of " + this._bytes.length + "-byte source", end);
	}
	return this._bytes.subarray(start, end);
};

/** @returns {number} */
MemorySource.prototype.getUint8 = function (pos) {
	check(this, pos, 1);
	return this._bytes[pos];
};

/** @returns {number} */
MemorySource.prototype.getUint16 = function (pos, littleEndian) {
	check(this, pos, 2);
	return this._view.getUint16(pos, littleEndian);
};

/** @returns {number} */
MemorySource.prototype.getUint32 = function (pos, littleEndian) {
	check(this, pos, 4);
	return this._view.getUint32(pos, littleEndian);
};

/** @returns {number} */
MemorySource.prototype.getInt16 = function (pos, littleEndian) {
	check(this, pos, 2);
	return this._view.getInt16(pos, littleEndian);
};

/** @returns {number} */
MemorySource.prototype.getInt32 = function (pos, littleEndian) {
	check(this, pos, 4);
	return this._view.getInt32(pos, littleEndian);
};

/** @returns {number} */
MemorySource.prototype.getFloat64 = function (pos, littleEndian) {
	check(this, pos, 8);
	return this._view.getFloat64(pos, littleEndian);
};
