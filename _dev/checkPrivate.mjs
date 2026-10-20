// _dev/checkPrivate.mjs
//==========================================================
// Guard against leaking private sample details. Reads one pattern
// per line from the gitignored samples/private-patterns.txt and fails
// if any appears in tracked files or in commits not yet on origin.
// Usage: npm run check:private   (run before every push)
//==========================================================

import fs from "node:fs";
import { execFileSync } from "node:child_process";

var patternsFile = "samples/private-patterns.txt";
if (!fs.existsSync(patternsFile)) {
	console.log("check:private skipped: no " + patternsFile);
	process.exit(0);
}
var patterns = fs.readFileSync(patternsFile, "utf8").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
function git(args) {
	try { return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); } catch (err) { return err.stdout || ""; }
}
var tracked = git(["ls-files"]).split(/\r?\n/).filter(Boolean);
var unpushed = git(["log", "-p", "@{u}..HEAD"]);
var hits = [];
tracked.forEach(function (file) {
	if (!fs.existsSync(file) || fs.statSync(file).size > 5 * 1024 * 1024) return;
	var text = fs.readFileSync(file, "latin1");
	patterns.forEach(function (p) { if (text.indexOf(p) >= 0) hits.push(file + ": " + p); });
});
patterns.forEach(function (p) { if (unpushed.indexOf(p) >= 0) hits.push("unpushed commits: " + p); });
if (hits.length) {
	console.error("check:private FAILED\n" + hits.join("\n"));
	process.exit(1);
}
console.log("check:private ok (" + patterns.length + " patterns, " + tracked.length + " files)");
