# las-laz-js 0.5.0 — Selections and column operations — Design Spec

- **Status:** design agreed in chat 2026-10-22; this spec awaits Brent's review
- **Author:** Brent Buffham (https://kirra-design.com), with Claude
- **Library spec:** `2026-10-21-las-laz-js-design.md` · **Kirra side:** Kirra `aiPlans/20261021-0929-KadCloudDesign.md` §5, §5a

## 1. Intent

Kirra's kadCloud phase 2 needs crop / delete / split of point clouds, and its own interleave in
`createKadCloud` replaced by the library's (Kirra spec §5a). 0.5.0 adds zero-dependency
operations on **point columns**: build a selection, apply it to every column, merge clouds,
transform coordinates (the pre-transform, Kirra #131), and write interleaved positions into a
caller's buffer. The reader gains an `index` column, a transform on read and a polygon crop on
read.

Decisions (Brent, 2026-10-21/22):
- Copy by default; `{ inPlace: true }` compacts in place for big clouds.
- Transform: one plain row-major object `{ m, t }`, shared with 0.6.0's GCP fit (not Three.js's
  column-major `Matrix4`; Kirra converts with one helper).
- Crop on read is in 0.5.0 (a site region imported without decoding the whole file into memory).
- Out: the voxel index, `dedupe`'s index map, GCP / ICP (0.6.0); facets (0.7.0); undo (Kirra's).

## 2. Columns and selections

