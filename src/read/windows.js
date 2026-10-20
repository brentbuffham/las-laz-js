// src/read/windows.js
//==========================================================
// Split the point data into byte windows of WHOLE records, so a
// window never ends half way through a record and a file of any
// size is read a few MB at a time. Positions are plain Numbers
// (counts x lengths stay far below 2^53).
//==========================================================

/**
 * @param {object} header - { offsetToPointData, recordLength, pointCount }
 * @param {number} windowSize - target bytes per window
 * @returns {Array<{start:number, end:number, firstRecord:number, count:number}>}
 */
export function windows(header, windowSize) {
	var len = header.recordLength;
	var per = Math.max(1, Math.floor(windowSize / len));
	var out = [];
	for (var first = 0; first < header.pointCount; first += per) {
		var count = Math.min(per, header.pointCount - first);
		var start = header.offsetToPointData + first * len;
		out.push({ start: start, end: start + count * len, firstRecord: first, count: count });
	}
	return out;
}
