// test/dev/serveCore.test.js
//==========================================================
// Dev server request resolution and content types.
// Run with: node --test test/dev/serveCore.test.js
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentType, resolveRequest } from "../../_dev/serveCore.mjs";

var ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("content types", function () {
	assert.equal(contentType("a/index.html"), "text/html; charset=utf-8");
	assert.equal(contentType("a/x.js"), "text/javascript; charset=utf-8");
	assert.equal(contentType("a/x.mjs"), "text/javascript; charset=utf-8");
	assert.equal(contentType("a/x.css"), "text/css; charset=utf-8");
	assert.equal(contentType("a/x.json"), "application/json");
	assert.equal(contentType("a/x.svg"), "image/svg+xml");
	assert.equal(contentType("a/x.PNG"), "image/png");
	assert.equal(contentType("a/x.ecw"), "application/octet-stream");
});

test("root redirects to the demo", function () {
	assert.deepEqual(resolveRequest(ROOT, "/"), { status: 302, location: "/examples/browser/" });
});

test("a file resolves inside the root", function () {
	assert.deepEqual(resolveRequest(ROOT, "/package.json"), { status: 200, file: join(ROOT, "package.json") });
});

test("a directory resolves to its index.html when present", function () {
	var dir = resolveRequest(ROOT, "/src/");
	assert.equal(dir.status, 404);
});

test("query strings are ignored", function () {
	assert.deepEqual(resolveRequest(ROOT, "/package.json?v=1"), { status: 200, file: join(ROOT, "package.json") });
});

test("paths escaping the root are refused", function () {
	assert.equal(resolveRequest(ROOT, "/../package.json").status, 403);
	assert.equal(resolveRequest(ROOT, "/..%2f..%2fetc%2fpasswd").status, 403);
	assert.equal(resolveRequest(ROOT, "/src/%2e%2e/%2e%2e/x").status, 403);
});

test("missing files are 404", function () {
	assert.equal(resolveRequest(ROOT, "/nope.txt").status, 404);
});

test("malformed escapes are 400", function () {
	assert.equal(resolveRequest(ROOT, "/%E0%A4%A").status, 400);
});
