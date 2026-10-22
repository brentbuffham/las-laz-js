# las-laz-js 0.6.0 — Voxel index and sparse-point filter — Design Spec

- **Status:** design agreed in chat 2026-10-22; this spec awaits Brent's review
- **Author:** Brent Buffham (https://kirra-design.com), with Claude
- **Library spec:** `2026-10-21-las-laz-js-design.md` · **Kirra side:** Kirra `aiPlans/20261021-0929-KadCloudDesign.md` §5 (snap / measure to cloud points, #126)

## 1. Intent

Pit scans carry dust: lone points in the air above the benches (Brent, 2026-10-22). 0.6.0 adds a
zero-dependency **voxel neighbour index** on flat typed arrays and, first on it, a **sparse-point
filter**: a point with too few other points within a radius is flagged, and the caller removes
the flagged points with 0.5.0's `removePoints`. The same index gives Kirra the spatial queries
its cloud snap needs, and `dedupe` gains an index map.

Decisions (Brent, 2026-10-22):
- The filter is **one function, `selectSparse`** ("if there's a point that doesn't have another
  point within 2 metres … discard the point"). Statistical-outlier and connectivity filters are
  not in 0.6.0; one is added later only if a real scan shows dust clumps this cannot remove.
- **In memory only.** The filter works on columns already read. Cleaning a whole file larger
  than memory, tile by tile with a neighbour margin, is a 0.6.x release, once the defaults are
  proven on Brent's dusty pit scan (159.7 M points, every point class 0, so the filter must be
  geometric).
- Index structure: **a sorted voxel grid** (approach A of three; a linked hash grid and a k-d
  tree were rejected — scattered memory, and slower fixed-radius queries).
- **Snapping is Kirra's.** The library answers spatial queries (nearest, within a radius, near a
  ray); the snap rules — front-most along the ray in 3D, nearest in XY in plan view (Brent's
  choice), priority below holes and KAD vertices — live in Kirra.
- Roadmap: GCP registration and ICP move to **0.7.0**, facets to **0.8.0**.

## 2. API

Coordinates everywhere are the columns' own frame. A query's result is exact: the grid only
prunes, and every candidate is distance-checked in Float64 against the stored coordinates.
"Within" is inclusive (≤). Ties go to the lowest point number, so every result is deterministic.

### Index (`src/index/grid.js`, `src/index/query.js`)
- `buildIndex(cols, { cellSize })` → `PointIndex`.
  - Coordinates come from `x`, `y`, `z`; when those are absent, from a k = 3 `positions` column
    (Kirra's kadCloud layout, local origin already subtracted). Float32 or Float64.
  - `cellSize` optional: when omitted, chosen from the point density so a cell holds about 16
    points on average — `cellSize = (16 · extent / count)^(1/D)`, where `extent` is the
    bounding box's volume over its D axes of non-zero size (area when flat in Z, length on a
    line); every point identical, or `count` 0 → `cellSize` 1.
  - A plain object `{ count, cellSize, min, nx, ny, nz, order, keys, start, length, coords }` of
    numbers and typed arrays (coords are referenced, not copied), so a worker can build it and
    transfer it.
  - The index is a snapshot of the coordinate arrays it references: after `keepPoints` /
    `removePoints` / `mergePoints` / `transformPoints` the caller rebuilds it (after an
    `inPlace` edit the old index would read overwritten memory). Queries take only the index,
    so staleness cannot be detected; the README states the rule. Every query refuses an index
    that is not self-consistent (`order` length ≠ `count`, a coordinate array shorter than
    `count`).
- `nearestPoint(index, [x, y, z], { maxDistance, xy })` → point number, or −1 when no point is
  within `maxDistance` (default: unlimited). `xy: true` ignores Z (`z` of the query may then be
  omitted or anything).
- `pointsInRadius(index, [x, y, z], radius, { xy })` → selection (ascending `Uint32Array`) of
  every point within `radius`, ready for `keepPoints` and the 0.5.0 operations.
- `pointsNearRay(index, origin, direction, { radius, growth, maxT })` →
  `{ points, t, d }`: `points` a selection of every point whose distance `d` from the ray's axis
  is ≤ `radius + growth · t`, where `t ≥ 0` is its distance along the ray (≤ `maxT`, default
  unlimited); `t` and `d` are `Float64Array`s parallel to `points`. `direction` is normalised
  internally. `growth` 0 (default) is a cylinder — Kirra's orthographic view; > 0 a cone — a
  perspective camera (`growth` = tan of the half-angle). Points behind the origin are not
  returned. Kirra picks its snap point from these.

### Sparse-point filter (`src/ops/sparse.js`)
- `selectSparse(cols, { radius, minNeighbours = 1, xy = false })` → selection of the points that
  have fewer than `minNeighbours` **other** points within `radius`. `radius` is required (no
  default: units differ between files). `xy: true` counts in 2D.
- Use: `removePoints(cols, selectSparse(cols, { radius: 2 }))`, or show the selection first
  (the demo colours it red).
- `minNeighbours: 1` keeps any point with one neighbour inside the radius, so thin sparse
  features — a line of points down a scanned blasthole — survive. Dust that clumps (several
  points within the radius of each other) survives too; a higher `minNeighbours` removes small
  clumps at the cost of thin features. The README says so.

### Dedupe with an index map (`src/filter/dedupe.js`)
- `dedupeSelection(cols, tolerance, { z })` → `{ keep, map }`.
  - `keep` — the selection `dedupe` keeps (its rule unchanged: first point wins, XY unless
    `z: true`).
  - `map` — `Uint32Array`, one entry per **input** point: the output number (position in
    `keep`) of the kept point it merged into — for a dropped point, the nearest kept point within
    `tolerance` (ties to the lowest number); a kept point maps to itself. Kirra remaps anything
    holding old point numbers (triangles, picks) with it.
- `dedupe(cols, tolerance, opts)` keeps its signature and result, built on `dedupeSelection` +
  `keepPoints`.

## 3. Internals

### Building the grid
Three linear passes, arithmetic in Float64:
1. **Bounds** → `min`, `nx`, `ny`, `nz`; cell `(ix, iy, iz) = floor((p − min) / cellSize)`,
   clamped to the last cell. Cell key `(ix · ny + iy) · nz + iz`, an exact integer; when
   `nx · ny · nz > 2^53` → `INVALID_ARGUMENT` ("cellSize too small for this extent").
2. **Count** — each point's key goes into an open-addressing hash table (linear probing,
   power-of-two capacity, doubled when half full; keys `Float64Array`, `length` `Uint32Array`).
