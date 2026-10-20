# las-laz-js — Library Design Spec

- **Status:** design agreed in chat 2026-10-21; this spec awaits Brent's review
- **Author:** Brent Buffham (https://kirra-design.com), with Claude
- **Demo spec:** `2026-10-21-las-laz-js-demo-design.md`

## 1. Intent

A clean, professional JavaScript library for reading and writing ASPRS **LAS** and **LAZ**
point clouds, published on npm as `las-laz-js` — the sibling of `ecw-js`, in the same style.
It takes the LAS reader, writer and big-file handling Kirra already has, makes them
independent of Kirra, and adds a vanilla-JavaScript LAZ codec.

Decisions (Brent, 2026-10-20/21):
- Vanilla JavaScript, **zero dependencies**, ES modules, the **browser and Node 22+**.
- "Clean and professional like ecw-js".
- LAZ decoder **ported from laz-rs** (MIT / Apache-2.0 dual licence), so the library stays MIT.
- Releases: **0.1.0** read + write LAS · **0.2.0** read LAZ · **0.3.0** write LAZ.
- **Kirra switches to the library at 0.2.0** (one migration, proven by identical output).
- Every library ships a demo; this one is a **Three.js** viewer (demo spec).

## 2. Package

```
las-laz-js
├─ src/
│  ├─ index.js            public API
│  ├─ LasReader.js        openLas → reader object
│  ├─ errors.js           typed errors
│  ├─ format/             public header, VLR / EVLR, GeoKeys + WKT, point-format tables (0–10)
│  ├─ io/                 ByteSource, BlobSource, MemorySource, NodeFileSource, ScratchBinaryFile (OPFS)
│  ├─ read/               record decoding into columns, chunk iterator, scratch output
│  ├─ write/              LAS writer (header, VLRs, records; streaming sink)
│  ├─ filter/             classes, returns, bounds, stride (maxPoints), dedupe
│  ├─ colour/             rgb, intensity, elevation, classification ramps
│  ├─ laz/                (0.2.0) arithmetic decoder, point10 / gpstime / rgb / layered 1.4 decoders
│  └─ workers/            lasWorker.js + workerProtocol.js
├─ test/                  node --test, coverage thresholds as ecw-js
├─ docs/                  LAS_FORMAT_NOTES.md, design/
├─ plans/                 implementation plans
├─ examples/browser/      the Three.js demo (never in the npm package)
├─ _dev/                  serve.mjs (demo), checkPrivate.mjs (private-sample guard)
└─ CHANGELOG.md, README.md, LICENSE (MIT)
```

`package.json` mirrors ecw-js: `"type": "module"`, `exports` `"."` and `"./worker"`,
`files` = `src`, `README.md`, `LICENSE`, `CHANGELOG.md`; `sideEffects: false`;
`engines.node >= 22`; scripts `test`, `test:coverage`, `demo`, `check:private`.

## 3. API (0.1.0)

### Open
`openLas(source, opts?) → Promise<LasReader>` — `source` is a File / Blob, an ArrayBuffer /
Uint8Array, a Node file path, or a `ByteSource`. Reads the public header and VLRs only.

`reader.header` — version, point format and record length, point count (64-bit aware, as a
Number), bounds, scale, offset, system identifier, generating software, creation date,
global encoding, and the per-return counts.
`reader.vlrs`, `reader.evlrs` — raw records (user id, record id, description, bytes).
`reader.crs` — parsed GeoKey directory (EPSG codes where present) or OGC WKT. **Parsed, never
reprojected**: the library has no projection dependency; callers (Kirra) reproject.
`reader.compressed` — true for LAZ. In 0.1.0, reading points from it throws `LasError`
`COMPRESSED_LAZ` ("Compressed LAZ is supported from 0.2.0") — never a DataView crash.

### Read
`reader.readPoints(opts) → Promise<PointColumns>`

| Option | Meaning |
|---|---|
| `fields` | which fields to decode (`x y z intensity returnNumber numberOfReturns classification scanAngle userData pointSourceId gpsTime red green blue nir …`); default x, y, z + colour when present |
| `classes`, `returns` | keep only these classification codes / return numbers |
| `bounds` | keep points inside a 3D box (world coordinates) |
| `maxPoints` | even stride down to this many; `0` = every point |
| `dedupe` | drop points within this XY(Z) tolerance of a kept one |
| `localOrigin` | `{x, y, z?}` subtracted before storing; with `float32: true` coordinates are stored as Float32 — the anti-jitter rule for GPU drawing |
| `onProgress`, `signal` | progress callback (0–1) and an AbortSignal |

`PointColumns` — `{ count, x, y, z, … }`, one typed array per field (Float64 coordinates by
default; Uint16 intensity / colour; Uint8 classification …), plus `bounds` and `stats`.

`reader.chunks(opts)` — an async iterator of `PointColumns` windows (same options) for files
larger than memory. `reader.readPointsToScratch(opts)` — writes the selected columns to OPFS
`ScratchBinaryFile`s and returns handles (browser).

### Colour
`colourize(points, { by: "rgb" | "intensity" | "elevation" | "classification", ramp?, range? })
→ Uint8Array` (r, g, b per point). LAS 16-bit colour is scaled to 8 bits. **New (not in
Kirra):** files that store 8-bit values in the 16-bit fields (a common writer bug) are detected
from the maximum and not divided by 256 — Kirra's reader divides unconditionally
(`lasImportWorker.js:198`), which turns such files almost black. Classification uses the usual
LiDAR-viewer colours (ASPRS defines the codes, not colours).

### Write
`writeLas(points, opts) → Promise<Blob | Uint8Array>` — `version` (1.2 / 1.4), `pointFormat`,
`scale`, `offset` (chosen from the bounds when omitted), `crs` (GeoKeys / WKT VLR),
`software`. `createLasWriter(sink, opts)` streams records for outputs too big for memory.

### Worker
`las-laz-js/worker` — a module Worker running open / read / colour with transferred buffers;
`workerProtocol.js` documents the messages (progress, result, error).

### Errors
One class, `LasError(code, message, offset?)`, with frozen `ERROR_CODES` — the same shape as
ecw-js's `EcwError` (changed from three classes when planning, 2026-10-21). Codes: `NOT_LAS`,
`UNSUPPORTED_VERSION`, `UNSUPPORTED`, `COMPRESSED_LAZ`, `TRUNCATED`, `BAD_HEADER`, `BAD_VLR`,
`INVALID_ARGUMENT`, `ABORTED`, `TOO_MANY_POINTS`.

## 4. Big-file rules (Kirra's findings, written in)

1. **Never one ArrayBuffer for the file** — read fixed windows (default 64 MB, aligned to whole
   records) from the ByteSource. Kirra's current import reads the whole file; the library fixes
   that.
2. **Byte positions are plain Numbers** — never `<<`, `>>`, `|0` on a position (int32 wraps
   past 2 GB). Enforced by a source-scan test.
3. **Columns of typed arrays**, never an object per point.
4. **No text decoding of point data**; strings only for header fields.
5. **64-bit counts** (LAS 1.4 `uint64`) read as Number; refuse > 2^53 with a clear error.
6. **Heavy work in the worker** with transferable buffers; OPFS scratch for outputs above memory.
7. **Float32 only after a local origin** — raw UTM in Float32 jitters (Kirra §7a).

## 5. Testing (oracles, not snapshots)

- **Hand-built files**: tiny LAS files encoded byte by byte from the ASPRS 1.2 / 1.4 spec
  (every point format 0–10), with every field value chosen and checked by hand.
- **Round trip**: write → read returns the same values, every format, LAS 1.2 and 1.4.
- **Filters**: hand-worked counts for classes / returns / bounds / stride / dedupe.
- **Big-file**: a synthetic file larger than one window reads identically chunked and whole.
- **Real files** (private, gitignored, `check:private` before every push): Brent's LAS files
  checked as a black box against CloudCompare / PDAL output (counts, bounds, sampled points).
- **Source guard**: no int32 operators on positions; no dependency in `package.json`.
- Coverage thresholds as ecw-js (lines 97, branches 88, functions 97).

## 6. Later releases

- **0.2.0 — read LAZ.** Port of laz-rs: arithmetic decoder, LASzip chunk table, point10 /
  gpstime11 / rgb12 (formats 0–3) and the layered 1.4 decoders (formats 6–8). Oracle: each of
  Brent's `.laz` files decodes to exactly the records of its `.las` twin (a 1 M-point pair and
  a 28 M-point pair, kept private). README credits laz-rs. Kirra adopts the library here: its LAS
  import / export call `las-laz-js`; Kirra's output before and after must match.
- **0.3.0 — write LAZ.** Encoders for the same formats; oracle: round trip through the 0.2.0
  reader, and the files open in CloudCompare / PDAL.

## 7. Out of scope

Reprojection (callers do it), waveform data packets (formats 4/5/9/10 point fields are read;
the waveform payload is not), COPC / EPT tiling, E57.

## 8. Notes

- `ScratchBinaryFile` is a third copy (Kirra, ecw-js, here). Copy it now, say so in its header;
  a shared micro-package can come later.
- The README carries a provenance section as ecw-js does: the LAS code from Kirra (Brent's own),
  the LAZ codec ported from laz-rs under its MIT licence.
