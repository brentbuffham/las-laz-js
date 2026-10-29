# TEMPORARY RESUME NOTE — delete this file once the next session has started

Written 2026-10-29 on the Dell, to resume on the Lenovo. This file is deliberately committed (not git-ignored) so it
travels with the repo. **First thing next session: read it, then `git rm TEMP-RESUME-NOTE.md` and commit, so it is not
carried into a release.**

Branch: `wip/double-layer` (pull this, not `main`). Nothing is released; version is still 0.18.0.

## What this work is

ODM point clouds sometimes show a **double layer**: a second, sparser sheet parallel to the real surface, a little
above or below it (the user's side-profile screenshot). Wanted: select the ghost sheet, then **move it onto the
dominant layer**, preferably automatically (Kirra's transform tool is the manual fallback).

## What is built (all uncommitted before this note; now on the branch)

- `src/ops/doubleLayer.js`: `selectDoubleLayer(cols, { cell, minGap, maxGap, keep, minPoints, smooth, anchor })` and
  `snapToLayer(cols, found, { mode, blend, inPlace })`.
  - `keep`: `"auto"` (layer with most points, upper on a tie) | `"upper"` | `"lower"`.
  - `mode`: `"offset"` (add dz, keeps relief) | `"surface"` (flatten) | `"average"` (both layers meet; `blend` 0..1, default 0.5).
  - Result: `{ selection, dz, dominantZ, partner: { selection, dz }, stats }`. dz is per-cell, smoothed over `smooth` rings.
- Store versions in `src/tiles/storeOps.js`: `selectDoubleLayerStore`, `snapToLayerStore`; region job `doubleRegion`
  in `src/tiles/regionJobs.js`. Overlap = `cell * (smooth + 2)`; one grid anchored at the store's corner.
- Worker messages in `src/workers/workerProtocol.js`: `findDoubleLayer`, `classifyDoubleLayer`, `snapDoubleLayer`
  (the Worker keeps the found result until another edit clears it).
- Demo: Tiles tab, new "Double layer" section (`examples/browser/index.html`, `tiles.js`): Find, Classify found, Snap.
- Tests: `test/ops/doubleLayer.test.js`, `test/tiles/doubleLayerStore.test.js`, `test/workers/doubleLayer.test.js` (all pass).
- README "Double layers" section and a CHANGELOG "Unreleased" entry.

Full `npm test` on the Dell: 943 pass, 2 fail — `dedupe handles 2 million points...` and `a cluster of 20,000 coincident
points stays fast`. Both are timing tests ("a few seconds") that ran while a 93 M-point job and Chrome were busy.
Not touched by this work; **re-run on an idle machine to confirm**. Also run `npm run test:coverage` (thresholds
97 / 88 / 97) — not run yet; the new code may need a few more tests for branches.

## Status on the real data: NOT yet tuned

Test file: `S4-250-402-odm_georef.laz` (384 MB, 93 M points, ~131 x 132 m, z 232–252, about 1 cm spacing, ~10,000 pts/m²).
It is NOT in the repo. The tile store was built in the Dell browser's OPFS, so the Lenovo has to import the LAZ
and Build tiles again (demo: `npm run demo`, http://localhost:8080/examples/browser/ — no HMR, reload after each change).

- Full-store Find (cell 1 m, gap 0.3 m, keep auto): **157 s**, found only **673** ghost points, dz median 0.59 m,
  range −1.3 to +0.7 (negative dz = auto kept the sparser layer in some cells). Does not look like the screenshot.
- A thin slice at y≈6772034 (2 m wide): on 0.2 m bins only 5 of 564 bins had two layers. The doubled sheet is not there.
- A 12 x 12 m window at (478150, 6772000): cell 0.1 / gap 0.1 gave ~2000 "double" cells with a steady dz of 0.13–0.22 m,
  possibly slope steps (false positives), not confirmed; cell 0.2 / gap 0.3 found nothing.
- **Lesson:** on a slope the real surface fills the z-gap inside a 1 m cell (1 in 2 slope = 0.5 m rise per metre).
  Cell must be small (0.1–0.2 m at this density) or the heights detrended first.
- The screenshot's two sheets look ~1.5–4 m apart, but this file shows little of that. Possibly a different crop/file.

## Questions to settle with the user (the ghosting)

1. **Where** is the doubled area in this file? An X/Y range, a polygon drawn in the demo, or which axis the profile
   was cut along. Is the screenshot from this exact file?
2. Roughly what is the **vertical offset** between the sheets, and is it constant or drifting (the picture suggests it grows left to right)?
3. Is the **real surface always the denser/upper** one, or does it vary? (`keep: "auto"` picked the sparser layer in some cells.)
4. Should the cell test be **slope-aware** (detrend each cell by a local plane before splitting layers) instead of
   asking for a tiny cell? Probably yes if small cells prove too noisy; not built.
5. Add a **polygon/box limit** to `selectDoubleLayerStore` so tuning runs on the problem area, not 157 s over the whole cloud?
6. Layers are assumed **vertical (Z)**. Fine for terrain; confirm there are no near-upright faces in the area.
7. Wanted outputs for Kirra: only the selection plus dz stats, or the automatic snap? (Both exist now.)
8. Known simplification: one offset per cell (ghost clusters in a cell are weight-averaged); more than two layers in a cell are not separated further.

## Reminders

- Delete this file at the start of the next session, then commit.
- Nothing is pushed to `main`; nothing is tagged, so the npm publish workflow has not been triggered.
- Browser tooling on the Dell: Claude-in-Chrome screenshots timed out, JavaScript in the page worked; a JS call over 45 s freezes the call (poll in short steps).
