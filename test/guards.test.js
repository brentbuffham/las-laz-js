// test/guards.test.js
//==========================================================
// Source guards (static scans of src/) for rules no behaviour test
// can police:
//  1. no int32 bit operators on a byte position or count — they
//     wrap past 2 GB (Kirra's "position arithmetic" trap); masks on
//     single field bytes are marked // bits-ok
//  2. no static node: import — the browser bundle must never load
//     Node modules (NodeFileSource imports node:fs lazily) — and no
//     dynamic import() of a LITERAL node: specifier either: browser
//     bundlers (esbuild, webpack) try to resolve a literal and fail
//     with "Could not resolve node:fs/promises"
//  3. nothing in src imports from test/ or outside the package
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

var SRC = fileURLToPath(new URL("../src/", import.meta.url));

function files(dir) {
	var out = [];
	readdirSync(dir).forEach(function (name) {
		var p = join(dir, name);
		if (statSync(p).isDirectory()) out = out.concat(files(p));
		else if (/\.js$/.test(name)) out.push(p);
	});
	return out;
}

var POSITION = /\b(pos|position|offset|start|end|count|size|first|len|length|at)\b/;
// bitwise "| 0" (not the logical "|| 0"), << and >> / >>>
var INT32_OP = /<<|>>>?|(^|[^|])\|\s*0\b/;

export function int32Hits(text, name) {
	var hits = [];
	text.split(/\r?\n/).forEach(function (line, i) {
		var code = line.replace(/\/\/.*$/, "");
		if (/bits-ok/.test(line) || /^\s*(\*|\/\*)/.test(line)) return; // marked masks; JSDoc ("Array<{...}>>")
		if (POSITION.test(code) && INT32_OP.test(code)) hits.push(name + ":" + (i + 1) + ": " + line.trim());
	});
	return hits;
}

test("no int32 bit operators on positions or counts in src/", function () {
	var hits = [];
	files(SRC).forEach(function (f) { hits = hits.concat(int32Hits(readFileSync(f, "utf8"), relative(SRC, f))); });
	assert.deepEqual(hits, []);
});

test("the guard itself catches a position shifted with <<, and accepts a marked byte mask", function () {
	assert.equal(int32Hits("var end = start << 2;", "x").length, 1);
	assert.equal(int32Hits("var n = count | 0;", "x").length, 1);
	assert.equal(int32Hits("var r = (rb >> 4) & 15; // bits-ok", "x").length, 0);
	assert.equal(int32Hits("var first = opts.firstIndex || 0;", "x").length, 0);
	assert.equal(int32Hits(" * @returns {Promise<Array<{size:number}>>}", "x").length, 0);
});

test("no static node: imports anywhere in src/", function () {
	var hits = [];
	files(SRC).forEach(function (f) {
		readFileSync(f, "utf8").split(/\r?\n/).forEach(function (line, i) {
			if (/^\s*import\s[^(]*["']node:/.test(line)) hits.push(relative(SRC, f) + ":" + (i + 1));
		});
	});
	assert.deepEqual(hits, []);
});

test("src never imports from test/ or from outside the package", function () {
	var hits = [];
	files(SRC).forEach(function (f) {
		var depth = relative(SRC, f).split(/[\\/]/).length - 1;
		readFileSync(f, "utf8").split(/\r?\n/).forEach(function (line, i) {
			var m = line.match(/^\s*(?:import|export)\s[^"']*["'](\.[^"']+)["']/);
			if (!m) return;
			var ups = (m[1].match(/\.\.\//g) || []).length;
			if (ups > depth || /\/test\//.test(m[1])) hits.push(relative(SRC, f) + ":" + (i + 1) + " " + m[1]);
		});
	});
	assert.deepEqual(hits, []);
});

test("(static pin) no dynamic import() of a literal node: specifier in src/", function () {
	var hits = [];
	files(SRC).forEach(function (f) {
		readFileSync(f, "utf8").split(/\r?\n/).forEach(function (line, i) {
			if (/import\(\s*(\/\*[^*]*\*\/\s*)*["'`]node:/.test(line)) hits.push(relative(SRC, f) + ":" + (i + 1));
		});
	});
	assert.deepEqual(hits, []);
});
