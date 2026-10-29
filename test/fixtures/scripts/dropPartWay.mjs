// test/fixtures/scripts/dropPartWay.mjs
//==========================================================
// Takes the first window of a parallel LAZ read and drops the rest, so the
// pool is never closed. Run as a child: it must print the count and exit.
//==========================================================
import { fileURLToPath } from "node:url";
import { openLas } from "../../../src/LasReader.js";

var las = await openLas(fileURLToPath(new URL("../laz/f7.laz", import.meta.url)), { threads: 2, windowSize: 1000 });
var first = await las.chunks({ fields: ["x"] }).next();
// a string, not console.log(number): with FORCE_COLOR set (some terminals do) a logged number is wrapped in colour codes
process.stdout.write(String(first.value.count) + "\n");
