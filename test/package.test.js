// test/package.test.js
//==========================================================
// Package shape: zero-dependency ES module with the npm fields
// the spec pins (design §2). Run with: node --test test/package.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

var pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package is a zero-dependency ES module", function () {
	assert.equal(pkg.name, "las-laz-js");
	assert.equal(pkg.type, "module");
	assert.equal(pkg.license, "MIT AND Apache-2.0");   // src/laz/ is translated from laz-rs (Apache-2.0)
	assert.equal(pkg.sideEffects, false);
	assert.deepEqual(pkg.engines, { node: ">=22" });
	assert.equal(pkg.dependencies, undefined);
	assert.equal(pkg.devDependencies, undefined);
	assert.deepEqual(pkg.files, ["src", "README.md", "LICENSE", "LICENSE-APACHE", "NOTICE", "CHANGELOG.md"]);
	assert.equal(pkg.exports["."], "./src/index.js");
});

test("VERSION export matches package.json", async function () {
	var mod = await import("../src/index.js");
	assert.equal(mod.VERSION, pkg.version);
});

test("CHANGELOG has a section for the package version", function () {
	var log = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
	var heading = "## " + pkg.version;
	var lines = log.split("\n").map(function (l) { return l.trim(); });
	assert.ok(lines.some(function (l) { return l === heading || l.indexOf(heading + " ") === 0; }), "no " + heading + " section");
});

test("the worker entry is exported", function () {
	assert.equal(pkg.exports["./worker"], "./src/workers/lasWorker.js");
});

// Apache-2.0 section 4: translated files keep the notice and say they were changed
test("(static pin) every src/laz file names laz-rs, the Apache licence and the change", function () {
	var dir = new URL("../src/laz/", import.meta.url);
	var missing = [];
	(function walk(d) {
		readdirSync(d, { withFileTypes: true }).forEach(function (e) {
			var u = new URL(e.name + (e.isDirectory() ? "/" : ""), d);
			if (e.isDirectory()) return walk(u);
			if (!/\.js$/.test(e.name)) return;
			var head = readFileSync(u, "utf8").slice(0, 1500);
			if (!/laz-rs/.test(head) || !/Apache License, Version 2\.0/.test(head) || !/Changes:/.test(head)) missing.push(e.name);
		});
	})(dir);
	assert.deepEqual(missing, []);
	assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /Apache License, Version 2\.0/);
	assert.match(readFileSync(new URL("../LICENSE-APACHE", import.meta.url), "utf8"), /^Apache License/);
});
