# Fragments 0.12.0 Implementation Plan: what a cloud can resolve, the watershed and the hybrid

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every `findFragments` result says what the cloud can resolve (`spacing`, `floor`, `resolution`, `warnings`, `sheet` per fragment); `findFragments` gains `method: "watershed"` and `method: "hybrid"`; `sizeDistribution` gains lower / upper limits, fines as not-a-rock, and area as its default weight; the demo moves from its experimental `watershed.js` to the library.

**Architecture:** `src/fragments/spacing.js` (`pointSpacing`, exported) and `src/fragments/resolution.js` (constants, tiers, warnings; internal) are new and pure. `src/fragments/watershed.js` is the demo's `examples/browser/watershed.js` moved into the library as an internal (`watershedFragments`, `watershedThenFacets`), reached only through `findFragments`' `method`. `findFragments.js` keeps the facet method as is and grows a dispatcher and the shared result fields; `sizeDistribution.js` grows the limits. The demo calls `findFragments` with `method`.

**Tech Stack:** plain ES modules, `node:test`, no dependencies; Three.js in the demo only.

**Spec:** `docs/design/2026-10-26-fragments-resolution-0.12.0-design.md` (read it whole first; §2's tables are the evidence the defaults rest on).

## Global Constraints

- No dependencies in las-laz-js; no WASM. Never import trimesh-build-js or trimesh-boolean.
- Code style as the repo: `var`, `function` declarations, tabs, a `// src/…` banner block at the top of each new file, JSDoc on every export, `/* prettier-ignore-file */` in tests.
- Errors are `LasError` `ERROR_CODES.INVALID_ARGUMENT` with a message naming the argument.
- Constants (spec §3): `FLOOR_SPACINGS` 30, `SHEET_CB` 0.15; resolution `"fine"` spacing ≤ 0.017 (Task 1 ruling), `"coarse"` ≤ 0.035, `"oversize"` ≤ 0.05, else `"unresolved"` (metres); `maxDistance` default 4 × spacing, `MAX_DISTANCE` warning outside 2.5–8 spacings; `SHEETS` when sheets hold over 30 % of the surface; `FLOOR` when one fragment's area is over 25 % of `surfaceArea`.
- Watershed defaults (spec §3, ruling 8): `cell` 1.5 × spacing, `reliefRadius` 1, `seedHeight` 0.005, `clipBelow` 0, Gaussian 1.5 cells, hole fill 10 passes needing 3 of 8 neighbours, outline cell 2 × `cell`. Areas count only the cells holding points.
- `pointSpacing`: median r₃₂ × √(π / 32) over a golden-ratio sample of up to 10,000 points; NaN under 9 points (Task 1 ruling: r₈ reads grids 11 % low).
- `sizeDistribution` default `weight` becomes `"area"`; everything else as 0.11.0 when given an array and none of the new options.
- Warning messages are the spec §5 table's, with the numbers filled in; codes exact.
- Every new public function is exported from `src/index.js` in the task that writes it: `pointSpacing` only (`watershedFragments`, `watershedThenFacets`, `resolution.js` stay internal).
- Tests are oracles (rocks and sizes by construction, hand-computed curves), never snapshots. Synthetic piles in tests stay small (extent ≤ 6 m, or spacing ≥ 0.02) so `npm test` stays quick.
- `npm test` passes after every task. Coverage after the last task: no metric below the figures `npm run test:coverage` gives at the start of Task 1 (ledger them).
- Private samples and drawn-rock files named by id only, never by path; `npm run check:private` after staging, before every commit.
- Commits straight on `main` (Brent, 2026-10-26: "main is fine to work on"), ending `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; no push, tag or publish before Task 7 Step 7, and that step only after Brent confirms.

## Review Focus

1. **A watershed grid too big for memory.** A whole 200 × 120 m pile at 1.4 cm spacing is ~1.2 × 10⁸ cells at 2 cm, ~50 bytes each. Expected: over 6 × 10⁷ cells the watershed throws `INVALID_ARGUMENT` naming `cell` ("the grid would be W × H cells: give a larger cell or crop the cloud"), before allocating. → Task 3 test.
2. **The watershed on a wall or drawpoint** (a cloud seen side-on): the plan grid collapses the face and the result is quietly meaningless. Expected: a `SIDE_ON` warning when the plan spacing (√(occupied plan cells × cell² ÷ points)) is under 0.6 × `pointSpacing` ("This cloud is seen side-on; the watershed sees from above: use method facets"). → Task 3 test (the pile stood up as a wall).
3. **A lower limit above every fragment** (or a cloud of nothing but sheets): `finesShare` 100, no measured points, every `p` `below`, `fit` null, no NaN, no throw. → Task 5 test.
4. **A selection with a concave outline:** the hole fill must not add area outside it. Expected: an L-shaped cloud's `surfaceArea` within 5 % of its occupied plan area, for both watershed and hybrid. → Task 3 test.
5. **Re-running gives the same answer** (Kirra re-runs on one scan): two watershed runs, and two hybrid runs, on one cloud give identical `fragment` columns and fragment lists. → Tasks 3 and 4 tests.

---

### Task 1: `pointSpacing`

**Files:**
- Create: `src/fragments/spacing.js`
- Modify: `src/index.js`
- Test: `test/fragments/spacing.test.js`

**Interfaces:**
- Consumes: `buildKdTree(cols, fn)`, `kdNearest(tree, qx, qy, qz, k, maxD2, skip, outP, outD2)` from `src/index/kdtree.js`; `coordsOf` from `src/index/grid.js`.
- Produces (public): `pointSpacing(cols, { sample?: number }?) -> number` (NaN under 9 points).

- [ ] **Step 1: Ledger the coverage baseline**: `npm run test:coverage > <workspace>/cov0.txt`; ledger the all-files line.
- [ ] **Step 2: Write the failing tests:**
  - `"a square grid"` — 200 × 200 points at 0.02 in z = 0 → within 5 % of 0.02.
  - `"a jittered grid and a Poisson sample"` — the grid jittered ±0.4 × 0.02 (seeded) → within 10 % of 0.02; 40,000 uniform random points on 4 × 4 m (density 2,500 / m², spacing 1 / √2500 = 0.02) → within 10 % of 0.02.
  - `"a wall is the same"` — the grid stood up in x / z → equal to the flat grid's within 1e-9.
  - `"UTM magnitude is the same"` — the grid at origin (478000, 6771000, 240) in Float64 → within 1e-6 of the origin's.
  - `"too few points"` — 8 points → NaN; 0 points → NaN; no throw.
  - `"sample"` — `sample: 100` on the grid → within 10 %; `sample` 8, 2.5, "x" → `/sample/`.
  - `"exports"` — `lib.pointSpacing` is the module's.
- [ ] **Step 3: Run** `node --test test/fragments/spacing.test.js` — Expected: FAIL (module not found).
- [ ] **Step 4: Implement** per spec §3: kd tree over the columns, k = 9 with `skip` = the point (8 neighbours), median of the 8th distance, × √(π / 8).
- [ ] **Step 5: Run** the file, then `npm test` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(fragments): pointSpacing — the spacing of a surface from its 8 nearest, orientation-free`.

### Task 2: resolution, warnings and sheets in `findFragments` (facets)

**Files:**
- Create: `src/fragments/resolution.js`
- Modify: `src/fragments/findFragments.js`
- Test: `test/fragments/resolution.test.js`

**Interfaces:**
- Consumes: `pointSpacing` (Task 1).
- Produces (internal, `resolution.js`): `FLOOR_SPACINGS`, `SHEET_CB`; `resolutionOf(spacing) -> "fine" | "coarse" | "oversize" | "unresolved"`; `resultFields(cols, fr, spacing, given) -> { spacing, floor, resolution, warnings }` where `given` is `{ maxDistance?: number, ignored?: string[] }`, and marks `sheet` on each of `fr.fragments`.
- Produces (public, `findFragments`): `maxDistance` optional; `method` option (`"facets"` only in this task; anything else `INVALID_ARGUMENT` naming `method`); new result fields `method`, `spacing`, `floor`, `resolution`, `warnings: [{ code, message }]`; `fragments[i].sheet: boolean`.

- [ ] **Step 1: Write the failing tests:**
  - `"resolution tiers"` — `resolutionOf` at 0.01, 0.017, 0.018, 0.035, 0.036, 0.05, 0.051 → fine, fine, coarse, coarse, oversize, oversize, unresolved.
  - `"warnings by spacing"` — `rockPile` (extent 4, 20 boxes, seed 1) at spacing 0.02 → `resolution` "coarse", one `COARSE` warning whose message contains "0.020" and "0.60"; at 0.04 → `OVERSIZE_ONLY`; at 0.06 → `UNRESOLVED`; at 0.012 (extent 3) → "fine", no resolution warning. `floor` = 30 × `spacing` (1e-12) each time.
  - `"maxDistance from the spacing"` — on the 0.02 pile, omitted → the same `fragment` column as `maxDistance: 4 * fr.spacing` given; `maxDistance: 0.8` → a `MAX_DISTANCE` warning naming 0.8 and the spacing; 0.08 (4 spacings) → none.
  - `"too few points and no maxDistance"` — 5 points, no `maxDistance` → `/maxDistance is needed/`; with `maxDistance` given → no throw, empty `fragments`.
  - `"sheets"` — a 5 × 5 m pebble field (`rockPile` boxes [], fines "pebbles") → every fragment with c / b < 0.15 has `sheet` true and the rest false; the boxes of the 0.02 pile → no box's fragment (≥ 90 % its points) is a sheet; `SHEETS` when sheets hold over 30 % of the surface, with the share in the message.
  - `"the floor is named"` — the flat-floor pile of `findFragments.test.js` ("a flat floor…") → a `FLOOR` warning naming the largest fragment's id.
  - `"method"` — `method: "kuz-ram"` → `/method/`; `method: "facets"` → the same result as no `method`; `result.method` "facets".
- [ ] **Step 2: Run** `node --test test/fragments/resolution.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `resolution.js` and wire it at the end of `findFragments` (spacing of the run's points; `maxDistance` defaulted before `checkFacetOptions`). Messages from spec §5 with values to 3 decimals for spacings and 2 for sizes.
- [ ] **Step 4: Run** the file, then `npm test` — Expected: PASS (0.11.0's tests unchanged: they all give `maxDistance`).
- [ ] **Step 5: Commit** `feat(fragments): every result says what the cloud resolves — spacing, floor, resolution, warnings, sheets; maxDistance from the spacing`.

### Task 3: `method: "watershed"`

**Files:**
- Create: `src/fragments/watershed.js` (from `examples/browser/watershed.js`'s `watershedFragments`, the demo copy left in place until Task 6)
- Modify: `src/fragments/findFragments.js`
- Test: `test/fragments/watershed.test.js`

**Interfaces:**
- Consumes: `pointSpacing`, `resultFields` (Tasks 1–2); `fragmentAxes`; `facetOutline`.
- Produces (internal): `watershedFragments(cols, { cell, reliefRadius, seedHeight, clipBelow, minPoints, onProgress }, spacing) -> { fragment, fragments, surfaceArea, unassignedArea, cell, labels: { lab, cellOf, W, N } }` (the pre-clip cell labels for Task 4).
- Produces (public, `findFragments` with `method: "watershed"`): options `cell`, `reliefRadius`, `seedHeight`, `clipBelow`, `minPoints`; result as Task 2's plus `cell`, `facets` null, `planeDistance` NaN; warnings `IGNORED_OPTIONS`, `SIDE_ON`.

- [ ] **Step 1: Write the failing tests:**
  - `"boxes come back whole"` — the 0.02 pile of Task 2 (extent 6, 60 boxes): the share of boxes with `visibleB` ≥ 10 spacings that are one fragment (≥ 90 % of its points in it, ≥ 80 % of the fragment its points) is at least the facet method's share on the same pile minus 0.02; each such fragment's `size` within 10 % of `visibleB`.
  - `"two boxes with a valley are two; one box is one"` — the `vee` pair and the single box of `findFragments.test.js` → 2 and 1 fragments (≥ 80 % of each box).
  - `"a flat plane is one sheet"` — a 4 × 4 m plane with 2 mm noise → one fragment covering most of it, `sheet` true; with the flat-floor pile → `FLOOR` names it.
  - `"areas count only the cloud"` (Review Focus 4) — an L-shaped flat cloud (two 2 × 4 m arms at 0.02) → `surfaceArea` within 5 % of 12 m².
  - `"the grid is bounded"` (Review Focus 1) — 3 points at (0,0), (3000, 0), (0, 3000) with `cell: 0.01` → `/cell/` and "crop", before any big allocation (the test finishes in under 1 s).
  - `"side-on"` (Review Focus 2) — the 0.02 pile turned so z is y (a wall) → a `SIDE_ON` warning; the flat pile → none.
  - `"facet options are named, not used"` — `concaveAngle: 5, viewpoint: [0, 0, 9]` → `IGNORED_OPTIONS` naming both; the same fragments as without.
  - `"UTM magnitude"` — the pile at origin (478000, 6771000, 240) Float64 → the same `fragment` column as at the origin.
  - `"the same run twice"` (Review Focus 5) — identical `fragment` and fragment lists.
  - `"hard inputs"` — empty, one point, a line of 50 points → no fragments, no NaN, no throw.
  - `"bad options"` — `cell` 0 or -1 → `/cell/`; `reliefRadius` under 2 × `cell` → `/reliefRadius/`; `seedHeight` 0 → `/seedHeight/`; `clipBelow` 0.01 → `/clipBelow/`.
- [ ] **Step 2: Run** `node --test test/fragments/watershed.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §4 steps 1–8: move the demo's code; replace its occupied-cell spacing estimate with `pointSpacing`; the grid-size check (Review Focus 1) before allocating; the `SIDE_ON` check from the occupied cells; the dispatcher in `findFragments` (validate the method's own options; list given facet-only options for `IGNORED_OPTIONS`); then `resultFields`.
- [ ] **Step 4: Run** the file, then `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(fragments): method watershed — a height grid flooded from the rock tops, gaps clipped, for a muckpile seen from above`.

