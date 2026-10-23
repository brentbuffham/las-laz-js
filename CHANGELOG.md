# Changelog

## Unreleased

- Demo: Save writes every point. It streamed nothing over 5,000,000 points before: the Write tab thinned to a
  5 M page limit, and an unedited save re-read the file with the Read tab's Max points (5 M by default), so a
  55 M-point scan saved as under 5 M. Now an unedited save streams the whole file (every record that passes
  the class, return, bounds and crop filters; Max points only limits what is read for viewing) window by
  window through `createLasWriter`, and an edited save writes every edited point in batches. In Chrome and
  Edge the file goes straight to disk through the Save dialog, at any size; other browsers build it in memory
  and download it.

## 0.7.1 (2026-10-23)

Categorise: give selected points a LAS class, with names for your own classes.

- `classifyPoints(cols, selection, code, { overwrite, only, inPlace })` → `{ columns, changed }`.
  A point that already has a class keeps it by default: only points at 0 (created, never
  classified) or 1 (unclassified) change. `overwrite: true` changes every selected point; `only`
  lists the classes that may change. Copies by default (a new `classification` array, every other
  column shared, a `readPoints` result's `stats` dropped as stale); `inPlace` overwrites the input's
  array and keeps its `stats.classCounts` true. `overwrite` and `inPlace` must be booleans.
- `ASPRS_CLASSES`: the standard codes 0–22 (LAS 1.4 R15) and their names.
- Class names: `writeLas` and `createLasWriter` take `classNames: { code: name }` and write the
  Classification Lookup VLR (names of 1 to 15 printable ASCII characters); `openLas` reads it as
  `classNames` (`{}` when there is none or it is malformed; only names the writer would write back,
  printable ASCII and not all spaces); `parseClassLookup` is exported.
  The Worker's `open` result carries `classNames`.
- Colours: classes 19–22 have colours, and a code without one gets its own stable colour instead
  of grey, so user classes are told apart.
- Changed: a class above 31 in point formats 0–5 is refused (`INVALID_ARGUMENT`, naming the
  point). Those formats store 5 bits, and the writer used to drop the high bits silently (64
  became 0). The check runs before a batch touches the header totals, so a streaming writer that
  refuses a batch can still be closed with correct totals.
- Demo: a Categorise section on the Edit tab (Overwrite unticked by default, Add class, Undo
  classify), a class legend on the viewer, class names in Stats and in the saved file.

## 0.7.0 (2026-10-22)

Denoise: stray points, normals and smoothing, for fuzzy handheld scans.

- `selectOutliers(cols, { k = 8, multiplier = 2 })` selects stray points by PDAL's statistical
  outlier rule (a point's mean distance to its k nearest above the cloud's average plus
  `multiplier` standard deviations), for `removePoints`. Checked point for point against PDAL's
  `filters.outlier` `method=statistical`.
- `denoisePoints(cols, { method, k = 16, maxDistance, sigma, iterations = 1, normals, inPlace })`
  smooths the points against their neighbours (the other points among the k nearest within
  `maxDistance`, which is required): `"bilateral"` (default) moves each point along its normal
  and keeps crests sharp; `"mls"` moves it onto its neighbours' fitted plane. The noise level
  `sigma` is measured unless given. Returns columns as `transformPoints` does; `normals: true`
  adds a `normal` column.
- `pointNormals(cols, { k = 16, maxDistance })` → `{ normal, residual }`: unit normals (pointing
  up) and each point's RMS distance from its fitted plane; `estimateNoise` is the median residual
  over up to 100,000 points.
- `nearestPoints(index, point, k, { maxDistance, xy })` → `{ points, d }`: the k nearest on the
  0.6.0 voxel index, nearest first, ties to the lowest number.
- The denoise tools search an implicit k-d tree (about 4.6 bytes a point), which suits a scan's
  thousand-fold changes of density. On a 1 M-point handheld scan (Node): `selectOutliers` 2.5 s,
  `pointNormals` 4.6 s, `denoisePoints` 6.3 s, the measured noise going from 0.60 cm to 0.11 cm; on a
  34 M-point scan, `denoisePoints` takes about 3.7 min. A cluster of exact duplicates costs a search k
  points, not the cluster's size.
- Demo: a Denoise section on the Edit tab and a Roughness colour mode.

## 0.6.2 (2026-10-22)

- `dedupe` and `dedupeSelection` handle more than 16,777,216 occupied cells. They used a
  JavaScript Map, which stops at 2^24 entries, so a 20-30 M-point cloud at a small tolerance threw
  `RangeError: Map maximum size exceeded`. A typed-array hash table (5 bytes a slot) replaces
  it, with the same results and about 1.5 to 2 times the speed (2 M points: 0.9 s in 2D, 2.2 s in 3D).

## 0.6.1 (2026-10-22)

- Demo: a read bigger than the draw cap (20 M) is drawn as an even spread over the whole cloud,
  not its first 20 M points; selections and edits still act on every point read, and the
  selection line says how many selected points are on screen. `?drawCap=N` lowers the cap.

## 0.6.0 (2026-10-22)

Voxel neighbour index and the sparse-point (dust) filter.

- `selectSparse(cols, { radius, minNeighbours = 1, xy })` selects the points with fewer than
  `minNeighbours` other points within `radius` (inclusive), for `removePoints`. `minNeighbours: 1`
  keeps thin sparse features such as scanned blastholes. Checked point for point against PDAL's
  `filters.outlier` (`method=radius`; PDAL's `min_k` is `minNeighbours`, and PDAL does not count a
  point exactly `radius` away).
- `buildIndex(cols, { cellSize })`: a sorted voxel grid on flat typed arrays (6 to 8 bytes a point),
  over x / y / z or a k = 3 `positions` column, with exact queries: `nearestPoint` (3D, or `xy` in
  plan; `maxDistance`), `pointsInRadius` (a selection) and `pointsNearRay` (a cylinder or a cone,
  with each point's `t` along the ray and `d` from its axis, for a caller's snap). Rebuild it after
  any edit of the columns.
- `dedupeSelection(cols, tolerance, { z })` returns `dedupe`'s kept points as a selection and a
  `map` from every input point to the kept point it merged into (its nearest within the tolerance).
- Speed (Node): a 34-million-point LAS (Float32 after a local origin) indexes in about 1.1 s at
  about 8 bytes a point, and `selectSparse` at 2 m takes about 2.1 s.
- Demo: a Sparse points selection on the Edit tab.

## 0.5.0 (2026-10-22)

Point operations.

- Operations on point columns (the object `readPoints` returns, or any `{ count, <name>: TypedArray }`
  whose arrays are `count × k` long), with no dependencies. A selection is a `Uint32Array` of
  strictly ascending point indices, checked on use (`INVALID_ARGUMENT` names the bad position).
- Select: `selectBox`, `selectPolygon` (even-odd; `boundary: "touching"` keeps points on the edge,
  `"inside"` drops them; `tolerance`; `minZ` / `maxZ`), `selectClasses`, `selectReturns` (`returns`,
  `first`, `last`, `single`, any one matches), `thinSelection` (the reader's `maxPoints` rule,
  exported), and `unionSelections`, `intersectSelections`, `subtractSelections`.
- Apply: `keepPoints`, `removePoints`, `splitPoints`, `mergePoints`. Copies by default; `inPlace: true`
  on keep and remove compacts each column inside its own buffer and returns views of it (columns that
  share memory are refused). `mergePoints` takes the union of the columns, lists zero-filled ones
  in `filled`, widens types (Float64 over Float32 over integers; Int32 or Uint32 with Float32 gives
  Float64), and refuses a `k` mismatch, a column named `count` or `filled`, and signed with unsigned
  integers unless the signed type is strictly wider.
- Transform: `makeTransform({ shift, rotateZ, rotate, scale, about })` builds a row-major `{ m, t }`;
  `transformPoints(cols, T, { inPlace })` applies it in Float64 and returns a new `{ count, columns }`
  object (a copy has new x, y, z and shares the rest; `inPlace` returns the input's arrays, overwritten).
- `interleavePositions(cols, { layout, into, at, origin, float32 })` packs x y (z) into a caller's
  Float32 / Float64 buffer, shifting by `origin` in Float64 first.
- Reads: `index` field (each point's record number; Uint32, Float64 above 4,294,967,295 points);
  `polygon` / `boundary` / `tolerance` crop while reading, so only the region is decoded and held;
  `transform` applies in the fixed order record → world → T → minus `localOrigin` → Float32.
  Filters apply in file coordinates; the result's bounds and `dedupe` are in output coordinates,
  and the worker's elevation colour range follows the transform.
- Changed: an omitted (or `null`) `bounds` limit is now open. Before, a missing limit kept nothing.
  `polygon: null` means no polygon. `selectBox` and the `minZ` / `maxZ` of `selectPolygon` read a
  `null` bound as open too.
- `dedupe` moves every column (k values per point, such as an interleaved `positions` or `rgb`) with
  the kept points; other properties pass through. `transformPoints` with `inPlace` refuses x, y or z
  that share memory. `mergePoints` ignores a zero-point input when widening types.
- Demo: an Edit tab (polygon, box and class selections; keep, delete, split, transform, crop on
  read) and LAZ export.
- Docs: README "Point operations".

## 0.4.0 (2026-10-22)

Writes LAZ.

- `writeLas(points, { compress: true })` and `createLasWriter(sink, { compress: true })` write LAZ:
  point formats 0–3 (point-wise) and 6–8 (layered), with a LASzip VLR, 50,000-point chunks and a
  chunk table, as PDAL (LAZperf) lays it out. Plain JavaScript, translated from laz-rs
  (Apache-2.0), like the decoders. Formats 4, 5, 9, 10 cannot be compressed (`UNSUPPORTED`).
- `chunkSize`: points per chunk, a whole number 1 to 4294967294 (default 50,000); ignored without
  `compress`.
- `threads`: chunks compress on the worker pool the LAZ reader uses, written in chunk order, so the
  bytes are the same for any thread count. Automatic by default: from 4 chunks up, with at most 4
  workers, as gains flatten after about 4 (explicit `threads` are honoured); `1` is the calling
  thread. A 10 M-point LAZ (format 3) rewritten: `writeLas` 7166 ms on one thread, 1708 ms
  automatic (4 workers, 4.2×), 1624 ms with 16; `createLasWriter` 7109 ms, 2033–2246 ms, 1657 ms.
- With workers, up to about 2 tasks of 4 chunks per worker of records are in flight: about 55 MB
  at the automatic 4 workers with 50,000-point format 3 chunks. That holds across awaited
  `writePoints` calls; unawaited calls, or one huge batch, submit at once. An abandoned writer
  keeps its workers until `close()`.
- A streaming LAZ writer stops at its first error (a chunk, a sink write, `close()`):
  `writePoints` and `close` keep rejecting. Start a new writer. After `close()`, both reject
  (`ABORTED`).
- The compressed bytes are PDAL's (LAZperf's) with one lossless exception: in formats 6–8 a GPS
  time of −0 following +0 is coded as a change (LAZperf finds the doubles equal).
- Extra bytes are not written yet (as for LAS); they arrive with 0.7.0.
- Checked against PDAL 2.10: the committed fixtures' chunks, chunk tables and LASzip VLRs are
  PDAL's bytes; PDAL reads what we write (`pdal info`, `pdal translate`) and finds the same points
  field by field. Real files compress and read back to the same points: a 1.1 GB, 34-million-point
  LAS streams to a 155 MB LAZ (0.14 of its size) in 6.4 s; a 10-million-point LAZ recompresses to
  the same size in 2.7 s. That file, written by PDAL 1.6 in 2019, comes back as LAS 1.2 format 3 with
  the original's point data byte for byte, and opens in CloudCompare as LAS 1.2 format 3 and as
  LAS 1.4 format 7.
- Docs: README "Writing LAZ"; the demo says LAZ is read and written.

## 0.3.1 (2026-10-21)

Worker fixes.

- Node: a script that stopped part way through a parallel LAZ read (one `chunks()` window, then
  done) never exited, because an idle pool kept Node running. Workers now hold Node only while
  they have work.
- Node: `node --input-type=module -e` scripts can decode in parallel. Workers used to inherit
  `--input-type` and fail to start.
- A worker that cannot start (blocked or failing script) now means one-thread decoding, as
  documented, rather than a failed read. The pool waits for every worker to report ready.

## 0.3.0 (2026-10-21)

Faster LAZ.

- LAZ chunks decode in parallel on a pool of workers (browser Workers, Node worker_threads; one
  fewer than the cores, at most 16), with the next window decoding while the current one becomes
  columns. A 10-million-point LAZ reads in about 0.6 s (3.9 s on one thread); a 1.2 GB,
  160-million-point LAZ in about 12 s (102 s in 0.2.0). Output is identical.
- `openLas(src, { threads })`: automatic by default (used from 4 chunks up); `threads: 1` decodes
  on the calling thread. Falls back to one thread when workers cannot start.
- The decoder's hot loop does less: about 30% faster on one thread, same results.
- Demo: decodes in the background with a progress bar, then shows the cloud once; colour, ramp
  and range recolour the points already read instead of reading the file again.

## 0.2.0 (2026-10-21)

Reads LAZ.

- LAZ (LASzip) point formats 0–3 and 6–8 (item versions 2 and 3; version 4 unchecked), with extra bytes, are read by `openLas` /
  `readPoints` / `chunks` / `readPointsToScratch` and the worker exactly as LAS is: each chunk
  is decompressed into plain LAS records, then decoded by the same code, so every option works
  the same. Plain JavaScript, translated from laz-rs (Apache-2.0); the package licence is now
  `MIT AND Apache-2.0` (see `NOTICE`).
- Checked against an independent encoder: fixtures compressed by PDAL decode to exactly PDAL's own
  decompression, and real files to exactly their LAS twins (1 M points), or to PDAL's decompression
  (10 M points).
- `reader.laz` describes the compression. Wave-packet LAZ items, LASzip item version 1 and files
  without a chunk table are `UNSUPPORTED`; a LAZ cut short is `TRUNCATED`. `COMPRESSED_LAZ` is
  no longer thrown.
- Breaking: `strideFor` (deprecated in 0.1.1) is removed.
- Demo: reads LAZ, and shows its compression.

## 0.1.1 (2026-10-21)

Fixes from the 0.1.0 review. No breaking changes.

- `maxPoints` keeps exactly that many of the points that pass the filters, spread over the whole
  file. It used to keep only the start of a file, and with filters set could return nothing.
- Streamed chunks are coloured by one rule for the whole file, so windows no longer show seams
  (new `createChunkColourizer`; `colourize` gains `eightBit`).
- Opening a LAS 1.4 file no longer reads its EVLRs to the end of the file: a big EVLR has
  `bytes: null` until `readEvlrBytes(i)`. VLRs and EVLRs report `length`.
- Browser bundlers (esbuild, webpack, Vite) can bundle the package; the lazy Node import no
  longer stops them.
- `readPoints` and `writeLas` peak near the size of what they return (a 69 MB read peaked at
  233 MB, now 74 MB); Node files are read into one reused window buffer.
- `dedupe` is about 7 times faster.
- `createLasWriter` works with OPFS scratch writers and Node file handles, and with
  `writePoints` calls made without waiting.
- A custom `{ size, read }` source that returns a short read is `TRUNCATED`, never fewer points.
- Point formats 6–10 write their coordinate system as WKT, as LAS 1.4 requires; an EPSG code
  alone is refused for them.
- `strideFor` is deprecated (the reader no longer uses it) and goes in 0.2.0; `countKept` is new.
- Demo: bounds, dedupe, colour range, return and intensity histograms; safe on big files.

## 0.1.0 (2026-10-21)

First release: read and write ASPRS LAS.

- `openLas` reads the header, VLRs, EVLRs and coordinate system (GeoKeys / WKT) of LAS 1.0–1.4,
  from a File / Blob, ArrayBuffer, Uint8Array, Node path or any `{ size, read }` source.
- `readPoints` and `chunks` decode every point format (0–10) in windows of whole records, never
  holding the file whole; filters (classes, returns, bounds), even thinning (`maxPoints`),
  `dedupe`, `localOrigin` + `float32`, progress and abort.
- `readPointsToScratch` streams columns into OPFS scratch files.
- `colourize` by RGB (with 8-bit files detected), intensity, elevation or classification.
- `writeLas` and the streaming `createLasWriter` write LAS 1.0–1.4, formats 0–10, with EPSG or
  WKT coordinate systems.
- `las-laz-js/worker`: a module Worker with a documented message protocol.
- A Three.js demo.
- LAZ files open and report `compressed`; reading their points arrives in 0.2.0.
