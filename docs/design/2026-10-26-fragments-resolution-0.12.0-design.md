# las-laz-js 0.12.0: Fragments, what a cloud can resolve, and a watershed: Design Spec

- **Status:** rules agreed in chat 2026-10-26; version, floor and the watershed's place settled by
  Brent the same day (§10)
- **Author:** Brent Buffham (https://kirra-design.com), with Claude
- **Builds on:** 0.11.0 fragments (`2026-10-25-fragments-0.11.0-design.md`)

## 1. Intent

0.11.0 gives a size curve for any cloud, and the curve looks just as confident when the cloud
cannot see the rocks. On a 5.4 cm photogrammetry cloud of S4_250_403 it read P50 1.96 m, against
0.22 m in Strayos' report of the same shot. The only warning (one fragment over a quarter of the
surface) never fired. 0.12.0 makes every result say what the cloud can resolve, keeps the curve
to that range, and adds a second way to find the rocks:

- each result reports the cloud's **point spacing** and its **floor**, the smallest rock it
  measures;
- a **lower limit** (default: the floor) and an **upper limit** (default: none) bound the measured
  curve; what lies below or above each is reported as one share, not as sizes;
- flat patches of surface (sheets) count in the share under the lower limit, not as rocks;
- a coarse cloud gets a **loud warning**, never a refusal;
- `maxDistance` defaults from the spacing;
- **`method: "watershed"`**: a muckpile seen from above, split by flooding a height grid from the
  rock tops. Against hand-drawn rocks it matched about a third more than facet merging, mostly by
  splitting fewer, in about 1/25 of the time (§2);