### Task 4: `method: "hybrid"`

**Files:**
- Modify: `src/fragments/watershed.js` (add `watershedThenFacets`, from the demo's), `src/fragments/findFragments.js`
- Test: `test/fragments/watershed.test.js` (a `hybrid` block)

**Interfaces:**
- Consumes: `watershedFragments` (Task 3); the facet method's internal entry (the body of 0.11.0's `findFragments`, kept callable as `facetFragments(cols, o)` inside `findFragments.js` and exported from it for this module only).
- Produces (public, `method: "hybrid"`): both option sets; each fragment `from: "watershed" | "facets"`; result `fromWatershed`, `fromFacets`; the facet pass's `maxDistance` defaults from the whole run's spacing; `facets` = the rest's `findFacets` result.

- [ ] **Step 1: Write the failing tests:**
  - `"the rest finds rocks the watershed left"` — on the 0.02 pile with `seedHeight: 0.05` (high, so some boxes get no seed and stay in the rest): the hybrid finds at least as many boxes whole as the watershed alone, and more than it on this pile.
  - `"only rock-shaped pieces of the rest count"` — every fragment with `from` "facets" has c / b ≥ 0.15.
  - `"the bookkeeping adds up"` — `fromWatershed + fromFacets` = `fragments.length`; ids 1 … n by size; no point in two fragments; every point of a `from: "watershed"` fragment is in the watershed-alone run's matching fragment.
  - `"areas count only the cloud"` — the L-shaped cloud → `surfaceArea` within 5 % of 12 m².
  - `"the same run twice"` (Review Focus 5) — identical results.
