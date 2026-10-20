// src/io/NodeFileSource.js
//==========================================================
// Async range reader over a file on disk, for Node. The same
// contract as BlobSource ({ size, read(start, end) }) so the
// reader never cares where the bytes come from, and a 30 GB LAS
// file is read one window at a time.
// node:fs is imported LAZILY inside open(), so a browser bundle
// that includes this module never touches it.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

/**
 * Async reader over a Node file handle. Create with NodeFileSource.open(path).
 * @param {object} handle - a node:fs/promises FileHandle
 * @param {number} size - file size in bytes
 */
export function NodeFileSource(handle, size) {
	this._handle = handle;
	/** Total byte size of the file. */
	this.size = size;
}

/**
 * Open a file for range reads.
 * @param {string} path
 * @returns {Promise<NodeFileSource>}
 */
NodeFileSource.open = async function (path) {
	if (typeof path !== "string" || !path) {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "NodeFileSource needs a file path");
	}
	var fs = await import("node:fs/promises");
	var handle = await fs.open(path, "r");
	var stat = await handle.stat();
	return new NodeFileSource(handle, stat.size);
};

/**
 * Copy bytes [start, end) out of the file.
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Uint8Array>}
 */
NodeFileSource.prototype.read = async function (start, end) {
	if (start < 0 || end < start) {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "bad read range " + start + ".." + end);
	}
	if (end > this.size) {
		throw new LasError(ERROR_CODES.TRUNCATED, "read past end of " + this.size + "-byte file", end);
	}
	var out = new Uint8Array(end - start);
	var done = 0;
	while (done < out.length) {
		var r = await this._handle.read(out, done, out.length - done, start + done);
		if (r.bytesRead === 0) throw new LasError(ERROR_CODES.TRUNCATED, "file ended early", start + done);
		done += r.bytesRead;
	}
	return out;
};

/** Close the file handle. */
NodeFileSource.prototype.close = async function () {
	if (this._handle) { await this._handle.close(); this._handle = null; }
};
