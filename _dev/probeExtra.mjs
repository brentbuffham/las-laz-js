// _dev/probeExtra.mjs
// Which samples carry extra bytes: record length past the format, and the Extra Bytes VLR's descriptors
import fs from "node:fs";
import { openLas, POINT_FORMATS } from "../src/index.js";

var paths = fs.readFileSync(new URL("../samples/paths.txt", import.meta.url), "utf8").split(/\r?\n/).filter(function (l) { return l && l[0] !== "#"; });
paths.push(new URL("../samples/Cloud.las", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
var NAMES = { 0: "raw", 1: "u8", 2: "i8", 3: "u16", 4: "i16", 5: "u32", 6: "i32", 7: "u64", 8: "i64", 9: "f32", 10: "f64" };
for (var i = 0; i < paths.length; i++) {
	var p = paths[i];
	if (!fs.existsSync(p)) { console.log("s" + i, "missing"); continue; }
	try {
		var r = await openLas(p), h = r.header;
		var eb = r.vlrs.concat(r.evlrs).filter(function (v) { return v.userId === "LASF_Spec" && v.recordId === 4; });
		var desc = [];
		eb.forEach(function (v) {
			if (!v.bytes) return;
			var dv = new DataView(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength);
			for (var at = 0; at + 192 <= v.bytes.length; at += 192) {
				var name = ""; for (var c = 4; c < 36 && v.bytes[at + c]; c++) name += String.fromCharCode(v.bytes[at + c]);
				var t = v.bytes[at + 2], opt = v.bytes[at + 3];
				desc.push(name + ":" + (NAMES[t] || "t" + t) + (t === 0 ? "[" + opt + "]" : "") + (opt & 8 ? " scale " + dv.getFloat64(at + 112, true) : "") + (opt & 16 ? " off " + dv.getFloat64(at + 136, true) : ""));
			}
		});
		console.log("s" + i, "v1." + h.versionMinor, "fmt " + h.pointFormat, (h.compressed ? "LAZ" : "LAS"), "len " + h.recordLength, "extra " + h.extraBytes, h.pointCount + " pts", desc.join(", ") || (h.extraBytes ? "(no descriptors)" : ""), "| " + h.software.trim());
		await r.close();
	} catch (e) { console.log("s" + i, "error", e.message); }
}
