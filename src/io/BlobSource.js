// src/io/BlobSource.js
//==========================================================
// Async range reader over a File or Blob. Blob reads cannot be
// synchronous outside a worker, so this is NOT the sync source
// contract: callers read a range, then parse it through
// MemorySource (Kirra's windowed-header pattern). Nothing larger
// than the requested range is ever loaded.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

/**
 * Async reader over a File/Blob. Use with `new`.
 * @param {Blob} blob
 */
export function BlobSource(blob) {
	if (!blob || typeof blob.slice !== "function" || typeof blob.size !== "number") {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "BlobSource needs a File or Blob");
	}
	this._blob = blob;
	/** Total byte size of the blob. */
	this.size = blob.size;
}

/**
 * Copy bytes [start, end) out of the blob.
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Uint8Array>}
 */
BlobSource.prototype.read = async function (start, end) {
	if (start < 0 || end < start) {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "bad read range " + start + ".." + end);
	}
	if (end > this.size) {
		throw new LasError(ERROR_CODES.TRUNCATED, "read past end of " + this.size + "-byte file", end);
	}
	var buffer = await this._blob.slice(start, end).arrayBuffer();
	return new Uint8Array(buffer);
};