3. **Place** — prefix sums over the table give each cell's `start`; keys are recomputed (no
   per-point key array is kept) and each point number written to `order` at its cell's next
   slot. The counting sort is stable: within a cell, points stay in ascending order.

Memory kept: `order` 4 bytes per point, the table 16 bytes per slot (key 8, start 4, length 4)
with about 2 slots per occupied cell — about **6 bytes per point** at 16 points per cell: 120 MB
at 20 M points, about 1 GB at 160 M (Node). More than 4,294,967,295 points → `TOO_MANY_POINTS`.

### Queries
- **`pointsInRadius`** — the cells of the sphere's bounding box (with `xy`, the whole Z column
  of each cell in the circle's box); a cell whose nearest point to the query is beyond `radius`
  is skipped; hits are sorted ascending.
- **`nearestPoint`** — rings of cells outward from the query's cell; stops when the best
  distance found is ≤ the next ring's inner distance, or the rings pass `maxDistance` or the
  grid's edge. With `xy`, rings are in XY over whole Z columns.
- **`pointsNearRay`** — clip the ray to the grid's box; step along it one cell at a time; at each
  step visit the block of cells covering the cylinder / cone at that `t` (radius
  `radius + growth · t`); a per-query `Set` stops a cell being visited twice; distance-check
  every point; sort by point number.

