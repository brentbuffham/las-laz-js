// src/io/ScratchBinaryFile.js
//==========================================================
// OPFS scratch files for point columns too large for memory.
// Copied from ecw-js, which modelled it on Kirra's ScratchBinaryFile
// — the THIRD copy (Kirra, ecw-js, here); a shared micro-package can
// replace all three later.
// - avoids the ~2 GiB ArrayBuffer ceiling for big reads
// - private per-origin sandbox, survives between reads
// - workers get synchronous FileSystemSyncAccessHandle reads
// Files live in OPFS directory SCRATCH_DIR. Writers and readers
// are worker-only (sync access handles); opening is async.
// Every function takes options.root (a directory handle) so tests
// can pass an in-memory fake; default is navigator.storage.
// options.dir picks the OPFS sub-directory (default SCRATCH_DIR), so
// long-lived files can sit apart from the 24 h sweep.
// ⚠️ OPFS sync handles hold an exclusive lock: close the writer
// before opening a reader on the same file.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";

/** OPFS sub-directory holding every las-laz-js scratch file. */
export var SCRATCH_DIR = "las-scratch";

var DEFAULT_WINDOW_SIZE = 4 * 1024 * 1024;
var DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Raised by OPFS when another tab or worker holds a sync handle on the file
var LOCKED_ERRORS = ["NoModificationAllowedError", "InvalidModificationError"];

// options.dir may be a path ("las-tiles/scan-1/build"): each segment is a folder
async function getScratchDir(options) {
	var dir = (options && options.root) || await navigator.storage.getDirectory();
	var segs = ((options && options.dir) || SCRATCH_DIR).split("/");
	for (var i = 0; i < segs.length; i++) if (segs[i]) dir = await dir.getDirectoryHandle(segs[i], { create: true });
	return dir;
}

/**
 * Open (and empty) a scratch file for synchronous writing. Worker only.
 * @param {string} id - Scratch file name.
 * @param {{root?: object, dir?: string}} [options]
 * @returns {Promise<{write(bytes: Uint8Array): void, writeAt(bytes: Uint8Array, pos: number): void,
 *   truncate(n: number): void, bytesWritten(): number, close(): void}>}
 */
/** Whether an error is the browser's storage quota running out. */
export function isQuotaError(e) { return !!e && (e.name === "QuotaExceededError" || e.code === 22); }

/** The NO_SPACE error for a write that hit the storage quota. */
export function noSpace(what) {
	return new LasError(ERROR_CODES.NO_SPACE, "out of browser storage (OPFS) " + what + ": free some space (remove other tile stores or site data) or let the browser grant more");
}

export async function openScratchSyncWriter(id, options) {
	var dir = await getScratchDir(options);
	var fileHandle = await dir.getFileHandle(id, { create: true });
	var handle = await fileHandle.createSyncAccessHandle();
	handle.truncate(0);
	var position = 0;
	var end = 0;
	// a write past the browser's storage quota: NO_SPACE, naming the file
	function put(bytes, at) {
		try { handle.write(bytes, { at: at }); } catch (e) { throw isQuotaError(e) ? noSpace("writing " + id) : e; }
	}
	return {
		write: function (bytes) {
			put(bytes, position);
			position += bytes.length;
			end = Math.max(end, position);
		},
		writeAt: function (bytes, pos) {
			put(bytes, pos);
			end = Math.max(end, pos + bytes.length);
		},
		truncate: function (n) {
			handle.truncate(n);
			position = Math.min(position, n);
			end = Math.min(end, n);
		},
		bytesWritten: function () {
			return end;
		},
		close: function () {
			handle.flush();
			handle.close();
		}
	};
}

/**
 * Sync source contract over an OPFS sync access handle, with a
 * sliding read window. Create with openScratchReader().
 */
export function ScratchSource(handle, length, windowSize) {
	this._handle = handle;
	this._length = length;
	this._window = new Uint8Array(windowSize);
	this._view = new DataView(this._window.buffer);
	this._windowStart = 0;
	this._windowLength = 0;
}

function truncated(source, pos) {
	return new LasError(ERROR_CODES.TRUNCATED, "read past end of " + source._length + "-byte scratch file", pos);
}

// Returns the window offset of `pos`, refilling so [pos, pos + size) is resident
function windowAt(source, pos, size) {
	if (pos < 0 || pos + size > source._length) throw truncated(source, pos);
	var rel = pos - source._windowStart;
	if (rel >= 0 && rel + size <= source._windowLength) return rel;
	var count = Math.min(source._window.length, source._length - pos);
	source._windowLength = source._handle.read(source._window.subarray(0, count), { at: pos });
	source._windowStart = pos;
	return 0;
}