- [ ] **Step 2: Run** the file — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §4 "The hybrid", steps 1–5.
- [ ] **Step 4: Run** the file, then `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(fragments): method hybrid — the watershed, then facets on what it left; rock-shaped pieces are rocks, the rest fines`.

### Task 5: `sizeDistribution` limits, fines and area

**Files:**
- Modify: `src/fragments/sizeDistribution.js`
- Test: `test/fragments/sizeDistribution.test.js` (new tests; existing ones given `weight: "volume"` where they relied on the default)

**Interfaces:**
- Consumes: a `findFragments` result (`fragments`, `floor`, `surfaceArea`, `unassignedArea`) or an array as before.
- Produces (public): options `lower`, `upper`, `finesSize`; results `lower`, `upper`, `finesShare`, `over`, `warnings`; `p[P].below`, `p[P].above`.

- [ ] **Step 1: Write the failing tests:**
  - `"fines and limits by hand"` — fragments sizes 0.2, 0.5, 1, 2, 4 with areas 1, 2, 3, 2, 1, one of size 1 a sheet (axes [1.2, 1, 0.1]), `unassignedArea` 1, `surfaceArea` 10, `floor` 0.4, weight area: `finesShare` = (1 + 1 + 3) / 10 × 100 = 50 (the 0.2 under the floor, the sheet, the unassigned); with `upper: 3`, `over` = 10; the measured points 0.5, 2 at 50 + 20, 50 + 40 → 70, 90; `p[50]` `below` with `size` 0.4; `p[95]` `above` with `size` 3.
  - `"an array keeps 0.11.0's curve"` — the 0.11.0 hand set with `weight: "volume"` and no new options → exactly 0.11.0's `passing`.
  - `"weight defaults to area"` — the hand set with no weight → the area curve.
  - `"finesSize places the fines point"` — `fines: 0.2, finesSize: 0.115` → the curve's first point at 0.115.
  - `"the fit stays between the limits"` — on the Swebrec set of 0.11.0 with `lower` and `upper` at its P30 and P90 sizes → `fit.range` inside them.
  - `"a lower limit above everything"` (Review Focus 3) — `lower: 10` → `finesShare` 100, no measured points, every `p` `below`, `fit` null, no NaN, no throw.
  - `"lower under the floor"` — `lower: 0.115` on a result with `floor` 0.41 → a `LOWER_UNDER_FLOOR` warning naming both.
  - `"bad limits"` — `lower` -1 → `/lower/`; `upper` 0.3 with `lower` 0.4 → `/upper/`; `finesSize` 0.5 with `lower` 0.4 → `/finesSize/`.
