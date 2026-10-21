# las-laz-js

A JavaScript reader and writer for ASPRS **LAS** point clouds, and a reader for **LAZ**
(LASzip-compressed LAS), published on npm as `las-laz-js`. Plain ES modules, no dependencies,
runs in the browser and in Node — and built for files far larger than memory.

**Status: early (0.x).** It works and is tested, but the API may still change before 1.0.

- Working: `openLas` reads the header, VLRs / EVLRs and coordinate system of LAS 1.0–1.4;
  `readPoints` and `chunks` decode every point format (0–10) a window at a time, with filters
  and thinning; `colourize` colours points; `writeLas` writes LAS 1.0–1.4.
- LAZ: point formats 0–3 and 6–8, with extra bytes, read exactly like LAS — the same calls, the
  same options, decoded chunk by chunk in plain JavaScript (no WebAssembly).
- Big files: a 1.1 GB, 34-million-point LAS reads in under a second in Node, and a 10-million-point
  LAZ decodes at about 1.8 million points a second; neither is held in memory whole (see LAZ below
  for the one exception).
- Also: a ready-made module Worker (`las-laz-js/worker`) and a
  [Three.js demo](https://brentbuffham.github.io/las-laz-js/).
- Not yet: writing LAZ (0.3.0).

## Install

```sh
npm install las-laz-js
```

Node 22 or newer, or any current browser. No dependencies.

## Demo

Try it in the browser: **https://brentbuffham.github.io/las-laz-js/**

Drop a LAS or LAZ file onto the page. It is read locally (never uploaded), in the library's
Worker, and streamed into a Three.js viewer. The side panel shows the header, VLRs, coordinate
system and LAZ compression; reads with class, return, bounds, thinning and dedupe filters;
colours by RGB, intensity, elevation or class; lists point statistics; and saves the points back
out as LAS. To run it locally: `npm run demo`, then open http://localhost:8080/.

## Reading

```js
import { openLas } from "las-laz-js";

var las = await openLas(file);           // File / Blob, ArrayBuffer, Uint8Array, a Node path, or { size, read }
las.header;   // { versionMajor, versionMinor, pointFormat, pointCount, bounds, scale, offset,
              //   software, systemId, creationDay, creationYear, pointsByReturn, compressed, ... }
las.crs;      // { kind: "geokeys" | "wkt" | null, epsg, wkt?, keys? } — parsed, never reprojected
las.vlrs;     // [{ userId, recordId, description, start, length, bytes }]
las.evlrs;    // the same; an EVLR over 64 KiB (waveform data) has bytes: null until
              //   await las.readEvlrBytes(i) — opening never reads it
las.compressed; las.laz;   // true for LAZ; its compressor, chunk size and items (else null)

var pts = await las.readPoints({
	fields: ["x", "y", "z", "classification", "red", "green", "blue"],
	classes: [2],            // keep only these classification codes
	returns: [1],            // keep only these return numbers
	bounds: { minX, maxX, minY, maxY, minZ, maxZ },
	maxPoints: 5000000,      // even thinning; 0 keeps every point
	dedupe: 0.01,            // drop points within 1 cm (XY; dedupeZ: true for 3D)
	localOrigin: { x: 478000, y: 6772000 }, float32: true,   // small Float32 coordinates for the GPU
	onProgress: function (fraction, label) {},
	signal: abortController.signal
});
pts.count; pts.x; pts.y; pts.z;   // one typed array per field
pts.bounds; pts.stats;            // world bounds, per-class counts
```

Fields: `x y z intensity returnNumber numberOfReturns scanDirection edgeOfFlightLine
classification classificationFlags scannerChannel scanAngle userData pointSourceId gpsTime
red green blue nir`. Fields a point format does not hold are left out. `scanAngle` is in
degrees for every format.

Filters run on the raw record before it is decoded, so a filtered-out point costs a byte read.
`maxPoints` keeps exactly that many of the points that pass the filters, spread evenly over
the whole file; with filters set it first counts the passing points, which reads the file twice.

## LAZ

A LAZ file is opened and read with the same calls as LAS. Each LASzip chunk (50,000 points in
most files) is decompressed into the plain LAS records it holds, then decoded exactly as a LAS
window is — so every option above works the same, and reading a LAZ gives the same columns as
reading the LAS it was compressed from.

- Read: point formats 0–3 (LASzip point-wise, item version 2) and 6–8 (layered, item version 3),
  with extra bytes. Item version 4 follows laz-rs but has not been checked against a real file
  (it differs from 3 only with several scanner channels).
- Not read: wave-packet items (formats 4, 5, 9, 10 in LAZ), item version 1 (LASzip before 2011),
  and files without a chunk table (an unfinished write). Each is refused with `UNSUPPORTED`,
  naming what it found — never garbage points.
- A LAZ file cut short is `TRUNCATED`.

## Files bigger than memory

`openLas` reads only the header and the VLRs. Points are read in windows (64 MiB of records by
default, `openLas(file, { windowSize })`; for LAZ, whole chunks adding up to about that much
decompressed), so memory holds one window plus what you keep. One exception: a LAZ written
point-wise without chunks (LASzip before 2.0, rare) is one chunk, so its window is the whole
decompressed file.

```js
for await (var chunk of las.chunks({ fields: ["x", "y", "z"] })) {
	draw(chunk);          // one window's points
}
```

In the browser, `readPointsToScratch` streams the selected columns into OPFS scratch files (one
per field) instead of memory; run it in a Worker, which OPFS sync access needs.

## Colour

```js
import { colourize } from "las-laz-js";
var rgb = colourize(pts, { by: "elevation" });   // "rgb" | "intensity" | "elevation" | "classification"
```

Returns a `Uint8Array`, three bytes per point. LAS colour is 16-bit and is scaled to 8 bits —
except in files that store 8-bit values in the 16-bit fields (a common writer bug), which are
detected and used as they are instead of turning almost black. Elevation uses a blue → cyan →
green → yellow → red ramp; intensity a greyscale over the 2nd–98th percentile; classification
the usual LiDAR-viewer colours (ASPRS defines the codes, not colours). For streamed chunks,
`createChunkColourizer` keeps one rule for the whole file, so windows match.

## Writing

```js
import { writeLas, createLasWriter } from "las-laz-js";

var bytes = await writeLas(pts, { version: "1.2", pointFormat: 3, crs: { epsg: 28350 } });
var v14 = await writeLas(pts, { version: "1.4", pointFormat: 7, crs: { wkt: las.crs.wkt } });

var w = await createLasWriter(sink, { version: "1.2", pointFormat: 3, scale, offset });
// sink: an OPFS writer from openScratchSyncWriter, a Node FileHandle, or any { write(bytes, position) }
await w.writePoints(batch1); await w.writePoints(batch2);
await w.close();   // patches the header totals
```

A version and point format that do not go together (format 6 in LAS 1.2) are refused, never
silently changed. Scale and offset are chosen from the bounds when not given. `crs.epsg`
writes a GeoKey record; `crs.wkt` a WKT record. Point formats 6–10 must carry WKT (LAS 1.4), so
an EPSG code alone is refused for them — the library has no projection database to turn a code
into WKT. Writing LAZ arrives in 0.3.0.

## In a Worker

```js
var worker = new Worker(new URL("las-laz-js/worker", import.meta.url), { type: "module" });
worker.postMessage({ id: 1, type: "open", payload: { blob: file } });
worker.postMessage({ id: 2, type: "chunks", payload: { fields: ["x", "y", "z"], colour: { by: "rgb" } } });
// replies: { id, type: "progress" | "chunk" | "result" | "error", ... }; buffers are transferred
```

The protocol is documented in `src/workers/workerProtocol.js` and can be driven directly with
`createWorkerHandler(post)`.

## Errors

Every failure is a `LasError` with a stable `code` (`ERROR_CODES`) and, for byte-level problems,
the file `offset`: `NOT_LAS`, `UNSUPPORTED_VERSION`, `UNSUPPORTED`, `TRUNCATED`, `BAD_HEADER`,
`BAD_VLR`, `INVALID_ARGUMENT`, `ABORTED`, `TOO_MANY_POINTS`. A file shorter than its header
promises is `TRUNCATED`, never garbage points. (`COMPRESSED_LAZ` is kept for 0.1 callers but is no
longer thrown: LAZ is read.)

## Scope

Reprojection is out of scope (the coordinate system is reported, not changed). Waveform
formats 4, 5, 9 and 10 have their point fields read from LAS; the waveform data itself is not.
COPC, EPT and E57 are not read.

## Provenance

The LAS reader, writer and big-file handling come from [Kirra](https://kirra-design.com),
Brent Buffham's blast-design app, rewritten as a standalone library. The LAZ decoder in
`src/laz/` is a JavaScript translation of [laz-rs](https://github.com/laz-rs/laz-rs) by Thomas
Montaigu, itself a Rust port of [LASzip](https://laszip.org) by Martin Isenburg (rapidlasso).
It is checked against an independent encoder: the test fixtures were compressed by
[PDAL](https://pdal.io), and every record must equal PDAL's own decompression.
Formats are written to the ASPRS LAS 1.4 R15 specification; see `docs/LAS_FORMAT_NOTES.md`.

## Development

```sh
npm test               # node --test, every test
npm run test:coverage  # with the coverage gate
npm run demo           # the demo on http://localhost:8080/
npm run check:private  # before every push: no private sample details in the repo
node _dev/makeLazFixtures.mjs   # remake test/fixtures/laz with PDAL (needs PDAL 2.x)
```

Private sample files go in the gitignored `samples/` folder, or are listed by path in
`samples/paths.txt`; the sample tests compare each file with its own header, and each LAZ with a
LAS twin (same count and bounds) field by field.

## Licence

`MIT AND Apache-2.0`. The library is MIT © Brent Buffham (`LICENSE`). The LAZ decoder in
`src/laz/`, translated from laz-rs / LASzip, is under the Apache License 2.0 (`LICENSE-APACHE`,
`NOTICE`). Both are permissive: use, change and ship it in open or closed software, keeping the
notices.
