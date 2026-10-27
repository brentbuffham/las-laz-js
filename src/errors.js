// src/errors.js
//==========================================================
// LasError: every failure the library raises carries a stable
// `code` (see ERROR_CODES) and, for byte-level problems, the
// file `offset` where it was detected. Callers branch on `code`;
// the offset is appended to the message for humans.
// Same shape as ecw-js's EcwError.
//==========================================================

/** Stable error codes. Each value equals its key. */
export var ERROR_CODES = Object.freeze({
	NOT_LAS: "NOT_LAS",
	UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
	UNSUPPORTED: "UNSUPPORTED",
	COMPRESSED_LAZ: "COMPRESSED_LAZ",
	TRUNCATED: "TRUNCATED",
	BAD_HEADER: "BAD_HEADER",
	BAD_VLR: "BAD_VLR",
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
	ABORTED: "ABORTED",
	TOO_MANY_POINTS: "TOO_MANY_POINTS",
	BAD_STORE: "BAD_STORE",
	NO_SPACE: "NO_SPACE"
});

/**
 * Error raised by las-laz-js.
 * @param {string} code - One of ERROR_CODES.
 * @param {string} message - Human-readable description.
 * @param {number} [offset] - Byte offset in the file, when relevant.
 */
export class LasError extends Error {
	constructor(code, message, offset) {
		var text = typeof offset === "number" ? message + " (at 0x" + offset.toString(16) + ")" : message;
		super(text);
		this.name = "LasError";
		this.code = code;
		this.offset = offset;
	}
}