- [ ] **Step 2: Run** `node --test test/fragments/sizeDistribution.test.js` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** per spec §3 "sizeDistribution: changes" and the curve order under it.
- [ ] **Step 4: Run** the file, then `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(fragments): sizeDistribution — lower and upper limits, not a rock is fines, area by default`.

### Task 6: demo on the library

**Files:**
- Modify: `examples/browser/fragments.js`, `examples/browser/sizeChart.js`, `examples/browser/index.html`, `examples/browser/demo.js`
- Delete: `examples/browser/watershed.js`

**Interfaces:**
- Consumes: `findFragments` with `method` (Tasks 2–4), `sizeDistribution` with the result and limits (Task 5).

- [ ] **Step 1: Switch the run** to `findFragments(cols, { method, … })` for all three methods; delete `watershed.js`; Max distance and Cell blank = auto, their placeholders showing the values used.
- [ ] **Step 2: The warning line** (red, as the floor warning) lists every `warnings` message; the status adds spacing, floor and resolution.
- [ ] **Step 3: The size curve:** call `sizeDistribution(result, { lower, upper, finesSize, … })`; **Lower limit** (0 = the floor, shown beside it), **Upper limit** (0 = none), **Fines size** fields; Fines % stays the extra unseen fines (0 by default now that `finesShare` comes from the run); the chart draws the fines step and the over step labelled ("41% fines under 0.41 m", "3% over 1.2 m"); the P table shows "fines" / "> upper".
- [ ] **Step 4: Colours:** sheets grey as fines, hover adds "sheet"; with limits set, the size bins run lower → upper, with a fines row and an "over" bin.
- [ ] **Step 5: The thinned read:** when the read was thinned (`readThinned`), the Fragments status and warning line say so with both spacings ("every 2nd point: spacing 0.019 instead of 0.014").
- [ ] **Step 6: Browser check** on the synthetic pile (`samples/generated/pile.las`) in a new tab: each method runs; the warning line shows `COARSE` for the 0.02 pile; limits move the curve and the table; bins and legend follow the limits; a selection counts only itself; no console errors. Then `npm test`.
- [ ] **Step 7: Commit** `demo: Fragments tab on the library — methods, warnings, lower and upper limits, fines`.