- **`method: "hybrid"`** (Brent's idea): the watershed, then facet merging on what it leaves in no
  fragment; the rock-shaped fragments found there are rocks too, and what is left is fines. On
  the ultra corner it took fines from 54% to 21% and matched the drawn rocks as well as the
  watershed (§2).

Decisions (Brent, 2026-10-26):
- Warn, do not refuse, however coarse the cloud.
- A lower and an upper limit. Upper 0 = no limit: measure right up to the largest fragment. Upper
  set (say the crusher gap): everything larger is one "larger than X" share.
- Area is the weighting that works on real piles (volume lets a few large fragments carry the
  curve). Only Swebrec has been tried; the model does not change the P-values, which come from
  the measured curve (checked on the ultra corner: Swebrec and Rosin–Rammler give the same
  P20 / P50 / P80 by area, volume and count).
- **Not a rock is fines** (Brent). The share of the surface in no fragment, the sheets and the
  fragments under the lower limit is reported as **fines**. (Claude's caveat, recorded: on a
  coarse cloud that share holds rocks up to the floor, about 1 m at 5 cm spacing, so the
  resolution warnings matter; and it follows the method's settings, the watershed's
  `clipBelow` most of all. Brent's sieve definition is under 115 mm; `finesSize` can place the
  fines point there.)
- The watershed goes in 0.12.0, beside facet merging (which stays for faces, walls and
  drawpoints), and so does the hybrid ("that's a good hybrid").

## 2. The evidence

Point spacing is √(surface area ÷ points). Brent drew rock outlines in Kirra on S4_250_403's
north-west corner: 60 first (drawn b 0.34–0.86 m, q10–q90), then 58 more, 46 of them rocks not
drawn before. Each cloud was scored against them in plan: a rock is a **match** when one fragment
covers it with IoU ≥ 0.5, **merged** when it lies mostly in a fragment that is mostly something
else, **split** when it is in pieces, else **missed**.

| Cloud | Spacing | Facet merging, by drawn b | Notes |
|---|---|---|---|
| Heave survey | 8 cm | none | no facets under maxDistance 0.05; sheets above it |
| ODM, whole pile | 5.4 cm | (not drawn) | 67% of the surface in sheets (c/b < 0.15); area P50 1.96 m |
| ODM, default | 3.3 cm | ≥ 0.7 m: 12 of 17; 0.5–0.7: 3 of 25; < 0.5: 1 of 18 | 33 of 60 swallowed by a larger patch |
| ODM, ultra, boundary | 1.36 cm | ≥ 0.7 m: 19 of 19; 0.5–0.7: 21 of 22; < 0.5: 8 of 19 matched, 9 merged | maxDistance 0.06: 30 match, 20 split, 10 merged, 0 missed; matched b / true b 1.03 |

(Facet merging's "found" counts matches and splits whose largest part still sizes the rock,
b / true b 0.93 median.) The floor is where most rocks of a size come out whole: about 0.7 m at
3.3 cm (21 spacings) and about 0.45 m at 1.36 cm (33 spacings). It does not halve with the
spacing, as photogrammetry smooths over a few pixels whatever the spacing. Two clouds do not fix
the law, so the rule takes the cautious end: **floor = 30 × spacing**.

Real rocks are not sheets: of the 60 drawn rocks, c/b under 0.15 is 1 at 3.3 cm and 0 at
1.36 cm (q10 0.31). maxDistance at the ultra corner: 0.04 (3 spacings) missed 9 rocks, 0.06
(4.4) none, 0.8 (59) merged 11 of the 19 small rocks.

**Watershed against facet merging** (ultra corner, 1.36 cm; the watershed at relief radius 0.5,
seed height 0.01, chosen on the first 60 and then fixed):

| Rocks | Method | Match | Split | Merged | Missed |
|---|---|---|---|---|---|
| First 60 | facet merging (0.06) | 30 | 20 | 10 | 0 |
| First 60 | watershed | 39 | 12 | 7 | 2 |
| Next 58 | facet merging | 24 | 21 | 9 | 4 |
| Next 58 | watershed | 33 | 14 | 8 | 3 |
| The 46 never drawn before | facet merging | 18 | 16 | 8 | 4 |
| The 46 never drawn before | watershed | 23 | 10 | 9 | 4 |

Matched sizes: b / true b 0.98–1.04 for the watershed, 1.03–1.06 for facets. All 12 clipped
settings tried on the first 60 beat facet merging (32–39 matches); tuned on half the rocks and
scored on the other half, the watershed led by 1–2 matches in 30, so the gain is real but modest
and comes from splitting fewer. Seeding on raw height failed (53–58 of 60 merged: on a sloping
pile a flank rock is no peak), hence relief. Colour edges in the flood changed nothing. Time on
10.9 M points in Node: about 6 s, against about 145 s for facet merging.

**The hybrid** (watershed, then facets at maxDistance 0.06 on its residual; fines and P-values by
plan area). Brent's watershed settings (relief radius 1, seed height 0.005) beat the ones above
on the second set (38 against 33), so they are the defaults:

| Watershed settings | Rest | First 60 | Next 58 | Fines | P20 | P50 | P80 | P90 |
|---|---|---|---|---|---|---|---|---|
| R 1, h 0.005 | none (watershed alone) | 38 | 38 | 54% | fines | fines | 0.58 | 0.74 |
| R 1, h 0.005 | **rock-shaped facet fragments** | 38 | 39 | **21%** | fines | 0.41 | 0.64 | 0.78 |
| R 1, h 0.005 | every facet fragment | 38 | 39 | 1% | 0.34 | 0.55 | 0.86 | 1.11 |
| R 1, h 0.005 | rock-shaped, flank pieces joined to the rock they lean on | 39 | 38 | 21% | fines | 0.42 | 0.65 | 0.79 |
| R 0.5, h 0.01 | rock-shaped facet fragments | 39 | 34 | 22% | fines | 0.38 | 0.57 | 0.68 |

The drawn rocks were already the watershed's, so the matches hold; the rocks added from the rest
are undrawn ones in the grey (Brent cannot draw where none is visible), smaller, near the floor
(about 0.41 m), so they are the least checked part. Keeping every facet fragment turns the gaps
into flat "rocks" (1% fines is not believable); joining flank pieces changed nothing. Time on
10.9 M points in Node: about 70 s (the facet run on the ~5.7 M residual points).

## 3. API

### `pointSpacing(cols, options?)` (`src/fragments/spacing.js`, exported)

```js
var s = pointSpacing(pts);   // in the columns' units; NaN for fewer than 9 points
```

A sample of up to 10,000 points (every ⌈n / 10,000⌉th), each one's distance r₈ to its 8th
nearest (`kdNearest`, no distance cap); spacing = median r₈ × √(π / 8): the spacing of a
surface whose density puts 8 points within r₈. Orientation-free (walls and drawpoints too), and
cheap enough to run before choosing `maxDistance`. Option `sample` (default 10,000).

### `findFragments(cols, options)`: changes

- `method`: `"facets"` (default, 0.11.0's facet merging), `"watershed"` or `"hybrid"` (§4). The
  hybrid takes both sets of options: the watershed's for the first pass, the facets' for the
  rest.
- `maxDistance` becomes optional: default 4 × `pointSpacing(cols)`. When given and outside 2.5–8
  spacings, a warning (§5). Not used by the watershed.
- Watershed options: `cell` (default 1.5 × spacing), `reliefRadius` (default 1),
  `seedHeight` (default 0.005), `clipBelow` (default 0, at most 0: cells under the mean surface by more than this are gaps); `minPoints` as for facets. The facet-only options (`maxDistance`,
  `k`, `normals`, `facetOptions`, `concaveAngle`, `surfaceDistance`, `viewpoint`, `fill`,
  `fillDistance`) are ignored by `"watershed"` (not by `"hybrid"`), named in an
  `IGNORED_OPTIONS` warning.
- Each fragment of a hybrid run has `from`: `"watershed"` or `"facets"`; the result adds
  `fromWatershed` and `fromFacets` (counts).
- New results:
  - `method`;
  - `spacing`: `pointSpacing` of the run's points;
  - `floor`: 30 × `spacing` (constant `FLOOR_SPACINGS`);
  - `resolution`: `"fine"` (spacing ≤ 0.015), `"coarse"` (≤ 0.035), `"oversize"` (≤ 0.05) or
    `"unresolved"` (above), in metres (§10);
  - `warnings`: `[{ code, message }]`, every one also in the demo (§6);
  - `cell` (watershed only).
- With the watershed, `facets` is null and `planeDistance` NaN.
- Each fragment gains `sheet`: true when c / b < 0.15 (constant `SHEET_CB`). Sheets stay in
  `fragments` and in the per-point column: they are surface, and the caller may still want to
  see them.

### `sizeDistribution(fragmentsOrResult, options?)`: changes

- The first argument may be the whole `findFragments` result. Then `lower` defaults to its
  `floor`, and its `surfaceArea` and `unassignedArea` are used (below). A plain array behaves as
  in 0.11.0, except for the new options.
- `lower` (default: the result's `floor`, or 0 for an array; 0 = no lower limit). The **fines**,
  the share under the lower limit, is by area: fragments with `size` < `lower`, sheets, and the
  unassigned area, over the whole surface (Σ fragment `area` + `unassignedArea`). It is a share
  of the surface whatever the weight (a scan has no volume or count for unassigned surface).
  The fragments at or above `lower` that are not sheets make the measured curve, by the chosen
  weight, scaled into the rest.
- `upper` (default 0 = none): fragments larger than `upper` are one **share over the upper limit**,
  by the chosen weight; the measured curve stops at `upper`, at 100 − that share.
- `fines` and the new `finesSize`: `fines` keeps 0.11.0's meaning (extra mass the surface cannot
  show, F = `fines` / (1 − `fines`) × the total, as Strayos' fines factor). With `finesSize`
  (e.g. 0.115) it is a point on the curve at that size; without it, a bin under the smallest
  size, as in 0.11.0.
- `weight` default changes from `"volume"` to `"area"` (§10).
- New results: `lower`, `upper`, `finesShare` (% of the surface that is not a rock: under the
  lower limit), `over` (% over the upper limit). The `fines` option still adds unseen mass on top,
  as 0.11.0.
- `p[P]` gains `below` and `above`: when P falls under `finesShare`, `size` is `lower` and
  `below` is true (shown "< lower"); when P falls in `over`, `size` is `upper` and `above` is true
  (shown "> upper"). `extrapolated` stays for a fit used under the measured range with no lower
  limit.
- The fit uses only the measured points between the limits (and from `fitFrom` up).

The measured curve, in order: the fines point (if any), the point at `lower` at `finesShare` (plus
F), the measured fragments, the point at `upper` at 100 − `over`, then 100 at the largest.

## 4. The watershed (`src/fragments/watershed.js`)

Plan view, z up: for a muckpile seen from above. A drawpoint, a steep face or an overhang needs
facet merging (§10).

1. **Grid:** cells of `cell` over the plan box; each cell's height is its highest point; each
   point remembers its cell. Holes: up to 10 passes, a cell with at least 3 valid neighbours (of
   8) takes their mean; what is left is outside the cloud.
2. **Smooth:** a Gaussian of 1.5 cells, NaN-aware, inside the cloud only.
3. **Relief:** the smoothed height minus its box mean of radius `reliefRadius` (a summed-area
   table, NaN-aware). The pile's slope is out; rock tops stand up, gaps sink.
4. **Seeds:** the extended maxima of relief: reconstruction by dilation of (relief − `seedHeight`)
   under relief (Vincent's hybrid algorithm, 8-connected); the cells where relief − the
   reconstruction ≥ `seedHeight`, in connected groups, one seed each.
5. **Flood** (Meyer): a priority queue on −relief from the seeds' neighbours; each cell takes the
   label of its labelled neighbour of highest relief. Rock edges form where floods meet.
6. **Clip:** cells whose relief is under `clipBelow` (default 0: below the mean surface, the gaps
   and fines) go to no fragment. Without this, every rock takes its fines and sizes read about 30%
   large. With it, matched rocks measure 0.98–1.04 × the drawn outlines, so the grey is mostly
   gaps, not rock flanks. `clipBelow` −0.02 cuts the grey from 53% to 38% for one rock fewer in 60.
7. **Fragments:** each point takes its cell's label; labels with under `minPoints` points go back
   to 0. Per fragment, as 0.11.0's step 8: the PCA axes (`fragmentAxes`), `size` = b, the normal
   the smallest axis turned to face up, `area` and `outline` by `facetOutline` on the fragment's
   plane with cell 2 × `cell`. Ids by size, largest first (ties: count, then the label).
8. **Areas:** `surfaceArea` = the cells holding points × `cell`² (plan area, as the method is
   plan; the cells the hole fill adds round the edge count for nothing, so a selection's outside
   is never counted); `unassignedArea` = the cells in no fragment × `cell`² plus the dropped points' share.

A flat floor floods as one wide, thin fragment: a sheet (c/b ≪ 0.15), so it lands under the lower
limit and the `FLOOR` warning names it (seen on the synthetic pile: 56% of its surface).

Memory: about 50 bytes a grid cell (heights, relief, labels, the queue and heap) plus 8 a point
(its cell, its fragment); measured in the build.

### The hybrid

1. The watershed, steps 1–8.
2. **The rest:** the points it left in no fragment (the clipped gaps, the dropped small labels).
   Facet merging on them alone, with the facet options (`maxDistance` default 4 × spacing, as for
   `"facets"`).
3. **Rocks from the rest:** its fragments that are not sheets (c / b ≥ 0.15); the sheets go back to
   no fragment.
4. **One list:** both sets of fragments, ids by size, largest first (ties: count, then the
   watershed's first, then the old id); `from` on each.
5. **Areas:** plan, as the watershed's: the cells holding points, and those whose points are all in
   no fragment.

The facet run on the rest is most of the time (about 70 s for 10.9 M points, ~5.7 M of them in the
rest). Built in the demo on 2026-10-26 as `watershedThenFacets` in `examples/browser/watershed.js`.

## 5. Warnings

`findFragments` warnings, codes and messages (sizes in the cloud's units):

| Code | When | Message |
|---|---|---|
| `COARSE` | resolution `"coarse"` | "Point spacing 0.024: rocks under about 0.72 are not measured; P-values under that are not sizes." |
| `OVERSIZE_ONLY` | `"oversize"` | "Point spacing 0.042: only rocks over about 1.26 can be measured. Use this for oversize, not for a size curve." |
| `UNRESOLVED` | `"unresolved"` | "Point spacing 0.054: this cloud cannot resolve rocks; the fragments are mostly patches of surface. Rock sizing needs about 0.015 or better (photogrammetry at full image scale, e.g. ODM --pc-quality ultra)." |
| `MAX_DISTANCE` | given maxDistance outside 2.5–8 spacings | "maxDistance 0.8 is 59 point spacings (0.0136); about 4 (0.054) suits this cloud." |
| `SHEETS` | sheets hold over 30% of the surface | "41% of the surface is flat patches, counted under the lower limit." |
| `FLOOR` | one fragment over 25% of the surface | as 0.11.0's demo warning, moved into the library |
| `IGNORED_OPTIONS` | facet-only options given with the watershed | "The watershed does not use maxDistance, concaveAngle." |

`sizeDistribution` adds `LOWER_UNDER_FLOOR` when a given `lower` is under the result's `floor`:
"Lower limit 0.115 is under this cloud's floor (0.41): the curve between them is not measured."

## 6. Demo: the Fragments tab

- **Method:** Facets / Watershed, each showing its own settings (built in the demo on 2026-10-26
  as `examples/browser/watershed.js`; it moves into the library and the demo calls
  `findFragments` with `method`).
- **Max distance** blank = auto (4 × spacing), shown as its placeholder after a run; the
  watershed's **Cell** likewise.
- The status and a warning line (red, as the floor warning) show spacing, floor, resolution and
  every warning.
- **Lower limit** (0 = the floor, shown beside it) and **Upper limit** (0 = none) by the size
  curve; **Fines %** gains **Fines size** (blank = under the smallest size).
- The chart: the measured curve solid between the limits; the band under the lower limit and the
  share over the upper limit drawn as flat steps, labelled ("41% under 0.41 m", "3% over
  1.2 m"); P-values outside shown "< 0.41" / "> 1.2".
- Weight defaults to Area.
- Hover adds "sheet" for a sheet; colour by fragment greys sheets (as none).
- Read tab: when Max points thins the read, the status says so ("every 2nd point: spacing 0.019
  instead of 0.014"), as fragments are density-bound. The Fragments tab repeats it.
- The side panel's width can be dragged (built 2026-10-26).
- A run on a selection counts only the selection: its fines are a share of the selection's
  surface, and the points outside are drawn dark ("Outside the selection", not counted), not
  in the fines grey (Brent, 2026-10-26).
- **Colour by size range** (built 2026-10-26, Brent's ask): Colour = Each fragment / Size range,
  and **Bins** (default 10, 2–64), log-spaced from the smallest fragment to the largest (edges to
  2 significant figures), one vivid colour each (fully saturated hues from violet-blue for the smallest to red for the
  largest); a legend gives
  each range with its fragment count and share of the surface, and a grey "Fines (not a rock)" row
  with its share. After a run Fines % is filled in with that share (editable). Also on the Colour tab as
  "Fragment size". With the limits, the bins should run from the lower to the upper limit, with a
  bin each for "under" and "over".

## 7. Files

- Create: `src/fragments/spacing.js`, `src/fragments/watershed.js` (from the demo's
  `watershed.js`, which goes); `test/fragments/spacing.test.js`,
  `test/fragments/resolution.test.js`, `test/fragments/watershed.test.js`.
- Modify: `src/fragments/findFragments.js` (method, spacing, floor, resolution, warnings, sheet,
  maxDistance default), `src/fragments/sizeDistribution.js` (limits, fines size, area default),
  `src/index.js` (export, VERSION), `_dev/benchFragments.mjs` (a method argument),
  `examples/browser/fragments.js`, `sizeChart.js`, `index.html`, `demo.js` (the thinned-read
  note); README (a "What a cloud can resolve" part with §2's tables, the watershed), CHANGELOG.

## 8. Errors

`INVALID_ARGUMENT`, naming the argument: `method` not `"facets"` or `"watershed"`; `cell`,
`reliefRadius`, `seedHeight` not finite and positive, `clipBelow` not finite or above 0, or `reliefRadius` under 2 × `cell`;
`lower`, `upper` not finite and ≥ 0; `upper` not 0 and not above `lower`; `finesSize` not
positive or not under `lower` (when both set); `pointSpacing`'s `sample` not a whole number ≥ 9.
`maxDistance`, when given, as 0.11.0. A facet run on a cloud whose spacing is NaN (fewer than 9
points) needs `maxDistance` given, else `INVALID_ARGUMENT` "maxDistance is needed: too few points
to measure the spacing". The watershed on such a cloud, or a cloud with no plan extent, returns
no fragments (as 0.11.0 does for an empty cloud).

## 9. Testing (oracles)

- **`pointSpacing`:** a square grid at 0.02 → 0.02 within 5%; a jittered grid and a Poisson
  sample of known density within 10%; the grid stood up as a wall → the same; UTM magnitude →
  the same.
- **Floor and resolution:** the synthetic pile (`test/helpers/rocks.js`) at 0.012, 0.025, 0.04
  and 0.06 spacing → `resolution` fine / coarse / oversize / unresolved, `floor` 30 × spacing,
  the matching warning, and no warning at fine.
- **Sheets:** a 5 × 5 m patch of pebbly ground → its fragments are sheets, counted under the
  lower limit; the synthetic boxes are not sheets (c/b of a box face's fragment ≥ 0.15).
- **`maxDistance`:** omitted → 4 × spacing (the result's fragments as with it given); 0.8 on a
  0.0136 cloud → `MAX_DISTANCE`.
- **Watershed:** on the synthetic pile at 2 cm and 5 mm noise, at least as many visible boxes come
  back as one fragment as with facet merging on the same pile, each matched size within 10% of
  its visible b; two boxes side by side with a valley between → two fragments; one box → one; a
  flat plane → one fragment, a sheet; the pile's floor → a sheet and `FLOOR`; UTM magnitude →
  the same fragments as at the origin; empty, one point, a line of points → no fragments, no
  NaN; facet-only options → `IGNORED_OPTIONS`.
- **Limits by hand:** a small list of fragments with known areas, sizes and an unassigned area →
  `finesShare`, `over`, the measured curve, and `p` with `below` / `above`, as computed by hand, for
  area, volume and count; `finesSize` places the fines point; `upper` 0 and `lower` 0 give
  0.11.0's curve exactly (an array input with the 0.11.0 options, weight given).
- **Fit:** only points between the limits are fitted.
- **Real check** (private, by id): the ultra corner gives `resolution` fine, floor about 0.41, and
  no warning; the watershed matches at least 37 of the first 60 drawn rocks and 31 of the next 58
  (the demo module at R 0.5, h 0.01: 39 and 33); the hybrid at the defaults matches at least 36 and
  37 with fines under 25% (the demo: 38 and 39, 21%); the 5.4 cm pile gives `UNRESOLVED` and
  `SHEETS`.
- **Hybrid:** on the synthetic pile, no fewer boxes found whole than the watershed alone; every
  fragment from the rest is not a sheet; `from`, `fromWatershed`, `fromFacets` add up; no point in
  two fragments.
- **Speed:** the watershed on 1 M points timed (not under coverage).
- Coverage: no metric below 0.11.0's.

## 10. Rulings

1. **Version: 0.12.0** (Brent, 2026-10-26). The weight default changes (volume to area) and
   `sizeDistribution`'s curve gains a band under the floor when given the whole result: behaviour
   changes, not only fixes.
2. **30 spacings, until a third cloud** (Brent, 2026-10-26). Cautious for 3.3 cm (it puts the
   floor at 1.0 m where 0.7 m rocks were found) and about right for 1.36 cm.
3. **The watershed in 0.12.0** (Brent, 2026-10-26), as a `method` of `findFragments`, so both
   methods share the floor, the limits, the warnings and the curve. Facets stay the default:
   they work in any orientation, and the watershed's lead is modest (§2).
4. **Units.** The resolution tiers, messages and `reliefRadius` / `seedHeight` defaults assume
   metres. A cloud in feet would need a `units` option; out of scope until wanted.
5. **The relief test** (a fragment's height above the local surface over b, which cut the 3.3 cm
   tail from 16 fragments ≥ 1.5 m to 2) is left out: its fixed window failed the largest rocks
   and passed the cloud's edge. A size-scaled window could come later.
6. **No region repair.** Watershed regions repaired by facet fragments (merge two regions one
   fragment mostly covers; split one that two fragments divide) matched 40 and 32 against the
   watershed's 39 and 33, at the cost of the facet run; the ceiling (either method right) is 46
   and 40, so a better rule may exist, but not this one. A clip on concavity instead of relief
   scored below the relief clip at every setting tried. (The hybrid, §4, is different: facets
   only on what the watershed left, and it does pay.)
7. **Colour is left out.** On facets, dropping the 30% of points of most colour texture lifted
   matches 30 → 33 but missed 2 rocks; in the watershed's flood, luminance edges changed nothing.
8. **The hybrid in 0.12.0** (Brent, 2026-10-26: "that's a good hybrid"). Only the rock-shaped
   fragments of the rest count; flank joining is left out (no gain). The watershed defaults are
   Brent's R 1, h 0.005.

## 11. Out of scope

Refusing a coarse cloud; the relief test (§10.5); region repair (§10.6); colour (§10.7); a
watershed for faces and drawpoints (a grid on the face's own plane); a floor learned per cloud from its own rocks; mass
from the visible surface beyond the weights there are; Kirra's side, including a Kuz-Ram prediction
to compare with (Brent, 2026-10-26: not in the demo; it belongs with the blast design in Kirra).