### `selectSparse`
An internal grid with `cellSize = radius` (2D, `nz = 1`, with `xy`), discarded afterwards. Each
point checks the 27 cells around its own (9 with `xy`) and counts other points within `radius`,
stopping at `minNeighbours`; a point on a dense surface usually reaches the count in its own cell
after a few checks, so the cost is close to linear.

### `dedupeSelection`
`dedupe`'s incremental grid stays (first-point-wins needs points inserted one by one, which the
sorted grid cannot do, and changing the rule would change which points `dedupe` keeps). The map
needs a second look only around dropped points: the nearest kept point within `tolerance`.

## 4. Files

| File | Holds |
|---|---|
| `src/index/grid.js` | `buildIndex`, the hash table, coordinate access (x/y/z or `positions`) |
| `src/index/query.js` | `nearestPoint`, `pointsInRadius`, `pointsNearRay` |
| `src/ops/sparse.js` | `selectSparse` |
| `src/filter/dedupe.js` | `dedupeSelection`; `dedupe` on top of it |
| `src/index.js` | exports |
| `examples/browser/` | Edit tab: Sparse section |
| `_dev/benchSparse.mjs` | Node bench on a private file: build / filter time and memory |

## 5. Errors

`LasError` `INVALID_ARGUMENT` with a message naming the argument: no coordinates (neither
x / y / z nor a k = 3 `positions`); `cellSize`, `radius`, `tolerance`, `maxDistance`, `maxT` not
a positive finite number; `growth` negative or non-finite; `minNeighbours` not a whole number
≥ 1; cell count above 2^53; a zero or non-finite `direction`; a query point or `origin` not 3
finite numbers (2 with `xy`); an index that is not self-consistent. `TOO_MANY_POINTS` above
4,294,967,295 points.

## 6. Testing (oracles, not snapshots)

- **Brute force** — on random clouds (uniform, clustered, a flat plane; Float32 and Float64;
  x / y / z and `positions`) and many cell sizes (much smaller and much larger than the query
  radius), every query equals a plain scan: `pointsInRadius`, `nearestPoint` (3D and `xy`, with
  and without `maxDistance`), `pointsNearRay` (cylinder and cone, `maxT`), with the same points,
  order, `t` / `d` and tie-breaks; `selectSparse` equals a brute-force neighbour count, 3D and
  `xy`.
- **Hand-worked** — points exactly at the radius counted; one lone point among a dense patch is
  the only one flagged; a vertical line of points 1.5 m apart (a blasthole) survives
  `radius: 2, minNeighbours: 1` and is flagged at `minNeighbours: 3`; a crest point directly above
  a toe point for `nearestPoint` `xy`; points behind the ray origin excluded; the cone widening
  with `t`; a query outside the grid.
- **dedupeSelection** — `keepPoints(cols, keep)` equals `dedupe(cols)` value for value (3D and
  XY); every `map` entry checked by brute force; kept points map to themselves; `dedupe`'s
  existing tests unchanged.
- **PDAL oracle** (dev machine only, as the LAZ oracle) — `filters.outlier` `method=radius` on
  fixture clouds flags the same points as `selectSparse`; the test pins PDAL's `min_k`
  convention (whether it counts the point itself) and maps it, and keeps points off the exact
  radius, where PDAL's `<` / `≤` may differ.
- **Private sample** (through the existing private-sample mechanism; no file name committed) — a
  crop of Brent's dusty pit scan against PDAL; `_dev/benchSparse.mjs` times `buildIndex` and
  `selectSparse` on the full file and reports peak memory.
- Coverage: no metric below the 0.5.0 values.

## 7. Demo

Edit tab, a **Sparse** section: radius (default 2) and minimum neighbours (default 1) inputs and
a "Select sparse" button; the flagged points turn red with their count, and the existing Keep /
Delete / Split act on them. No snapping in the demo (Kirra's).

## 8. Out of scope

Snap rules and priorities (Kirra's); k-nearest lists; statistical-outlier and connectivity
filters; the streamed whole-file sparse filter (0.6.x); GCP registration and ICP (0.7.0); facets
(0.8.0).
