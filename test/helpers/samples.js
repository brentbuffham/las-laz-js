// test/helpers/samples.js
//==========================================================
// Locates private sample point clouds: *.las / *.laz in the
// gitignored samples/ folder, plus absolute paths listed one per
// line in samples/paths.txt (so big files are tested where they
// already live, never copied). Samples are identified by id
// (s1, s2 …), never by file name, so test output cannot leak them.
// Test-only. LAS_NO_SAMPLES=1 runs the suite as CI sees it.
//==========================================================

import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

var SAMPLES_DIR = fileURLToPath(new URL("../../samples/", import.meta.url));

/**
 * @returns {Array<{id:string, path:string, size:number, laz:boolean}>}
 */
export function findSamples() {
	if (process.env.LAS_NO_SAMPLES === "1" || !fs.existsSync(SAMPLES_DIR)) return [];
	var paths = fs.readdirSync(SAMPLES_DIR).filter(function (n) { return /\.la[sz]$/i.test(n); }).sort().map(function (n) { return join(SAMPLES_DIR, n); });
	var listFile = join(SAMPLES_DIR, "paths.txt");
	if (fs.existsSync(listFile)) {
		fs.readFileSync(listFile, "utf8").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && l[0] !== "#"; }).forEach(function (p) {
			if (fs.existsSync(p)) paths.push(p);
		});
	}
	return paths.map(function (p, i) {
		return { id: "s" + (i + 1), path: p, size: fs.statSync(p).size, laz: /\.laz$/i.test(p) };
	});
}