/** @returns {number} logical byte length */
ScratchSource.prototype.length = function () {
	return this._length;
};

/**
 * Copy of bytes [start, end); may span many windows.
 * @returns {Uint8Array}
 */
ScratchSource.prototype.slice = function (start, end) {
	if (start < 0 || end < start) {
		throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "bad slice range " + start + ".." + end);
	}
	if (end > this._length) throw truncated(this, end);
	var out = new Uint8Array(end - start);
	this._handle.read(out, { at: start });
	return out;
};

/** @returns {number} */
ScratchSource.prototype.getUint8 = function (pos) {
	return this._window[windowAt(this, pos, 1)];
};

/** @returns {number} */
ScratchSource.prototype.getUint16 = function (pos, littleEndian) {
	return this._view.getUint16(windowAt(this, pos, 2), littleEndian);
};

/** @returns {number} */
ScratchSource.prototype.getUint32 = function (pos, littleEndian) {
	return this._view.getUint32(windowAt(this, pos, 4), littleEndian);
};

/** @returns {number} */
ScratchSource.prototype.getInt32 = function (pos, littleEndian) {
	return this._view.getInt32(windowAt(this, pos, 4), littleEndian);
};

/** @returns {number} */
ScratchSource.prototype.getFloat64 = function (pos, littleEndian) {
	return this._view.getFloat64(windowAt(this, pos, 8), littleEndian);
};

/** Release the sync access handle. */
ScratchSource.prototype.close = function () {
	this._handle.close();
};

/**
 * Open a scratch file as a sync source. Worker only.
 * @param {string} id
 * @param {{byteLength?: number, windowSize?: number, root?: object, dir?: string}} [options]
 *   byteLength caps the logical length (scratch files may be padded).
 * @returns {Promise<ScratchSource>}
 */
export async function openScratchReader(id, options) {
	var opts = options || {};
	var dir = await getScratchDir(opts);
	var fileHandle = await dir.getFileHandle(id);
	var handle = await fileHandle.createSyncAccessHandle();
	var size = handle.getSize();
	var length = typeof opts.byteLength === "number" ? Math.min(opts.byteLength, size) : size;
	return new ScratchSource(handle, length, opts.windowSize || DEFAULT_WINDOW_SIZE);
}

/**
 * Delete a scratch file. A missing file is not an error.
 * @param {string} id
 * @param {{root?: object, dir?: string}} [options]
 */
export async function removeScratchFile(id, options) {
	var dir = await getScratchDir(options);
	try {
		await dir.removeEntry(id);
	} catch (err) {
		if (!err || err.name !== "NotFoundError") throw err;
	}
}

/**
 * Delete scratch files last modified more than maxAgeMs ago.
 * Files still locked by another tab or worker are skipped, not fatal.
 * @param {{maxAgeMs?: number, now?: number, root?: object, dir?: string}} [options]
 * @returns {Promise<number>} count removed
 */
export async function sweepStaleScratchFiles(options) {
	var opts = options || {};
	var maxAgeMs = typeof opts.maxAgeMs === "number" ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
	var now = typeof opts.now === "number" ? opts.now : Date.now();
	var dir = await getScratchDir(opts);
	var stale = [];
	for await (var handle of dir.values()) {
		if (handle.kind !== "file") continue;
		var file = await handle.getFile();
		if (now - file.lastModified > maxAgeMs) stale.push(handle.name);
	}
	var removed = 0;
	for (var i = 0; i < stale.length; i++) {
		try {
			await removeScratchFile(stale[i], opts);
			removed++;
		} catch (err) {
			if (!err || LOCKED_ERRORS.indexOf(err.name) < 0) throw err;
		}
	}
	return removed;
}

/**
 * Files in a scratch directory, sorted by name.
 * @param {{root?: object, dir?: string}} [options]
 * @returns {Promise<Array<{name:string, size:number, lastModified:number}>>}
 */
export async function listScratchFiles(options) {
	var dir = await getScratchDir(options);
	var list = [];
	for await (var handle of dir.values()) {
		if (handle.kind !== "file") continue;
		var file = await handle.getFile();
		list.push({ name: handle.name, size: file.size, lastModified: file.lastModified });
	}
	list.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
	return list;
}

/**
 * A scratch file as a File (usable anywhere a dropped File is, e.g. openLas).
 * Works on the main thread; no sync handle is taken.
 * @param {string} id
 * @param {{root?: object, dir?: string}} [options]
 * @returns {Promise<File>}
 */
export async function getScratchFile(id, options) {
	var dir = await getScratchDir(options);
	var handle = await dir.getFileHandle(id);
	return handle.getFile();
}
