// test/helpers/sinks.js
//==========================================================
// A { write(bytes, position) } sink collecting into memory, as
// createLasWriter takes. Test-only.
//==========================================================

export function memorySink() {
	var buf = new Uint8Array(1 << 16), end = 0;
	return {
		write: function (bytes, at) {
			if (at + bytes.length > buf.length) { var g = new Uint8Array(Math.max(buf.length * 2, at + bytes.length)); g.set(buf); buf = g; }
			buf.set(bytes, at);
			end = Math.max(end, at + bytes.length);
		},
		bytes: function () { return buf.slice(0, end); }
	};
}
