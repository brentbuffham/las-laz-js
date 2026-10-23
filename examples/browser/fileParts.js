// examples/browser/fileParts.js
//==========================================================
// The demo's in-memory Save sink, for browsers without the File System
// Access Save dialog: createLasWriter's positioned writes kept as
// ordered parts. A write at the end appends a part; one inside a part
// (the header patched at close, LAZ's chunk-table offset) is patched
// into it. So the file is held once, and new Blob(parts()) makes it
// without a second full copy. Any other pattern (a gap, a write across
// parts) falls back to one contiguous buffer, still exact.
//==========================================================

/**
 * @returns {{sink: {write: function(Uint8Array, number)}, parts: function(): Uint8Array[], size: function(): number}}
 */
export function createPartsSink() {
	var parts = [], end = 0, flat = null;   // parts: [{ at, bytes }] in order, contiguous from 0

	function toFlat(need) {
		flat = new Uint8Array(Math.max(end, need));
		parts.forEach(function (p) { flat.set(p.bytes, p.at); });
		parts = null;
	}
	function write(bytes, pos) {
		var b = bytes.slice(), stop = pos + b.length;   // copied: the writer may reuse its buffer
		if (!flat) {
			if (pos === end) { parts.push({ at: pos, bytes: b }); end = stop; return; }
			for (var i = 0; i < parts.length; i++) {
				var p = parts[i];
				if (pos >= p.at && stop <= p.at + p.bytes.length) { p.bytes.set(b, pos - p.at); return; }
			}
			toFlat(stop);
		}
		if (stop > flat.length) {
			var grown = new Uint8Array(Math.max(stop, flat.length * 2));
			grown.set(flat);
			flat = grown;
		}
		flat.set(b, pos);
		end = Math.max(end, stop);
	}
	return {
		sink: { write: write },
		parts: function () { return flat ? [flat.subarray(0, end)] : parts.map(function (p) { return p.bytes; }); },
		size: function () { return end; }
	};
}
