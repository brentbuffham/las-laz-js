// test/package.test.js
//==========================================================
// Package shape: zero-dependency ES module with the npm fields
// the spec pins (design §2). Run with: node --test test/package.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

var pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package is a zero-dependency ES module", function () {
	assert.equal(pkg.name, "las-laz-js");
	assert.equal(pkg.type, "module");
	assert.equal(pkg.license, "MIT");
	assert.equal(pkg.sideEffects, false);
	assert.deepEqual(pkg.engines, { node: ">=22" });
	assert.equal(pkg.dependencies, undefined);
	assert.equal(pkg.devDependencies, undefined);
	assert.deepEqual(pkg.files, ["src", "README.md", "LICENSE", "CHANGELOG.md"]);
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
