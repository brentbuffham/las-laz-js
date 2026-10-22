# Voxel index and sparse-point filter 0.6.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a sorted voxel grid with exact nearest / radius / near-ray queries, `selectSparse` (the dust filter) on it, and `dedupeSelection` (dedupe's index map); the demo's Edit tab gains a Sparse section.

**Architecture:** `src/index/grid.js` builds a `PointIndex` — a stable counting sort of point numbers into voxel cells (`order`), with an open-addressing hash table from cell key to `start` / `length` — over coordinates referenced from `x` / `y` / `z` or a k = 3 `positions` column. `src/index/query.js` answers queries by visiting cells and distance-checking every candidate in Float64, so the grid only prunes. `selectSparse` builds a private grid with `cellSize = radius`. `dedupeSelection` keeps dedupe's incremental first-wins grid and adds the map.

**Tech Stack:** plain ES modules, `node:test`, no dependencies; PDAL 2.10 (`LAS_PDAL`) as a dev-machine oracle only.

**Spec:** `docs/design/2026-10-22-voxel-index-sparse-0.6.0-design.md`

## Global Constraints

- No dependencies in las-laz-js: nothing added to `package.json` `dependencies` / `devDependencies`; no WASM.
- Code style as the repo: `var`, `function` declarations, tabs, a `// src/…` banner comment block at the top of each new file, JSDoc on every export, `/* prettier-ignore-file */` in tests.
- Errors are `LasError` with `ERROR_CODES.INVALID_ARGUMENT` and a message naming the argument; above 4,294,967,295 points `ERROR_CODES.TOO_MANY_POINTS` (spec §5).
- Results are exact: every candidate is distance-checked in Float64 against the stored coordinates; "within" is inclusive (≤); ties go to the lowest point number.
- A selection is an ascending `Uint32Array` (0.5.0's rule).
- Every new public function is exported from `src/index.js` in the task that writes it.
- Tests are oracles (brute force, hand-worked values, PDAL), never snapshots.
- `npm test` passes after every task (the dedupe 2 M-point timing test is known to be flaky under load; it passes alone). Node 24: `node --test` takes quoted globs, never a directory.
- Coverage after the last task: no metric below lines 99.67, branches 96.52, functions 97.91 (`npm run test:coverage`).
- Private samples are named by id only; no sample file name or path in any tracked file or commit (`npm run check:private` passes).
- Commits go straight on `main`; never push.

## Review Focus

1. **A query point outside the grid** (Kirra snaps with the cursor off the cloud's edge; a ray starting far from the cloud): `nearestPoint` still finds the true nearest, `pointsNearRay` still finds points, nothing throws or loops forever. → Task 2 and Task 3 tests.
2. **Coincident points** (scanners write exact duplicates): duplicates are each other's neighbours for `selectSparse` (distance 0 ≤ radius), `pointsInRadius` returns all of them, `nearestPoint` returns the lowest number. → Task 2 and Task 4 tests.
3. **A flat or degenerate cloud** (a surface with all z equal; a single point; every point identical; count 0): `buildIndex` picks a usable `cellSize` (spec: "every point identical, or count 0 → cellSize 1"), queries work. → Task 1 test.
4. **Float32 `positions` at local-origin magnitude** (Kirra's layout): queries on `positions` equal queries on the same values as Float64 `x` / `y` / `z`. → Task 2 test.
5. **A query radius much larger than the cell size** (Kirra's auto `cellSize` is small; a 5 m measure query visits many cells): still exact, and `nearestPoint` with a small `maxDistance` on a huge empty grid returns −1 quickly. → Task 2 test.

---

### Task 1: The grid — `buildIndex`

**Files:**
- Create: `src/index/grid.js`
- Modify: `src/index.js`
- Test: `test/index/grid.test.js`

**Interfaces:**
- Produces (public): `buildIndex(cols, { cellSize }?) -> PointIndex`.
- Produces (internal, exported for Tasks 2–4):
  - `coordsOf(cols, fn: string) -> { x, y, z, stride }` — from `x` / `y` / `z` (stride 1), else from a k = 3 `positions` column as `{ x: positions, y: positions.subarray(1), z: positions.subarray(2), stride: 3 }`. Point `i`'s x is `x[i * stride]`. Neither → INVALID_ARGUMENT `"<fn> needs x, y, z columns or a k = 3 positions column"`. Uses 0.5.0's `columnsOf` for the count check.
  - `buildGrid(coords, count, cellSize, xy: boolean) -> PointIndex` — `xy` makes `nz = 1` (z ignored; used by `selectSparse`).
  - `lookup(index, ix, iy, iz) -> slot | -1` — the hash-table slot of a cell, or −1 when empty / out of range.
  - `checkIndex(index, fn) -> void` — INVALID_ARGUMENT `"<fn>: index is not self-consistent"` when `order.length !== count` or `coords.x.length < (count - 1) * stride + 1` (count 0 passes).
  - `checkPointCount(n) -> void` — TOO_MANY_POINTS above 4294967295 (a separate function so the limit is testable).
- `PointIndex` = `{ count, cellSize, min: [x, y, z], nx, ny, nz, order: Uint32Array, keys: Float64Array, start: Uint32Array, length: Uint32Array, mask, coords: { x, y, z, stride } }`. `keys` holds −1 in empty slots; `mask = capacity − 1`.

- [ ] **Step 1: Write the failing tests** in `test/index/grid.test.js`

```js
test("every point is in exactly one cell, in ascending order within its cell", function () {
	// 2000 random points in a 50 × 30 × 10 box, cellSize 2: walk every occupied slot;
	// the union of order[start .. start+length) is 0..n-1 exactly once; each run is ascending;
	// each point's own cell (floor((p - min) / cellSize)) is the slot's key
});
test("auto cellSize aims at 16 points per cell", function () {
	// each cloud includes points at both corners of its box, so the extent is exact:
	// 16000 points uniform in a 100 × 100 × 100 box → cellSize = (16 · 1e6 / 16000)^(1/3) = 10 (±1e-9)
	// flat: 16000 points in 100 × 100 with z = 5 → (16 · 1e4 / 16000)^(1/2) = √10
	// a line in x only (y, z constant), length 1000, 160 points → 100
	// count 0, one point, 50 identical points → cellSize 1
});
test("positions (k = 3, Float32) give the same cells as x / y / z", function () { /* same order, keys, start, length */ });
test("cell count above 2^53 is refused", function () {
	// x spread 1e6, y 1e6, z 1e6, cellSize 1e-3 → INVALID_ARGUMENT /cellSize too small for this extent/
});
test("bad arguments are refused, naming the argument", function () {
	// no coordinates; cellSize 0, -1, NaN, Infinity → /cellSize/; checkPointCount(4294967296) → TOO_MANY_POINTS;
	// checkPointCount(4294967295) passes; checkIndex on { ...index, count: index.count + 1 } → /not self-consistent/
});
test("a 1 M-point index builds in under 3 s and costs under 10 bytes a point", function () {
	// order.byteLength + keys.byteLength + start.byteLength + length.byteLength < 10 · n at auto cellSize
});
```

- [ ] **Step 2: Run** `node --test "test/index/*.test.js"` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `buildIndex` / `buildGrid` in `src/index/grid.js`**

Three passes, as spec §3: bounds (Float64) → `nx = floor(extent / cellSize) + 1` per axis, refuse `nx·ny·nz > 2^53`; count into the hash table; prefix sums to `start`, recompute keys, place into `order` (stable). Cell index `min(n_a − 1, floor((p − min) / cellSize))`. Key `(ix · ny + iy) · nz + iz`. Linear probing, capacity a power of two ≥ 16, doubled (rehash) when occupied slots exceed half the capacity. Hash of a key (an integer < 2^53):

```js
function hashKey(key, mask) {
	var lo = key % 4294967296, hi = (key - lo) / 4294967296;
	return (Math.imul(lo ^ Math.imul(hi, 0x85EBCA6B), 0x9E3779B1) >>> 0) & mask;
}
```

`cellSize` omitted: `(16 · extent / count)^(1/D)` over the D axes with non-zero size; D = 0 or count 0 → 1. `buildIndex` = `coordsOf` + `checkPointCount` + `buildGrid(…, false)`; export it from `src/index.js`.

- [ ] **Step 4: Run** `node --test "test/index/*.test.js"` — Expected: PASS; then `npm test` — PASS.

- [ ] **Step 5: Commit** — `git add src/index/grid.js src/index.js test/index/grid.test.js && git commit -m "feat(index): buildIndex — sorted voxel grid"`

---

### Task 2: `pointsInRadius` and `nearestPoint`

**Files:**
- Create: `src/index/query.js`, `test/helpers/clouds.js`
- Modify: `src/index.js`
- Test: `test/index/query.test.js`

**Interfaces:**
- Consumes: Task 1's `lookup`, `checkIndex`, `PointIndex` fields.
- Produces (public):
  - `pointsInRadius(index, point: [x, y, z?], radius, { xy }?) -> Uint32Array` (selection).
  - `nearestPoint(index, point: [x, y, z?], { maxDistance, xy }?) -> number` (point number, or −1).
- Produces (test helper, `test/helpers/clouds.js`): `randomCloud(n, { seed, kind: "uniform" | "clustered" | "plane", float32, positions }) -> cols` — a seeded generator (mulberry32) so failures reproduce; `"clustered"` puts 80 % of points in 5 tight Gaussian blobs and 20 % uniform; `"plane"` has z = 0.
- Every query calls `checkIndex(index, fn)` first.
- Validation: `point` must be an array of 3 finite numbers (2 or 3 with `xy`) → INVALID_ARGUMENT `/point/`; `radius` / `maxDistance` positive finite (`maxDistance` may be omitted = unlimited) → `/radius/`, `/maxDistance/`.

- [ ] **Step 1: Write the failing tests** in `test/index/query.test.js`

```js
// bruteRadius(cols, p, r, xy) and bruteNearest(cols, p, maxD, xy) are plain scans in Float64,
// ties to the lowest index — written in the test file
test("pointsInRadius equals brute force", function () {
	// for kind in uniform / clustered / plane, float32 on / off, positions on / off,
	// cellSize in [0.05, 0.5, 2, 20, 200] (the box is 100 m), 50 random query points
	// (half inside the box, half up to 50 m outside), radius in [0.3, 3, 30], xy on / off:
	// deepEqual(Array.from(pointsInRadius(ix, p, r, { xy })), bruteRadius(...))
});
test("nearestPoint equals brute force, inside and outside the grid", function () {
	// the same sweep, maxDistance in [undefined, 0.5, 5]; −1 when brute force finds none
});
test("points exactly at the radius are included; coincident points all returned", function () {
	// cols x = [0, 3, 3, 3, 7], y = z = 0; pointsInRadius(ix, [0,0,0], 3) → [0, 1, 2, 3]
	// nearestPoint(ix, [3, 0, 0]) → 1 (lowest of the three coincident)
});
test("xy: a crest point above a toe point", function () {
	// crest (10, 0, 20), toe (10.4, 0, 10); query (10.3, 0, 0):
	// nearestPoint xy → toe's number (0.1 away in XY); nearestPoint 3D → toe's number (closer in 3D too)
	// query (10.1, 0, 25): xy → crest; 3D → crest
	// with xy the query's z may be omitted: nearestPoint(ix, [10.1, 0], { xy: true }) → crest
});
test("a small maxDistance on a big empty grid returns −1 quickly", function () {
	// two points 10 km apart, cellSize 0.1; nearestPoint(ix, [5000, 0, 0], { maxDistance: 1 }) → −1 in < 50 ms
});
test("Float32 positions at local-origin magnitude equal the Float64 x / y / z", function () {
	// 10 000 points in ±500 m stored as Float32 positions and as Float64 x/y/z of the same Float32 values:
	// every query result identical
});
test("bad arguments are refused, naming the argument", function () { /* point [1, 2] without xy, [1, NaN, 2], radius 0, maxDistance -1 */ });
```

- [ ] **Step 2: Run** `node --test "test/index/*.test.js"` — Expected: FAIL.

- [ ] **Step 3: Implement in `src/index/query.js`**

`pointsInRadius`: visit the cells of the query's bounding box (clamped to the grid; with `xy`, every `iz` of each column), skip a cell whose nearest point to the query is beyond `radius`, distance-check its points, sort the hits (`Uint32Array.prototype.sort`). `nearestPoint`: rings of Chebyshev cell distance `r = 0, 1, 2 …` around the query's cell (clamped into the grid). After ring `r`, the unvisited points lie outside the world box `B_r` of cells `c − r .. c + r`; the lower bound on their distance is `min_a(q_a − lo_a, hi_a − q_a)` when the query is inside `B_r`, else 0. Stop when best ≤ bound, when bound > `maxDistance`, or when `B_r` covers the whole grid. With `xy`, rings and bounds are in XY over whole columns.

- [ ] **Step 4: Run** `node --test "test/index/*.test.js"` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(index): pointsInRadius and nearestPoint"` (with the files above).

---

### Task 3: `pointsNearRay`

**Files:**
- Modify: `src/index/query.js`, `src/index.js`
- Test: `test/index/ray.test.js`

**Interfaces:**
- Consumes: Task 1's grid internals; Task 2's `randomCloud` helper.
- Produces (public): `pointsNearRay(index, origin: [x, y, z], direction: [x, y, z], { radius, growth = 0, maxT }) -> { points: Uint32Array, t: Float64Array, d: Float64Array }` — `points` ascending; `t[i]`, `d[i]` belong to `points[i]`.
- Validation: `origin` / `direction` 3 finite numbers → `/origin/`, `/direction/`; a zero-length direction → `/direction/`; `radius` positive finite (required) → `/radius/`; `growth` ≥ 0 finite → `/growth/`; `maxT` positive finite or omitted → `/maxT/`.

- [ ] **Step 1: Write the failing tests** in `test/index/ray.test.js`

```js
// bruteRay(cols, o, dir, radius, growth, maxT): for every point, t = (p − o)·û, d = |(p − o) − t û|,
// kept when t ≥ 0, t ≤ maxT (if given) and d ≤ radius + growth · t; returns { points, t, d }
test("pointsNearRay equals brute force: cylinder and cone, many cell sizes", function () {
	// clouds as Task 2; 40 random rays per cloud (origins inside and up to 200 m outside the box,
	// random unit directions, plus axis-aligned ones), radius in [0.2, 2], growth in [0, 0.01],
	// maxT in [undefined, 60]: points equal; t and d equal within 1e-9
});
test("points behind the origin are not returned; the cone widens with t", function () {
	// points (−5, 0.1, 0), (5, 0.1, 0), (50, 0.8, 0); ray from origin along +x, radius 0.5:
	// growth 0 → [1]; growth 0.01 → [1, 2] (radius at t = 50 is 1.0); t = [5, 50], d = [0.1, 0.8]
});
test("an unnormalised direction gives the same result as the unit one", function () { /* dir [0, 0, -7] vs [0, 0, -1] */ });
test("a ray that misses the grid returns empty arrays", function () { /* three empty typed arrays */ });
test("bad arguments are refused, naming the argument", function () { /* direction [0,0,0], radius missing, growth -1, maxT 0 */ });
```

- [ ] **Step 2: Run** `node --test "test/index/ray.test.js"` — Expected: FAIL.

- [ ] **Step 3: Implement `pointsNearRay` in `src/index/query.js`**

Normalise the direction. Let `T = min(maxT ?? ∞, |o − centre| + diagonal / 2)` (no point has a larger `t`) and `R = radius + growth · T`; clip `[0, T]` to where the ray is within the grid box grown by `R` (slab method); empty → empty result. Step `t` by `cellSize`; each step visits the cells of the box around the segment `[o + t û, o + (t + cellSize) û]` grown by `radius + growth · (t + cellSize)`, clamped to the grid; a `Set` of slots already visited; distance-check each point as `bruteRay` does (Float64; `d` from the cross product, not `sqrt(|p−o|² − t²)`). Sort by point number at the end, carrying `t` and `d`.

- [ ] **Step 4: Run** `node --test "test/index/*.test.js"` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(index): pointsNearRay — cylinder / cone query for the snap"`

---

### Task 4: `selectSparse`

**Files:**
- Create: `src/ops/sparse.js`
- Modify: `src/index.js`
- Test: `test/ops/sparse.test.js`

**Interfaces:**
- Consumes: Task 1's `coordsOf`, `buildGrid`, `lookup`, `checkPointCount`; Task 2's `randomCloud`.
- Produces (public): `selectSparse(cols, { radius, minNeighbours = 1, xy = false }) -> Uint32Array` — points with fewer than `minNeighbours` **other** points within `radius` (≤).
- Validation: `opts` or `radius` missing / not positive finite → `/radius/`; `minNeighbours` not a whole number ≥ 1 → `/minNeighbours/`.

- [ ] **Step 1: Write the failing tests** in `test/ops/sparse.test.js`

```js
test("selectSparse equals a brute-force neighbour count", function () {
	// 3000-point clouds (uniform, clustered, plane; Float32 / Float64; positions), radius in [0.5, 2, 5],
	// minNeighbours in [1, 3, 8], xy on / off: deepEqual with a plain O(n²) count
});
test("one lone point among a dense patch is the only one flagged", function () {
	// 400 points on a 0.5 m grid (20 × 20, z = 0) plus one at (5, 5, 30): radius 2 → [400]
});
test("a scanned blasthole survives at minNeighbours 1 and is flagged at 3", function () {
	// bench: 0.5 m grid 40 × 40 at z = 0; hole: 8 points at (10.25, 10.25, −1.5 · i), i = 1..8
	// (1.5 m apart, the first 1.5 m below the bench, 0.35 m from the nearest bench point in XY)
	// radius 2, minNeighbours 1 → []; minNeighbours 3 → includes the hole's bottom point (its only
	// neighbour within 2 m is the one above it)
});
test("points exactly at the radius count; coincident points are each other's neighbours", function () {
	// x = [0, 2, 10, 10], radius 2 → [] ; x = [0, 2.0001, 10, 10], radius 2 → [0, 1]
});
test("xy counts in 2D", function () {
	// two points (0,0,0), (0,0,50): 3D radius 2 → [0, 1]; xy → []
});
test("count 0 → empty selection; one point → [0]", function () {});
test("bad arguments are refused, naming the argument", function () { /* radius missing / 0 / NaN; minNeighbours 0, 1.5 */ });
```

- [ ] **Step 2: Run** `node --test "test/ops/sparse.test.js"` — Expected: FAIL.

- [ ] **Step 3: Implement `selectSparse` in `src/ops/sparse.js`**

`buildGrid(coords, count, radius, xy)`; for each point visit its own cell first, then the other 26 (8 with `xy`), counting other points within `radius` and stopping at `minNeighbours`; collect the rest in ascending order. Export from `src/index.js`.

- [ ] **Step 4: Run** `node --test "test/ops/*.test.js"` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(ops): selectSparse — the sparse-point (dust) filter"`

---

### Task 5: `dedupeSelection` — dedupe's index map

**Files:**
- Modify: `src/filter/dedupe.js`, `src/index.js`
- Test: `test/filter/dedupe.test.js`

**Interfaces:**
- Produces (public): `dedupeSelection(cols, tolerance, { z }?) -> { keep: Uint32Array, map: Uint32Array }` — `keep` exactly the points `dedupe` keeps today; `map.length === cols.count`; `map[keep[j]] === j`; for a dropped point, `map[i]` is the position in `keep` of the nearest kept point within `tolerance` (same 2D / 3D metric as the decision; ties to the lowest point number).
- `dedupe(cols, tolerance, opts)` keeps its signature and output (columns moved with 0.5.0's `gather`, `__proto__`-safe as now), now built on `dedupeSelection`.

- [ ] **Step 1: Write the failing tests** (append to `test/filter/dedupe.test.js`; every existing test stays unchanged)

```js
test("dedupeSelection.keep is what dedupe keeps (UTM, 2D and 3D)", function () {
	// the existing random UTM clouds: keepPoints(c, keep) deepEqual dedupe(c, 0.01, { z }) column by column
});
test("dedupeSelection.map: kept points map to themselves, dropped to their nearest kept point", function () {
	// brute force: for each dropped i, the nearest kept point within tolerance (lowest number on ties),
	// then its position in keep; 2D and 3D
});
test("map names the nearest kept point, not the one that caused the drop", function () {
	// x = [0, 0.9, 1.7], tolerance 1 (XY): point 0 kept; 1 dropped (0.9 from 0); 2 kept (1.7 from 0,
	// point 1 is dropped so it does not block); map = [0, 1, 1] — point 1 is 0.8 from point 2, nearer than point 0
});
test("dedupeSelection on count 0", function () { /* { keep: [], map: [] } */ });
```

- [ ] **Step 2: Run** `node --test "test/filter/*.test.js"` — Expected: FAIL.

- [ ] **Step 3: Implement in `src/filter/dedupe.js`**

Keep the current incremental pass (it decides `keep`); in it set `map[i] = nKept` for each kept point. Then, for each dropped point, scan the same neighbour cells (the `head` lists hold kept points only) for the nearest kept point within tolerance, ties to the lower number, and set `map[i] = map[that point]`. `dedupe` = `dedupeSelection` + the existing column move over `keep`. Export `dedupeSelection` from `src/index.js`.

- [ ] **Step 4: Run** `node --test "test/filter/*.test.js"` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(filter): dedupeSelection — dedupe's keep selection and index map"`

---

### Task 6: PDAL oracle, private sample check and the bench

**Files:**
- Create: `test/ops/sparsePdal.test.js`, `_dev/benchSparse.mjs`
- Modify: `test/samples.test.js`
- Local only (gitignored, never committed): `samples/paths.txt` gains Brent's dusty pit scan path (add it if missing), and `samples/private-patterns.txt` its file name stem.

**Interfaces:**
- Consumes: `selectSparse` (Task 4), `buildIndex` (Task 1), `writeLas`, `openLas`, `findSamples`, `randomCloud`.
- PDAL facts (probed with PDAL 2.10.0, 2026-10-22): `filters.outlier --filters.outlier.method=radius --filters.outlier.radius=R --filters.outlier.min_k=K` sets classification 7 on points with fewer than K **other** points within R — so PDAL's `min_k` = our `minNeighbours`; a point exactly R away is **not** counted by PDAL (ours counts it); when every point would be flagged PDAL flags none.

- [ ] **Step 1: Write `test/ops/sparsePdal.test.js`** (opt-in, the `test/laz/pdalWrite.test.js` pattern: skipped loudly without `LAS_PDAL`)

```js
test("PDAL's radius outlier flags the same points as selectSparse", async function () {
	// clouds: randomCloud 5000 clustered and uniform (seeded), written with writeLas (format 0, scale 0.001);
	// coordinates re-read from that file (so both sides see the same rounded values);
	// R in [1, 2.5], K in [1, 3]; any point pair whose distance is within 1e-6 of R is moved away first
	// (rebuild the cloud with another seed) so < and ≤ agree; a case where every point would be
	// flagged is skipped. pdal translate … outlier … → read classification; the indices with class 7
	// deepEqual selectSparse(read, { radius: R, minNeighbours: K })
});
```

- [ ] **Step 2: Run** `LAS_PDAL="C:/Program Files/QGIS 4.2.3/bin/pdal.exe" node --test "test/ops/sparsePdal.test.js"` — Expected: PASS; without `LAS_PDAL` — 1 skipped.

- [ ] **Step 3: Add to `test/samples.test.js`** — for each sample with a z range (all of them): read at most 2 M points of a 20 m × 20 m XY crop around the cloud's centre (`polygon` on read), `selectSparse(crop, { radius: 2 })` and, with `LAS_PDAL`, the same crop written to a temporary LAS and run through PDAL as Step 1 (same equality, same exact-radius guard); log the flagged count and time by sample id only.

- [ ] **Step 4: Write `_dev/benchSparse.mjs`** — `node _dev/benchSparse.mjs <sample id | path> [radius=2] [minNeighbours=1]`: reads x / y / z as Float32 with a local origin (as Kirra), times `buildIndex` (auto cellSize) and `selectSparse`, prints point count, flagged count, both times, and `process.memoryUsage().arrayBuffers` peak; prints the sample id, never the path, when given an id.

- [ ] **Step 5: Run** the bench on Brent's dusty pit scan (`node --max-old-space-size=16384 _dev/benchSparse.mjs s<N>`), record the numbers in the task report (not in a tracked file); then `npm test`, `npm run check:private` — Expected: PASS, check:private ok.

- [ ] **Step 6: Commit** — `git add test/ops/sparsePdal.test.js test/samples.test.js _dev/benchSparse.mjs && git commit -m "test: PDAL oracle and private-sample check for selectSparse; bench"`

---

### Task 7: Demo Sparse section, docs and release 0.6.0

**Files:**
- Modify: `examples/browser/index.html`, `examples/browser/demo.js`, `examples/browser/README.md`, `README.md`, `CHANGELOG.md`, `package.json`, `src/index.js` (`VERSION`)
- Test: `test/package.test.js` (already checks VERSION = package.json)

**Interfaces:**
- Consumes: `selectSparse` (Task 4); the demo's existing `select(name, make)` helper (`examples/browser/demo.js:348`), which unions a selection into the current one and shows it in the selection colour, so Keep / Delete / Split act on it.

- [ ] **Step 1: Demo** — in the Edit tab, after the Classes row, a "Sparse" row: `Radius` number input `id="sparseRadius"` (value 2, min 0.01, step 0.1), `Min neighbours` `id="sparseMin"` (value 1, min 1, step 1), button `id="selSparseButton"` "Sparse points" (disabled until a cloud is loaded, as the other selection buttons). Click → `select("Sparse", function () { return selectSparse(cloud, { radius: Number($("sparseRadius").value), minNeighbours: Number($("sparseMin").value) }); })`. The flagged points show in the selection colour (yellow), the same as every other selection — the spec's "red" is the demo's selection colour (ruling: one selection colour keeps Keep / Delete / Split unambiguous). The About text lists the sparse filter. No snapping in the demo.

- [ ] **Step 2: Check in Chrome** — `npm run demo`, open f3.laz, Edit → Sparse points at radius 2: status shows the count and time; Delete removes them; no console errors.

- [ ] **Step 3: Docs** — README: a "Neighbour index" section (`buildIndex`, the three queries, the rule "rebuild after any keep / remove / merge / transform; after an `inPlace` edit an old index reads overwritten memory"), a "Sparse points (dust)" section (`removePoints(cols, selectSparse(cols, { radius: 2 }))`, and that `minNeighbours: 1` keeps thin features such as blastholes while clumped dust survives — raise `minNeighbours` to remove small clumps at the cost of thin features), `dedupeSelection` under dedupe. CHANGELOG `## 0.6.0` listing the new functions and the bench figures from Task 6 (no file name). Version `0.6.0` in `package.json` and `src/index.js`.

- [ ] **Step 4: Run** `npm test`, `npm run test:coverage` (no metric below lines 99.67, branches 96.52, functions 97.91), `npm run check:private` — Expected: all pass.

- [ ] **Step 5: Commit** — `git add examples/browser README.md CHANGELOG.md package.json src/index.js && git commit -m "release: 0.6.0 — voxel index, selectSparse, dedupeSelection; demo Sparse section"`
