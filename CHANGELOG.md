# Changelog

## Unreleased

Whole-cloud edits on a tile store (no point limit: never the cloud in memory):
- `alignStores(moving, fixed, opts)`: alignCloud on the stores' thinned top octree levels (moving 1 M,
  fixed 4 M points by default), local to each store's centre; `apply` composes the transform onto the
  moving store. Either side may be columns. `storeSample(store, maxPoints)`.
- `dedupeStore(store, tolerance, opts)`: dedupe's rule over the whole store on the work tiles; one
  delete (`apply: false` to only find them). The same count as dedupe in memory.
- `smoothStore(store, opts)`: denoisePoints over the whole store, each tile with an overlap, one sigma;
  the moved points wait in scratch until every tile is read (an edit replaces node files, so none runs
  while workers read), then setPositions writes them in batches (`batchPoints`, 10 M). Within 0.5 mm
  of denoisePoints in memory, seams included; a stop before the writes leaves the store untouched.
- `mergeStores(stores, { where })` and `splitStore(store, sel, { where, keep })`: new stores streamed
  node by node in world coordinates (transforms applied) through a scratch LAS and buildTiles; the
  format holds every source's fields, the finest scale; split deletes the selection from the source.
- `store.setPositions({ key: { index, x, y, z } })`: move points in world coordinates (through the
  store transform's inverse); node boxes measured again.
- Already there, for crop, delete and move: `selectPolygon` / `keepPoints`, `deletePoints`, `transform`.

## 0.15.1 (2026-10-27)

Faster (found from Kirra's 160 M / 177 M imports):
- **OPFS tile stores** look each folder up once, not on every file: a walk from the OPFS root was
  about 7 ms of the 12 ms a tile write took. Every read and write of an OPFS store gains.
- **buildTiles** writes a chunk's node files 8 at a time and keeps the pool fed while earlier
  chunks' files are being written (it waited on each chunk's writes before handing out the next).
  The 59.7 M-point pile into OPFS in Chrome: 50 s, the tiles phase about 2.4 x faster (35 s, from
  about 83 s on a quiet machine); in Node (a folder) 26.4 s to 22.8 s.

## 0.15.0 (2026-10-27)

New:
- **Runs on a tile store, never reading the cloud whole.** `findFragmentsParallel(store, opts)` and
  `findFacetsParallel(store, opts)` take an open `TileStore`: work tiles are cut from the store's box,
  each worker opens the store and reads its tile and the overlap at full density (one node at a time,
  no pool inside a worker), and this thread keeps one label a point per node (about 6.5 bytes a
  point). Labels come back as `byTile` ({ key: Uint32Array }), and `column` writes them to the store
  in one edit at the end (an added u32 column; set again on a re-run; a name a field already holds is
  refused). The spacing is the median of 9 full-density samples; positions are about the store box's
  centre (`localOrigin` to choose), so a UTM-scale store has no Float32 jitter. Facets pieces of one
  face in neighbouring tiles are joined where they meet in a seam cell along the shared core edge;
  a joined facet carries `outlineParts`. `threads` defaults to 8 here (each worker about 0.3 GB),
  `tilePoints` 500,000. A store in memory runs its tiles on this thread. On the 59.7 M-point pile
  (4,244 nodes): hybrid in 119 s on 8 threads (86 s on 16), 386 MB on this thread; 59,681 fragments
  (60,827 in memory), unresolved 23.5 % (24 %).
- `resolutionOf(spacing)` and `FLOOR_SPACINGS` (30) are exported, so an app can say what a scan
  resolves (and its floor, 30 x `pointSpacing`) before a run.

## 0.14.2 (2026-10-27)

Fixed (found from Kirra's Facets dialog):
- `findFacetsParallel` and `findFragmentsParallel` given precomputed `normals` no longer drop to one
  thread: each tile gets its cut of them. On the ultra corner a facets re-run with them takes 13 s
  (a fresh run 17.7 s; before, one thread, about 100 s).
- `findFragments` method `"hybrid"` given `normals` threw ("normals must be … for this cloud"): the
  facet pass on the rest now takes the rest's cut.

New:
- `keepNormals: true` (`findFacetsParallel`): the result's `normals`, joined from the tiles', to pass
  back for a quicker re-run.
- `signal` (an AbortSignal) on both parallel runs: the workers end and the run rejects with ABORTED.
- Progress within the tiles: `onProgress(done, total)` in points (the tiles weighed by their points),
  from inside each worker, not only as tiles finish.
- `sliceNormals(normals, indices)` (internal, src/ops/normals.js).

## 0.14.1 (2026-10-27)

Behaviour changes (`sizeDistribution`):
- `lower` defaults to **0 (none)**, not the cloud's floor. The floor stays on the result as where
  sizes stop being measured rock by rock; it never cuts the curve. Set the site's fines size
  (`lower: 0.115`, say).
- The surface in no fragment (gaps, the toe, flat ground) is **not fines** by default: new
  `unresolved` (% of `surfaceArea`), and `finesShare` is now a share of the rock surface (sheets and
  fragments under `lower`). `grey: "fines"` keeps 0.12.0's count. On the whole 59.7 M-point pile at
  115 mm the old count read 30 % fines, 24 points of it the grey.
- Demo: Lower limit 0 = none (the floor shown beside it); the legend and the line under the curve
  give fines and unresolved apart, fines drawn tan and unresolved grey.

## 0.14.0 (2026-10-27)

Every core, on tiles. (No 0.13.0.)

New:
- `findFacetsParallel(cols, opts)`: `findFacets` on every core, on the same work tiles (overlap
  default max(0.5, 5 x maxDistance) m) with one planeDistance for all. A face wider than a tile is
  found in pieces; pieces sharing points in an overlap, within maxAngle, are joined into one facet
  and measured again. Ultra corner (10.9 M points, maxDistance 0.08): 104 s to 14 s, 20 facets and
  37 m² against 20 and 36 m². The demo's Facets tab runs it.
- `findFacets` returns `outlineCell`, the median of its facets' outline cells.
- `findFragmentsParallel(cols, opts)`: `findFragments` on every core. The cloud is cut into tiles on
  its two widest axes, each grown by an overlap wider than a rock (default max(2.5, reliefRadius +
  1.5) m), run in workers (browser or Node) with the whole cloud's spacing, and stitched: a fragment
  is kept from the tile whose core holds its centroid, and a copy across a seam is dropped. Options
  `threads`, `tile`, `overlap`. On the 10.9 M-point ultra corner the hybrid went from 64 s to 17 s
  (20 tiles, 16 threads), matching the same drawn rocks (38 / 60, 38 / 58).
- `findFragments` takes `spacing` when it is known (else it is measured).
- Demo: Fragments runs `findFragmentsParallel`, and on a read thinned by Max points it reads every
  point (inside the polygon) for the run and puts the labels back on the points shown.

Changed:
- `sizeDistribution` no longer warns `LOWER_UNDER_FLOOR` on a `fine` cloud: on a 1.5 cm scan a
  lower limit under the floor is the user's call.

Faster:
- Column-only tile edits (`addColumn`, `removeColumn`, `setColumn` of an added column) keep each
  tile's records as stored: on a compressed store they are copied packed, never decompressed and
  compressed again, and the tile's box is kept. On a 10.9 M-point, 848-tile LAZ store each step went
  from about 10 s to 0.3 s. A records edit (a standard field, a delete or keep) is unchanged.

## 0.12.0 (2026-10-27)

What a cloud can resolve, the watershed and the hybrid, limits and fines.

Behaviour changes:
- `sizeDistribution` weighs by **area** by default (was volume): on real piles volume let a few
  large fragments carry the curve.
- `findFragments`' `maxDistance` is optional: 4 point spacings by default.
- `sizeDistribution` given `findFragments`' whole result (not just its `fragments`) starts the
  curve at the fines: the surface in no fragment, sheets and fragments under the lower limit (by
  default the cloud's floor). An array without the new options and without sheets gives 0.11.0's
  curve.

New:
- `pointSpacing(cols)`: the spacing of a surface from each point's 32 nearest, orientation-free.
- Every `findFragments` result says what the cloud can resolve: `spacing`, `floor` (30 spacings,
  the smallest rock measured), `resolution` ("fine" ≤ 0.017 m, "coarse" ≤ 0.035, "oversize"
  ≤ 0.05, else "unresolved"), `warnings` (`COARSE`, `OVERSIZE_ONLY`, `UNRESOLVED`,
  `MAX_DISTANCE`, `SHEETS`, `FLOOR`, `SIDE_ON`, `IGNORED_OPTIONS`), `method`, and `sheet` on
  each fragment (c / b under 0.15: surface, not rock). A coarse cloud is warned of, never refused.
- `findFragments({ method: "watershed" })`: a muckpile seen from above, by a marker-controlled
  watershed on a height grid (relief above the local mean surface, seeds at the relief peaks,
  gaps clipped). `cell`, `reliefRadius` (about the largest rock), `seedHeight`, `clipBelow`.
- `findFragments({ method: "hybrid" })`: the watershed, then facet merging on what it left; the
  rock-shaped fragments found there are rocks too (`from` on each), the rest fines.
- `sizeDistribution`: `lower` and `upper` limits (everything over `upper` one share, the crusher
  gap say), `finesShare`, `over`, `p[P].below` / `.above`, `finesSize` to place the unseen fines,
  `warnings` (`LOWER_UNDER_FLOOR`).
- Demo: the method choice, the warnings line (a thinned read named too), a "What a cloud can
  resolve" table, lower / upper limit and fines size fields, colour by size range (bins between
  the limits, an "over" bin, fines grey), not a rock is fines, only the selection counted, vivid
  colours, a draggable side panel.
- `_dev/scoreFragments.mjs`: score a method against rock outlines drawn by hand (Kirra
  drawings.json or DXF).

## 0.11.0 (2026-10-26)

Fragments and size distribution.

- `findFragments(cols, { maxDistance })` splits a muckpile scan into fragments (rocks): facets on
  rock-face settings merged across convex edges, strongest first, while the fragment stays
  convex; steps and valleys keep rocks apart; edge-on faces join the rock they stay convex with;
  a one-hop fill; per fragment its PCA axes (2nd–98th percentile spans), `size` (b), area and
  outline; `surfaceArea` and `unassignedArea`. The pile's outward direction comes from a coarse
  grid, or from a `viewpoint`.
- `sizeDistribution(fragments)`: % passing by volume, area or count, an optional fines share,
  Swebrec or Rosin–Rammler fitted to the coarse part, P-values marked when extrapolated.
- Demo: a Fragments tab (floor warning, colours, outlines, hover, select fragment / oversize, the
  size curve, CSV, DXF) and the `fragment` extra-bytes field on save. Facets DXF polylines now
  carry their dummy point and 3D / closed flags (they sat inside a comment).

## 0.10.0 (2026-10-24)

Tiles and level of detail (Kirra #129).

- `buildTiles(las, { where })` splits a LAS / LAZ file into an additive octree of tiles (Potree
  style: each tile an even 128³-grid sample of its box, every point stored once) in memory, OPFS
  (`las-tiles/<id>`) or a Node folder. Two streamed passes, chunk octrees on the worker pool,
  memory bounded by `chunkPoints` (a grid cell over it, from a far outlier or a dense spot, is
  counted again finer); the same store byte for byte whatever `threads` is.
  A tile is the file's own records, optionally one LAZ chunk.
- `openTiles` reopens a store without rebuilding (A/B manifest, crash safe); `store.matches(file)`;
  `listTiles`, `removeTiles`.
- `selectTiles(storeOrManifest, view)`: the tiles a camera needs within a point budget, culled by
  the frustum, largest on screen first, for orthographic and perspective cameras.
- `store.readTile` / `readTiles` give point columns as `readPoints` does (local origin, Float32,
  the store transform, added columns).
- Edits in place: `select`, `selectBox`, `selectPolygon`, `selectClasses`,
  `combineTileSelections`, `deletePoints`, `keepPoints`, `setColumn`, `addColumn`,
  `removeColumn`, `transform`; `store.writeLas(sink)` writes the edited store to LAS / LAZ.
- The Worker gains the tile messages; `ERROR_CODES.BAD_STORE`.

## 0.9.3 (2026-10-24)

- `findFacets` `onProgress` climbs once to the total: growth revisits points on a rough wall, and
  each visit past the point count reported the total again (millions of calls on a 4 M-point scan;
  reported by Kirra). Progress now counts the points seen, each value is reported once, and the
  total only when the facets are done.

## 0.9.2 (2026-10-24)

Extra bytes: the LAS 1.4 Extra Bytes VLR, read and written, LAS and LAZ.

- `las.extraBytes` lists a file's extra fields (name, column, type, k, size, scale, offset, noData,
  min, max, description); `readPoints`, `chunks`, `readPointsToScratch` and the Worker read them
  by column, or all with `"extra"`. Types 1–10 come back in their stored type (64-bit as BigInt
  arrays), scaled fields as Float64 with no-data NaN, the deprecated array types with k values a
  point, undocumented bytes as one raw `extraBytes` column. A bad VLR never stops a read: the
  bytes come back raw and `las.extraBytesProblem` says why. Default fields are unchanged.
- `writeLas` / `createLasWriter` take `extraBytes`: fields of types 1–10 or raw, with scale,
  offset, no-data and description; the writer stores each field's raw min and max. A reader's
  `extraBytes` can be passed back, so a read → save keeps the records byte for byte. Values are
  checked before any byte of a batch is written. Without `extraBytes`, nothing changes.
- `parseExtraBytes(vlrs, header)` is exported.
- LAZ: the PDAL fixtures with extra bytes (f3x, f7x) now go through the writer, byte for byte.
- Demo: the File tab lists the extra bytes; reads keep them through edits, hover shows them, and
  both saves write them; **Save with facet / set** writes `facet` (u32) and `joint_set` (u16).

## 0.9.1 (2026-10-24)

Normals by range, for workers (trimesh-build-js 0.3.0).

- `pointNormals(cols, { k, maxDistance, start, end })` fits only points `start` … `end − 1`, their
  neighbours still searched in the whole cloud, so a range is that slice of a full run, bit for
  bit. `normal` / `residual` hold the range's points, the first at 0; `onProgress` counts them. A
  `start` or `end` that is not a whole number from 0 to the point count, or a `start` after
  `end`, is refused (`INVALID_ARGUMENT`). Without them, nothing changes.
- Demo: Facets DXF layers take the demo's set colours (the nearest distinct ACI), polylines BYLAYER.
- Extra bytes move to 0.9.2.

## 0.9.0 (2026-10-23)

Facets and joint sets (Kirra #127).

- `findFacets(cols, { maxDistance, maxAngle, planeDistance, minArea, minPoints, outlineCell, normals })`
  splits a cloud into flat facets by region growing on the 0.7.0 normals: per point its facet
  (0 none); per facet its pole, centroid, dip / dip direction (Kirra's convention), area (an
  in-plane grid), rms and outline (a closed 3D polygon on its plane). Ids by area. Each point is
  visited at most about three times, so rough rock does not regrow.
- `jointSets(facets, { maxAngle, minFacets, count, windows })` groups facets by orientation (axial,
  area-weighted): automatic (mean-shift), a count (spherical k-means) or your windows; per set the
  mean pole, Fisher K, the 95 % cone, facets and area; `pointFamily` gives each point its set.
- `poleOf`, `orientationOf`, `poleFromOrientation`: the orientation convention.
- Demo: a Facets tab (colours by facet or set, outlines, the sets table with Select, an equal-area
  stereonet, hover, facets / sets CSV and a Facets DXF of the outlines as 3D polylines, a layer per
  set); the side panel grows with the window (400-520 px, was 340 px) and the tabs wrap.

## 0.8.0 (2026-10-23)

Register: put a scan onto the mine grid or onto another cloud.

- `fitTransform(from, to, { model, weights })` fits a transform to point pairs, closed form:
  `"rigid"` (default), `"level"` (rotate about Z + shift) or `"scale"` (rigid + one scale). It
  returns `{ transform: { m, t }, residuals, dH, dZ, looResiduals, rms, worst, scale, rotateZ }`;
  `looResiduals` is each pair's residual under the fit made without it, so a bad control point
  that drags the fit still shows.
- `parseControlPoints(text, { columns })` reads name, x, y, z rows (tab, comma, semicolon or spaces;
  a tab file keeps spaces in names; E / N / RL style headers; BOM, CRLF, quotes, an optional blank
  last column; thousands separators refused, with or without a header); `matchControlPoints(scan,
  grid)` pairs them by name and lists the names on one side only.
- `alignCloud(moving, fixed, { pairs, model, movingOrigin, fixedOrigin, icp })`: the fit from
  picked pairs, then optional point-to-plane ICP on an even sample (normals fitted only where the
  sample lands, from each point's k nearest); `converged`, RMS before and after, the overlap, and
  `constrained`: directions the geometry barely pins (a floor's in-plane shift, a straight bench's
  shift along strike) stay at the picks instead of drifting.
- On real scans with a known answer and 2 cm picking noise: 75.8 mm → 4.6 mm (1 M points, 1.8 s)
  and 32.6 mm → 1.6 mm (34 M points, 9.9 s) largest error over the scan.
- Demo: a Register tab — align to a reference cloud by picked pairs (with ICP), or GCP from a control
  file and a target file or named picks; residuals with the left-out residual and the worst pair,
  preview, Apply (re-based to a new local origin), Undo, Copy transform. A far reference (a raw scan
  near 0,0 against one on the grid) is read about its own centre and drawn shifted over the scan.
- Demo: Save writes every point. It saved at most 5,000,000 points before: the Write tab thinned to a
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