### Task 7: real check, docs and release 0.12.0

**Files:**
- Create: `_dev/scoreFragments.mjs` (the session's scoring, from the scratch `score.mjs`: a LAZ and a drawn-rocks file, printing only ids and counts)
- Modify: `_dev/benchFragments.mjs` (a `method` argument), `README.md`, `CHANGELOG.md`, `src/index.js` (VERSION 0.12.0), `package.json`, the library spec's roadmap

- [ ] **Step 1: `_dev/scoreFragments.mjs <sample id | path> <drawings.json | rocks.dxf> [method] [options JSON]`**: match / split / merged / missed (spec §2's rules), fines share, P20–P90 by area; reads Kirra `.kap` drawings.json and R12 POLYLINE DXF.
- [ ] **Step 2: Real check** (Brent's private ultra corner and both drawn sets, by id only): `resolution` fine, floor ~0.48, no warning; watershed ≥ 37 / 60 and ≥ 31 / 58; hybrid ≥ 36 / 60 and ≥ 37 / 58 with fines under 25 %; the 5.4 cm pile `UNRESOLVED` and `SHEETS`. Ledger the figures. A miss is a finding: stop and report it, do not tune to pass.
- [ ] **Step 3: README:** a "What a cloud can resolve" part (spec §2's tables, the tiers, the warnings, not a rock is fines), the three methods and when to use each, `pointSpacing`; CHANGELOG 0.12.0 (behaviour changes first: weight default area, `maxDistance` optional, the result's new fields); VERSION and package.json 0.12.0; the roadmap line.
- [ ] **Step 4: Speed:** `node --expose-gc _dev/benchFragments.mjs <id> 0.06 1 <method>` for facets, watershed and hybrid on the ultra corner; ledger the times and bytes a point for the README (expected about 145 s, 6 s and 70 s on 10.9 M points).
- [ ] **Step 5: Run** `npm run test:coverage` — Expected: no metric below Task 1's ledgered baseline; `npm run check:private` ok.
- [ ] **Step 6: Commit** `release: 0.12.0 — what a cloud can resolve, the watershed and the hybrid, limits and fines`.
- [ ] **Step 7: Publish (Brent asked for it, 2026-10-26) — STOP and confirm with Brent first**, then: `git push origin main`, move the tag `v0.12.0` (Brent set it early, on the spec commit 0199b4a) to the release commit and push it, `npm publish` (Brent may need to run it himself for npm's 2FA: `! npm publish`). 0.11.0 was never published, so 0.12.0 is the first npm release with fragments; the CHANGELOG keeps both entries. A failed or refused publish is reported, never retried with other credentials.
