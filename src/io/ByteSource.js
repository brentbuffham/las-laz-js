// src/io/ByteSource.js
//==========================================================
// Helpers that work on any object meeting the source contract
// (MemorySource, ScratchSource).
// ⚠️ 64-bit values are built as hi * 2^32 + lo, never with <<,
// because LAS 1.4 counts and EVLR offsets are 64-bit.
//==========================================================

var TWO_POW_32 = 4294967296;
// Largest hi word that keeps hi * 2^32 + lo within MAX_SAFE_INTEGER
var MAX_SAFE_HI = 0x1FFFFF;

/**
 * Read an unsigned 64-bit integer.
 * @param {object} source - Source contract.
 * @param {number} pos
 * @param {boolean} littleEndian
 * @returns {number|null} the value, or null above Number.MAX_SAFE_INTEGER
 */
export function readU64(source, pos, littleEndian) {
	var hi = source.getUint32(littleEndian ? pos + 4 : pos, littleEndian);
	var lo = source.getUint32(littleEndian ? pos : pos + 4, littleEndian);
	if (hi > MAX_SAFE_HI) return null;
	return hi * TWO_POW_32 + lo;
}

/**
 * Read a NUL-terminated ASCII string of at most maxLength bytes.
 * Stops at the first 0x00, at maxLength, or at the end of the source.
 * Bytes above 0x7E become "?".
 * @returns {string}
 */
export function readAscii(source, pos, maxLength) {
	var end = Math.min(pos + maxLength, source.length());
	var text = "";
	for (var i = pos; i < end; i++) {
		var b = source.getUint8(i);
		if (b === 0) break;
		text += b > 0x7E ? "?" : String.fromCharCode(b);
	}
	return text;
}
