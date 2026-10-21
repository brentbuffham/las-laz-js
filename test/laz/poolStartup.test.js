// test/laz/poolStartup.test.js
//==========================================================
// Worker start-up: a pool whose workers cannot start is null (the reader
// then decodes on its own thread), and Node workers start even when the
// parent ran with flags a worker rejects (--input-type from node -e), and
// an open pool never keeps Node running.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLazPool } from "../../src/laz/pool.js";

var ROOT = fileURLToPath(new URL("../../", import.meta.url));
var THROWS = new URL("../fixtures/workers/throwsOnLoad.js", import.meta.url);
var DROP = fileURLToPath(new URL("../fixtures/scripts/dropPartWay.mjs", import.meta.url));

test("workers start in this process, so the parallel tests really decode on workers", async function () {
	var pool = await createLazPool(2);
	assert.ok(pool, "no pool: every parallel test would quietly run on one thread");
	pool.close();
});

test("workers that fail while loading give no pool (one-thread fallback), not a failed read", async function () {
	assert.equal(await createLazPool(2, THROWS), null);
});

test("node --input-type=module -e: the pool starts and a parallel read decodes", function () {
	var code = [
		"import { createLazPool } from './src/laz/pool.js';",
		"import { openLas } from './src/LasReader.js';",
		"import { readFileSync } from 'node:fs';",
		"var pool = await createLazPool(2);",
		"var started = pool !== null; if (pool) pool.close();",
		"var b = new Uint8Array(readFileSync('test/fixtures/laz/f3.laz'));",
		"var p = await (await openLas(b, { threads: 2 })).readPoints({ fields: ['x'] });",
		"console.log(JSON.stringify({ started: started, count: p.count }));"
	].join("\n");
	var out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
	var r = JSON.parse(out.trim());
	assert.equal(r.started, true, "the pool must start under --input-type");
	assert.ok(r.count > 0);
});

test("a script that drops a parallel read part way (pool never closed) still exits", function () {
	var out = execFileSync(process.execPath, [DROP], { encoding: "utf8", timeout: 20000 });
	assert.equal(Number(out.trim()), 50000);
});