**Point columns** — the object `readPoints` returns, or any caller's object of the same shape:
`{ count, <name>: TypedArray, ... }`. A property is a column when it is a typed array whose
length is `count × k` for a whole number `k ≥ 1` (k = 1 for `x`, `classification` …; k = 3 for
Kirra's interleaved `positions` or `rgb`). Operations carry every column, k values per point,
and nothing else: other properties (`bounds`, `header`, names) are not copied — the caller
rebuilds them. With `count` 0 every typed array counts as a k = 1 column of length 0.

**Selection** — a `Uint32Array` of point indices, strictly ascending, each `< count`. Every
operation that takes one checks this in one pass and throws `INVALID_ARGUMENT` (naming the first
bad position) otherwise. Operations that make one always return a valid one.

## 3. API

### Making selections (`src/ops/select.js`)
- `selectBox(cols, { minX, maxX, minY, maxY, minZ, maxZ })` — any bound may be omitted;
  inclusive. In the columns' own frame (needs `x`, `y`; `z` when a Z bound is given).
- `selectPolygon(cols, polygon, { boundary, tolerance, minZ, maxZ })` — `polygon` is
  `[x0, y0, x1, y1, …]` (flat, ≥ 3 vertices, implicitly closed) in the columns' frame; even-odd
  rule for the interior. Points on the boundary (Brent, 2026-10-22: "an option touching or
  inside"):
  - `boundary: "touching"` (default) — inside **or on** the boundary: kept.
  - `boundary: "inside"` — strictly inside only: points on the boundary are dropped.
  - "On the boundary" = within `tolerance` (default 0, i.e. exactly on) of an edge or vertex,
    measured as the 2D distance to the segment in Float64. Interior points are decided by the
    crossing test only after the boundary test, so the answer for an edge point never depends
    on crossing-test rounding.
  - So `"touching"` and `"inside"` differ by exactly the boundary points, and a cloud split by
    one polygon with `splitPoints(cols, selectPolygon(…))` loses and duplicates nothing.
  Bounding-box reject (grown by `tolerance`) first.
- `selectClasses(cols, classes)` / `selectReturns(cols, { first, last, single })` — the same
  meanings as the reader's `classes` / returns filters.
- `thinSelection(count, target)` — the **reader's** even-thinning rule (`maxPoints`), exported:
  index i is kept when the accumulator `acc += target` reaches `total` (then `acc -= total`),
  starting at 0. Exactly `min(count, target)` indices. `readPoints({ maxPoints })` over a file and
  `keepPoints(all, thinSelection(n, t))` give the same points. (Kirra's `evenSelection`,
  `floor(k·count/target)`, picks slightly different points; Kirra switches to this.)
- `unionSelections(a, b)`, `intersectSelections(a, b)`, `subtractSelections(a, b)` — linear
  merges of two ascending selections.

### Applying selections (`src/ops/apply.js`)
- `keepPoints(cols, sel, { inPlace })` → columns of the selected points, in order.
- `removePoints(cols, sel, { inPlace })` → columns without them.
- `inPlace: true` compacts each column inside its own buffer (kept values slide down) and
  returns `subarray` views of the same memory: no second copy, and the input is overwritten.
  Default (`false`) allocates new columns of the same types.
- `splitPoints(cols, sel)` → `[inside, outside]`, always copies.
- `mergePoints([a, b, …])` → one set of columns, concatenated in order. Column set = union by
  name; a column absent from an input is filled with 0 for its points, and its name is listed in
  `result.filled`. A column whose `k` differs between inputs → `INVALID_ARGUMENT`. Type: the
  widest across inputs (Float64 > Float32 > integer types; mixed integer types → the wider one;
  signed + unsigned of the same width → `INVALID_ARGUMENT`). Coordinates must already share one
  frame (the caller's job, as in Kirra).

### Original index (reader)
- `readPoints({ fields: [..., "index"] })` / `chunks({ fields: [..., "index"] })` add an `index`
  column: each kept point's record number in the file (0-based, after every filter and
  `maxPoints`). `Uint32Array`, or `Float64Array` when the file holds more than 4,294,967,295
  points. It is an ordinary column, so every operation above carries it.

### Transform (`src/ops/transform.js`; Kirra #131)
- A transform is `{ m: [m00, m01, m02, m10, m11, m12, m20, m21, m22], t: [tx, ty, tz] }`
  (row-major; `p' = m·p + t`), applied in Float64. Covers shift, rotation, scale (similarity) and
  any affine map. 0.6.0's GCP fit returns this object.
- `makeTransform({ shift, rotateZ, rotate, scale, about })` builds one:
  `p' = scale · R · (p − about) + about + shift`, where `R = rotate` (a row-major 3×3) or the
  rotation by `rotateZ` degrees anticlockwise about +Z (not both), `scale` a number, `about`,
  `shift` `[x, y, z]` (defaults identity / 0).
- `transformPoints(cols, T, { inPlace })` — transforms `x`, `y`, `z` (all three required) in
  Float64 and stores in the columns' own types (copy by default; other columns untouched,
  shared by reference in the copy).
- `readPoints({ transform: T, localOrigin, float32 })` — the order is fixed:
  **record → world (scale, offset) → T (Float64) → minus `localOrigin` → Float32 if asked.**
  Raw scanner coordinates never pass through Float32 at full magnitude. Read **filters**
  (classes, returns, `bounds`, `polygon`) apply in **file** coordinates, before the transform
  (as today's `bounds` does); to crop a raw scan after registering it, read it transformed and
  use `selectPolygon`. `bounds` / stats in the result are of the output coordinates.

### Crop on read (reader)
- `readPoints({ polygon, boundary, tolerance, … })` / `chunks({ … })` — `polygon`, `boundary`
  and `tolerance` as `selectPolygon`, in the file's world coordinates; optional `minZ` / `maxZ` via the existing `bounds` filter. Applied
  per record before decoding (with the existing `makeKeep` filters), so only the region is
  decoded and held. Also with `maxPoints` (the counting pass sees the same filter).

### Interleaved positions (`src/ops/interleave.js`)
- `interleavePositions(cols, { layout, into, at, origin, float32 })` → the array written.
  `layout` `"xyz"` (default) or `"xy"`; `into` a caller's Float32Array / Float64Array (default: a
  new one, Float32 when `float32` is true or omitted, else Float64), written from element
  `at × stride`; `origin { x, y, z }` subtracted in Float64 before storing (an absent axis is not
  shifted — Kirra passes `{ x, y }` and keeps world Z). An `into` too short → `INVALID_ARGUMENT`.

## 4. Files

| File | Holds |
|---|---|
| `src/ops/columns.js` | column discovery (`count × k` rule), selection validation, typed-array widening |
| `src/ops/select.js` | `selectBox`, `selectPolygon`, `selectClasses`, `selectReturns`, `thinSelection`, set operations |
| `src/ops/apply.js` | `keepPoints`, `removePoints`, `splitPoints`, `mergePoints` |
| `src/ops/transform.js` | `makeTransform`, `transformPoints`, `applyTransform` (one point, for the reader) |
| `src/ops/interleave.js` | `interleavePositions` |
| `src/filter/filters.js` | `polygon` in `makeKeep`; the thinning rule moves to `thinSelection`'s module and both use it |
| `src/read/decodeRecords.js`, `src/LasReader.js` | `index` column; `transform` on read |
| `src/index.js` | exports |

## 5. Errors

All `LasError` `INVALID_ARGUMENT` with a message naming the argument: a bad selection
(unsorted, duplicate, out of range — with its position); a polygon with < 3 vertices or an odd
length; `boundary` other than `"touching"` / `"inside"`; a negative or non-finite `tolerance`;
`rotate` and `rotateZ` both given; a transform whose `m` is not 9 finite numbers or `t`
not 3; `transformPoints` without x, y, z; a merge type / `k` conflict; `into` too short.

## 6. Testing (oracles, not snapshots)

- **Hand-worked**: small clouds with every expected index chosen by hand — box edges inclusive,
  a concave polygon (a "U"), points exactly on a vertex and on an edge (kept by `"touching"`,
  dropped by `"inside"`), points just off an edge with and without `tolerance`, `"touching"`
  minus `"inside"` = exactly the boundary points on a grid, a split losing and duplicating
  nothing, Z limits; set operations on
  hand-made selections; keep / remove / split counts and values per column, k = 1 and k = 3
  columns, `count` 0.
- **In place = copy**: for random selections, `inPlace` results equal the copies, value for
  value, and share the input's buffers.
- **Thinning identity**: `readPoints({ maxPoints })` equals `keepPoints(readPoints(), thinSelection(n, t))`
  on fixtures, with and without filters.
- **Index**: `index` after filters / thinning names the right records (checked against
  decoding those records directly); survives keep / remove / merge.
- **Transform**: known rotations (90° about Z, about a point), scale, a hand-computed affine;
  `makeTransform` composition order; on read, a UTM-magnitude cloud with `float32` +
  `localOrigin` keeps sub-millimetre precision (the Float64-first order), against the same done
  by hand in Float64; filters on read are applied in file coordinates.
- **Crop on read** = `selectPolygon` after a full read (same points, same order), and the peak
  memory of a cropped read is below a full read (the memory probe in `test/memory.test.js`).
- **Interleave**: values, `xy` / `xyz`, `at` offsets, `origin` with and without Z, into
  Float32 / Float64, too-short `into`.
- **Kirra shape**: a kadCloud-shaped object (`positions` k = 3 Float32, `rgb` k = 3 Uint8,
  `classification` …) through keep / remove / split / merge.
- Coverage thresholds as the library's; no metric below the 0.4.0 values.

## 7. Out of scope

Voxel / neighbour index, nearest and radius queries, `dedupe` index map, GCP / ICP (0.6.0);
facets (0.7.0); screen-space selection (Kirra's `PolygonSelection3D`); undo; reprojection.
