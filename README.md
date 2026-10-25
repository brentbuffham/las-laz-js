# las-laz-js

A JavaScript reader and writer for ASPRS **LAS** point clouds and **LAZ**
(LASzip-compressed LAS), published on npm as `las-laz-js`. Plain ES modules, no dependencies,
runs in the browser and in Node — and built for files far larger than memory.

**Status: early (0.x).** It works and is tested, but the API may still change before 1.0.

- Working: `openLas` reads the header, VLRs / EVLRs and coordinate system of LAS 1.0–1.4;
  `readPoints` and `chunks` decode every point format (0–10) a window at a time, with filters,
  thinning, a polygon crop, a coordinate transform and the original point index; `colourize`
  colours points; `writeLas` and `createLasWriter` write LAS 1.0–1.4.
- Point operations on columns: select by box, polygon, class or return; keep, remove, split and
  merge; classify (existing classes kept unless asked); transform coordinates; interleave
  positions for a renderer; find sparse points (dust); register a scan to the grid or to another
  cloud (control points, picked pairs, ICP); find facets and joint sets;
  a voxel neighbour index with nearest, radius and near-ray queries. See Point operations.
- LAZ: point formats 0–3 and 6–8, read exactly like LAS — the same calls, the same options,
  decoded chunk by chunk in plain JavaScript (no WebAssembly) — and written with
  `compress: true`, byte for byte what PDAL (LAZperf) writes (bar one lossless exception, see
  Writing LAZ), compressed in parallel.
- Big files: a 1.1 GB, 34-million-point LAS reads in under a second in Node, and a 10-million-point
  LAZ decodes on every core (a 10-million-point file in about 0.6 s); neither is held in memory
  whole (see LAZ below for the one exception).
- Tiles and level of detail: `buildTiles` splits a cloud of any size into an octree of tiles in
  memory, OPFS or a Node folder; `selectTiles` picks the tiles a camera needs within a point
  budget; tiles load as columns, are edited in place and written back to LAS / LAZ. See Tiles.
- Also: a ready-made module Worker (`las-laz-js/worker`) and a
  [Three.js demo](https://brentbuffham.github.io/las-laz-js/).

## Install

```sh
npm install las-laz-js
```

Node 22 or newer, or any current browser. No dependencies.

## Demo

Try it in the browser: **https://brentbuffham.github.io/las-laz-js/**

Drop a LAS or LAZ file onto the page. It is read locally (never uploaded), decoded in the
library's Worker (LAZ on every core) behind a progress bar, then shown once in a Three.js viewer;
colour changes recolour the points already read, without reading the file again. The side panel shows the header, VLRs, coordinate
system and LAZ compression; reads with class, return, bounds, thinning and dedupe filters;
colours by RGB, intensity, elevation or class; lists point statistics; selects points by polygon,
box, class, dust or outliers and keeps, deletes, splits, classifies (with your own named classes),
transforms, smooths or crops them (the Edit tab), with a Roughness colour to see the noise; and saves the
points back out as LAS or LAZ. To run it locally: `npm run demo`, then open http://localhost:8080/.

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
las.classNames;            // { 64: "Bench face", ... } from the Classification Lookup VLR ({} when none)
las.extraBytes;            // [{ name, column, type, k, size, scale, offset, noData, ... }]: see Extra bytes

var pts = await las.readPoints({
	fields: ["x", "y", "z", "classification", "red", "green", "blue"],
	classes: [2],            // keep only these classification codes
	returns: [1],            // keep only these return numbers
	bounds: { minX, maxX, minY, maxY, minZ, maxZ },   // any limit may be left out: an omitted limit is open
	polygon: [x0, y0, x1, y1, x2, y2],   // crop: keep points inside it (file coordinates, XY, even-odd); null is none
	boundary: "touching",    // polygon edge: "touching" keeps points on it (default), "inside" drops them
	tolerance: 0,            // file units: within this of a polygon edge counts as on it
	transform: T,            // { m, t } from makeTransform, applied to world coordinates (see Point operations)
	maxPoints: 5000000,      // even thinning; 0 keeps every point
	dedupe: 0.01,            // drop points within 1 cm (XY; dedupeZ: true for 3D)
	localOrigin: { x: 478000, y: 6772000 }, float32: true,   // small Float32 coordinates for the GPU
	onProgress: function (fraction, label) {},
	signal: abortController.signal
});
pts.count; pts.x; pts.y; pts.z;   // one typed array per field
pts.bounds; pts.stats;            // world bounds (after any transform), per-class counts
```

Fields: `x y z intensity returnNumber numberOfReturns scanDirection edgeOfFlightLine
classification classificationFlags scannerChannel scanAngle userData pointSourceId gpsTime
red green blue nir`. Fields a point format does not hold are left out. `scanAngle` is in
degrees for every format.

`index` is one more field, for every format: the column is present for the points the filters and
`maxPoints` keep, and each value is that record's position in the file (0-based; it is not
renumbered after filtering). It is a `Uint32Array`, or a `Float64Array` for a file of more than
4,294,967,295 points. It is an ordinary column, so keep, remove, split and merge carry it, and it
tells you which records of the file are left.

Filters run on the raw record before it is decoded, so a filtered-out point costs a byte read.
`polygon` is a crop on read: only the points inside it are decoded and held, so a site region of
a large file never costs the whole file in memory. It needs at least 3 vertices (a flat list of
x, y pairs, implicitly closed) and combines with the other filters and `maxPoints`. A LAZ crop
saves memory and field decoding but still decompresses every chunk (there is no spatial index), so
its time is close to a full read.
`maxPoints` keeps exactly that many of the points that pass the filters, spread evenly over
the whole file; with filters set it first counts the passing points, which reads the file twice.

In `bounds`, a limit that is left out (or `null`) is open; before 0.5.0 a missing limit kept
nothing. `polygon: null` means no polygon. `boundary` and `tolerance` belong to `polygon`: a point
within `tolerance` of an edge or vertex is on the boundary, kept by `"touching"` and dropped by
`"inside"`. They are not `dedupe`'s tolerance, which is the value of the `dedupe` option.

`transform` moves the points while they are decoded, in a fixed order: record → world (scale and
offset) → `transform` (Float64) → minus `localOrigin` → Float32 (when `float32` and `localOrigin`
are set). Raw scanner coordinates never pass through Float32 at full magnitude. The filters
(`classes`, `returns`, `bounds`, `polygon`) apply in **file** coordinates, before the transform;
the result's `bounds`, its stats and `dedupe` are in the output coordinates. To crop a scan in
site coordinates, read it transformed and use `selectPolygon`. The Worker's elevation colour
range follows the transform.

## Point operations

Zero-dependency operations on **point columns**: the object `readPoints` returns, or any object
of the same shape, `{ count, <name>: TypedArray, ... }`. A property is a column when it is a typed
array whose length is `count × k` for a whole number `k` of 1 or more (`k` is 1 for `x` or
`classification`, 3 for an interleaved `positions` or `rgb`). Operations carry every column, `k`
values per point, and nothing else: `bounds`, `stats` and the like are not copied, so rebuild them
from the result. A **selection** is a `Uint32Array` of point indices, strictly ascending, each
below `count`. Everything that takes one checks it in one pass and throws `INVALID_ARGUMENT`
naming the first bad position; everything that makes one returns a valid one.

### Select

```js
import { selectBox, selectPolygon, selectClasses, selectReturns, thinSelection,
         unionSelections, intersectSelections, subtractSelections } from "las-laz-js";

var inBox  = selectBox(pts, { minX: 477010, maxX: 477050, minZ: 295 });   // inclusive; a limit left out is open
var inSite = selectPolygon(pts, poly, { boundary: "inside", tolerance: 0.001 });   // poly: [x0, y0, x1, y1, ...]
var ground = selectClasses(pts, [2]);
var last   = selectReturns(pts, { last: true, single: true });   // returns: [..], first, last, single; any one matches
var thin   = thinSelection(pts.count, 1000);                     // exactly min(count, 1000) indices, spread evenly
var wanted = intersectSelections(inSite, ground);                // also unionSelections, subtractSelections
```

`selectPolygon` takes a flat `[x0, y0, x1, y1, ...]` list of at least 3 vertices, closed for you,
in the columns' own coordinates; the interior is the even-odd rule, so a concave polygon works.
Points on the boundary are kept by `boundary: "touching"` (the default) and dropped by `"inside"`,
so the two differ by exactly the boundary points, and `splitPoints` by one polygon loses and
duplicates nothing. Coordinates are not exact in binary, so a point mathematically on an edge may not
count as on it at `tolerance: 0`; use a small tolerance (for example 1e-6 of the units) to catch
boundary points. `minZ` / `maxZ` add a height limit. `thinSelection` is the reader's
`maxPoints` rule: `keepPoints(all, thinSelection(n, t))` gives the points
`readPoints({ maxPoints: t })` does.

### Keep, remove, split, merge

```js
import { keepPoints, removePoints, splitPoints, mergePoints } from "las-laz-js";

var kept    = keepPoints(pts, wanted);              // new columns of the same types
var without = removePoints(pts, wanted);
var [inside, outside] = splitPoints(pts, inSite);   // always copies; every point lands in one result
var both    = mergePoints([inside, outside]);       // concatenated in order; both.filled is []

var crop = keepPoints(big, selectPolygon(big, poly), { inPlace: true });   // no second copy
```

`inPlace: true` (for `keepPoints` and `removePoints`) slides the kept values down inside each
column's own buffer and returns views of that memory: the input is overwritten, and a big cloud is
cropped without a second copy. Columns that share memory (the same array twice, or overlapping
views) are refused, since compacting one would corrupt the other.

`mergePoints` takes the union of the column names; a column missing from an input is zero for
that input's points, and its name is listed in `result.filled`. A column named `count` or
`filled` is refused. A column's `k` must agree across inputs. The result's type is the widest:
Float64 over Float32 over the integer types; an Int32 or Uint32 with a Float32 gives Float64
(Float32 holds integers exactly only to 2^24). Signed with unsigned integers merge only when the
signed type is strictly wider (Int16 with Uint8 is Int16; Int8 with Uint8, or Int32 with Uint32,
is `INVALID_ARGUMENT`). An input with no points is ignored when the type is chosen, so an empty
Int8 column does not block a Uint16 one; a column only an empty input has keeps its type.
Coordinates must already share one frame.

### Classify

```js
import { classifyPoints, ASPRS_CLASSES } from "las-laz-js";

var r = classifyPoints(pts, wanted, 2);                           // only points still 0 or 1 become ground
r.columns; r.changed;                                             // the columns (a new classification array), points changed
var noise = classifyPoints(pts, stray, 7, { overwrite: true });   // every selected point, whatever its class
var fix = classifyPoints(pts, wanted, 2, { only: [7, 18] });      // only selected noise points
ASPRS_CLASSES[2];                                                 // "Ground" (codes 0-22, LAS 1.4 R15)
```

A point that already has a class keeps it by default: only points at 0 (created, never
classified) or 1 (unclassified) change. `overwrite: true` changes every selected point; `only`
lists the classes that may change (not with `overwrite`). `changed` counts points whose class
actually changed. The copy shares every other column with the input and drops a `readPoints`
result's `stats` (its class counts would be stale); `inPlace: true` overwrites the input's
`classification` array instead and keeps its `stats.classCounts` true. `overwrite` and `inPlace`
must be `true` or `false`, so a stray string such as `"false"` is refused, never taken as true. Codes 23–63 are reserved and 64–255 are yours: name
them with the writer's `classNames` and other LAS tools show the names. Point formats 0–5 hold
only classes 0–31 (see Writing).

### Transform

```js
import { makeTransform, transformPoints } from "las-laz-js";

// p' = scale · R · (p − about) + about + shift; rotateZ is degrees anticlockwise about +Z
var T = makeTransform({ rotateZ: 90, about: [477050, 6770015, 0], shift: [10, 0, 0] });
// T = { m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [7247075, 6292965, 0] }   row-major: p' = m·p + t

var moved = transformPoints(pts, T);                     // { count, columns }: new x, y, z; the rest shared
var same  = transformPoints(pts, T, { inPlace: true });  // the same x, y, z arrays, overwritten

var local = await las.readPoints({                       // or while reading
	fields: ["x", "y", "z"], transform: T,
	localOrigin: { x: 477050, y: 6770015 }, float32: true
});
```

A transform is a plain object, `{ m, t }`, with `m` nine numbers (a row-major 3×3) and `t` three.
Any affine map fits, so a fitted registration (`fitTransform`, `alignCloud`, see Register) can be passed the same way; it is not Three.js's
column-major `Matrix4`. `makeTransform` takes `shift`, `about`, `scale` and either `rotateZ` or
`rotate` (a row-major 3×3; not both). `transformPoints` needs `x`, `y` and `z`, computes in
Float64 and stores in the columns' own types. It returns a new `{ count, columns }` object either
way: with `inPlace` the arrays in it are the input's, overwritten (and `x`, `y` and `z` must not
share memory, or it throws `INVALID_ARGUMENT`). On read, the order is the one
above.

### Interleave for a renderer

```js
import { interleavePositions } from "las-laz-js";

var positions = interleavePositions(pts, { origin: { x: 477000, y: 6770000 } });   // Float32Array, x y z per point
geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

// or into a buffer you own, starting at point 'at'; layout "xy" writes two values per point
interleavePositions(pts, { into: buffer, at: 50000, layout: "xyz", origin: { x: 477000, y: 6770000, z: 300 } });
```

The origin is subtracted in Float64 before storing, so world coordinates keep their decimals in a
Float32 buffer; an axis left out of `origin` is not shifted ({ x, y } keeps world Z). `float32`
defaults to true and picks the type of a new array; `into` must be a Float32Array or Float64Array
long enough, else `INVALID_ARGUMENT`.

### Sparse points (dust)

```js
import { selectSparse, removePoints } from "las-laz-js";

var dust  = selectSparse(pts, { radius: 2 });   // fewer than 1 other point within 2 m
var clean = removePoints(pts, dust);
var lone  = selectSparse(pts, { radius: 0.5, minNeighbours: 4, xy: true });   // counted in 2D
```

A point is sparse when fewer than `minNeighbours` (default 1) **other** points lie within
`radius` of it, inclusive; `radius` is required, in the columns' units. The result is a selection,
so it can be shown before anything is deleted. `minNeighbours: 1` keeps any point with a single
neighbour inside the radius, so thin sparse features — a line of points down a scanned blasthole —
survive; dust that clumps survives too. A higher `minNeighbours` removes small clumps, at the
cost of thin features. It works on columns in memory (x / y / z, or a k = 3 `positions`): 34 million
points take about 2 s in Node. With PDAL's `filters.outlier` (`method=radius`), `min_k` is the same
as `minNeighbours`, but PDAL does not count a point exactly `radius` away.

### Denoise

```js
import { selectOutliers, removePoints, estimateNoise, denoisePoints, pointNormals } from "las-laz-js";

var strays = selectOutliers(pts);                       // PDAL's statistical rule: k 8, multiplier 2
var kept   = removePoints(pts, strays);
var noise  = estimateNoise(kept, { maxDistance: 0.3 }); // e.g. 0.006: 6 mm of fuzz
var smooth = denoisePoints(kept, { maxDistance: 0.3 }); // bilateral; { method: "mls" } for the plane fit
var { normal, residual } = pointNormals(smooth, { maxDistance: 0.3 });   // unit normals, local roughness
```

A handheld scan reads a flat bench as a band centimetres thick. Remove the stray points first
(`selectOutliers`), so they cannot pull the surface, then smooth what is left (`denoisePoints`).
- **`selectOutliers(cols, { k = 8, multiplier = 2 })`** — each point's mean distance to its k
  nearest other points; a point is selected when that mean is above the cloud's average of those
  means plus `multiplier` standard deviations. It is PDAL's `filters.outlier` `method=statistical`
  and selects the same points. It compares every point with one threshold for the whole cloud, so it
  suits clouds of even density (aerial, static tripod). On a handheld scan, whose density falls far
  from the walk path, it selects the sparse surface instead of strays: on a 1 M-point scan every point
  it selected came from the sparsest tenth. Use `selectSparse` (a fixed radius) for dust there.
- **`denoisePoints(cols, { method, k = 16, maxDistance, sigma, iterations = 1, normals, inPlace })`**
  moves each point against its neighbours — the other points among its k nearest within
  `maxDistance` (required: about 0.2–0.5 m for a handheld scan; a point with fewer than 5 stays
  put). `"bilateral"` (the default) moves a point along its normal by the weighted height of its
  neighbours above its plane, and nearly ignores points far off that plane, so a crest or a toe
  stays sharp. `"mls"` moves it onto the plane fitted to its neighbours: a little smoother, and
  it rounds edges and the top of a cone. `sigma` is the noise level in metres; omitted, it is
  measured (`estimateNoise`). More `iterations`, or a larger `k`, smooth more. The result is
  as `transformPoints` returns: new x, y, z (or `positions`) of the input's types, every other
  column shared; `normals: true` adds a `normal` column.
- **`pointNormals`** gives each point the unit normal of the plane through it and its neighbours
  (pointing up) and the residual, the RMS distance of those points from the plane: a roughness
  map. Fewer than 3 neighbours, or points all on one line: normal (0, 0, 0), residual NaN.
  `start` / `end` fit only points `start` … `end − 1` (their neighbours still come from the whole
  cloud), so the result is that slice of a full run, bit for bit: split a big cloud across
  workers, each with the whole cloud and its own range, and join the slices.
  **`estimateNoise`** is the median residual over up to 100,000 points spread through the cloud.

On a 1 M-point handheld scan (Node, one thread): `selectOutliers` 2.5 s, `estimateNoise` 0.7 s,
`pointNormals` 4.6 s, `denoisePoints` 6.3 s, taking the measured noise from 0.60 cm to 0.11 cm. On a
34 M-point scan: 2.1 min, 14 s, 3.2 min and 3.7 min (about 6.5 µs a point), noise 0.74 cm to 0.58 cm.
The searches run on a k-d tree (about 4.6 bytes a point); an output's coordinates cost what the
input's do. The calls are synchronous; for a big scan, run them in a Worker and pass
`onProgress(done, total)`.

### Neighbour index

```js
import { buildIndex, nearestPoint, nearestPoints, pointsInRadius, pointsNearRay } from "las-laz-js";

var index = buildIndex(pts);                              // or { cellSize: 0.5 }; omitted: ~16 points a cell
var i     = nearestPoint(index, [x, y, z]);               // point number, or -1
var j     = nearestPoint(index, [x, y], { xy: true, maxDistance: 0.3 });   // nearest in plan, within 0.3
var near  = pointsInRadius(index, [x, y, z], 5);          // a selection
var knn   = nearestPoints(index, [x, y, z], 8);           // { points, d }: the 8 nearest, nearest first
var hit   = pointsNearRay(index, origin, direction, { radius: 0.2, growth: 0 });
// hit = { points, t, d }: every point within radius + growth · t of the ray, t along it, d from its axis
```

A sorted voxel grid on flat typed arrays, 6 to 8 bytes a point (34 million points build in about
1 s). Results are exact — every candidate is distance-checked in Float64 — "within" is inclusive,
and ties go to the lowest point number. `pointsNearRay` is a cylinder for `growth: 0` (an
orthographic camera's pick ray) and a cone for `growth > 0` (a perspective camera's, `growth` the
tangent of the half-angle); points behind `origin` are left out, and choosing a snap point from `t`
and `d` is the caller's. The index refers to the coordinate arrays, it does not copy them: rebuild
it after any keep, remove, merge or transform — after an `inPlace` edit an old index would read
overwritten memory, and queries cannot tell.

### Dedupe with an index map

```js
import { dedupeSelection } from "las-laz-js";

var { keep, map } = dedupeSelection(pts, 0.01);   // { z: true } for 3D
var unique = keepPoints(pts, keep);               // what dedupe(pts, 0.01) returns
// map[i]: where input point i went in unique — a dropped point maps to its nearest kept point
```

## Register

Put a raw scan onto the mine grid, or onto another cloud, and see how well it fits. The result is
always a transform `{ m, t }` (world to world), so `transformPoints` or a read's `transform`
option applies it.

### Control points

```js
import { parseControlPoints, matchControlPoints, fitTransform } from "las-laz-js";

var grid = parseControlPoints(await surveyFile.text());   // Name,E,N,RL (or X,Y,Z; header optional)
var scan = parseControlPoints(await targetsFile.text());  // the same names, in the scan's frame
var pairs = matchControlPoints(scan, grid);               // { names, from, to, unmatchedScan, unmatchedGrid }
var f = fitTransform(pairs.from, pairs.to, { model: "rigid" });
f.transform;                      // { m, t }
f.residuals; f.dH; f.dZ;          // each pair's 3D, horizontal and vertical misfit
f.looResiduals; f.worst;          // each pair's residual under the fit made WITHOUT it; the worst pair
f.rms;
```

`model` is `"rigid"` (rotate and shift, the default; 3 or more pairs not on one line),
`"level"` (rotate about Z and shift, for a scan levelled by its IMU; 2 or more pairs at different
XY) or `"scale"` (rigid plus one uniform scale; 3 or more pairs). The fits are closed form
(Horn's quaternion method; the level fit exactly in 2D), on Float64 offsets from each set's
centroid, so a scan near 0,0 and a grid at UTM magnitude lose nothing. `weights` (one per pair,
0 leaves a pair out but still reports it) are optional. A bad control point pulls the fit toward
itself, so its own residual can look fine: `looResiduals` shows it, and `worst` names it.
`looResiduals` is NaN at the model's minimum number of pairs.

`parseControlPoints` reads tab, comma, semicolon or space separated rows of name, x, y, z (a tab
file splits on tabs only, so names may hold spaces, as Excel's tab-delimited export writes them);
a header picks the columns (name / id / point / station, x / e / east / easting, y / n / north /
northing, z / rl / elev / h / height), or `columns: { name, x, y, z }` names them. A BOM, CRLF,
blank lines, `#` comments, double-quoted names and an optional last column left blank on some rows
are accepted. A row with more fields than the first is refused, as is (without a header) a 1–3
digit field followed by a 3-digit one, so a thousands separator (`478,000.1`) is refused, naming
the line, never read as two numbers. Names match exactly after trimming, case-sensitive.

### Align to a cloud

```js
import { alignCloud } from "las-laz-js";

var a = alignCloud(scan, reference, {
	pairs: { from: picksOnScan, to: picksOnReference },   // world coordinates, x, y, z per pick
	model: "rigid",
	movingOrigin: [478000, 6772000, 0], fixedOrigin: [478000, 6772000, 0],   // for localOrigin columns
	icp: { maxDistance: 0.5 }                             // iterations 30, sample 50000, k 16
});
a.transform;   // world to world
a.fit;         // fitTransform's result for the picks
a.icp;         // { iterations, converged, rmsBefore, rmsAfter, used, sampled, constrained }
```

Without `icp` it is `fitTransform` on the picks. With it, point-to-plane ICP refines the fit on an
even sample of the scan: each sample point pairs with its nearest reference point within
`maxDistance`, whose plane is fitted from its `k` nearest; the increment is rigid (about Z only
for `"level"`, and `"scale"` keeps the picks' scale). A direction the geometry barely pins is not
moved: a flat floor pins only height and tilt, a straight bench everything but the shift along
strike, so those stay where the picks put them instead of drifting on noise; `constrained` says
how many of the 6 (4 for level) were pinned. Pick three or more points well apart; ICP
then needs the picks within about `maxDistance` of right, and `maxDistance` must be larger than
the reference's point spacing (a sparse cloud with a small `maxDistance` finds few pairs: `used`
says how many). `converged: false` means it stopped at `iterations` still moving by more than
1e-7 rad or 1e-6 × `maxDistance` (on a noisy scan it creeps along the noise for a while, and the
result is usually already final), or that too few pairs were found (`used`), when it keeps the
last transform. It never throws for a poor overlap.

A check on real scans with a known answer (`_dev/benchRegister.mjs`): the scan's odd points,
moved by a known rigid transform (37.3° about Z, a 0.3° tilt, a 2.6 km shift), stand in for the
reference; its even points are placed by six control points with 2 cm of picking noise, then ICP
(`maxDistance` 0.3 m). The error is the largest over the whole scan against the known transform.

| Scan (Node) | Points | Control points only | With ICP | ICP time (tree build included) |
|---|---|---|---|---|
| Handheld | 1 M | 75.8 mm | 4.6 mm | 1.8 s |
| Handheld | 34 M | 32.6 mm | 1.6 mm | 9.9 s |
| Sparse (about 2.7 m spacing) | 79 k | 33.6 mm | 19.3 mm (`maxDistance` 5 m) | 0.3 s |

This checks the method on real geometry and noise; a field check (surveyed targets on a raw scan)
is still to come.

### In the demo

The Register tab does both. **Align to a cloud**: open a reference cloud, pick pairs (a point on
your cloud, then the same point on the reference), Fit (with ICP if ticked), Apply. **GCP**: open the
grid control file, then the scan's target file or pick targets on the cloud and name them. Both
show each pair's residuals, the left-out residual and the worst pair, preview the fit before Apply,
undo it, and copy the transform as JSON. Apply moves the cloud to a new local origin, so a scan
moved kilometres onto the grid keeps its millimetres. The reference is read about its own centre
and, when it lies more than 10 km from your cloud (a raw scan near 0,0 against a scan on the grid),
is drawn shifted over it so both can be picked; the picks keep its true coordinates. A click picks
the surface in front, from every point drawn.

## Facets

Split a scan into **facets**, flat patches, and group them into **joint sets** (Kirra #127), as
CloudCompare's Facets tool does, with no dependencies.

```js
import { findFacets, jointSets, orientationOf } from "las-laz-js";

var f = findFacets(pts, { maxDistance: 0.3 });   // the wall region's points (a selection), any frame
f.facet;     // Uint32Array per point: its facet (1 … n, largest first), 0 = none
f.facets;    // [{ id, count, normal, centroid, dip, dipDirection, area, rms, outline }]
f.planeDistance;

var j = jointSets(f.facets);                     // automatic; or { count: 3 }, or { windows: [{ dip, dipDirection, angle }] }
j.families;  // [{ id, normal, dip, dipDirection, fisherK, cone95, facets, area }], by area
j.family;    // per facet: its set, 0 = none
j.pointFamily(f.facet);   // per point
```

**Orientation** is Kirra's: dip 0–90 (90 vertical); dip direction a bearing, degrees clockwise
from north (+Y), east (+X) = 90; x east, y north, z up. `orientationOf(normal)`,
`poleFromOrientation(dip, dipDirection)` and `poleOf(normal)` convert (a pole is the normal
pointing up).

**`findFacets`** grows facets from the flattest points (lowest plane-fit residual, 0.7.0's
`pointNormals`) through each point's k nearest within `maxDistance`: a neighbour joins when its
normal is within `maxAngle` (default 10°) of the facet's and it lies within `planeDistance`
(default 3 × the measured noise) of the facet's plane, the plane refitted as the facet grows.
Facets under `minArea` (default 1, square units) or `minPoints` (20) are dropped. `area` is the
facet's filled cells on an in-plane grid (`outlineCell`, default 2 × its point spacing), so it
does not depend on point density; `outline` is the outer edge of its largest patch, a closed
polygon on its plane (x, y, z per vertex, anticlockwise seen from the pole; holes not traced);
`rms` is its points' distance from the plane. Pass `normals` (from `pointNormals` with the same
`k` and `maxDistance`) to try other tolerances without recomputing them.

**`jointSets`** treats poles as axes (a pole and its opposite are one set) weighted by area. The
automatic mode finds the density peaks by mean-shift with a window of `maxAngle` (default 15°) and
keeps those gathering `minFacets` (3); each facet joins the nearest set within `maxAngle`, else 0.
The window should be about 2.5 × a set's spread (1/√K radians): 15° suits sets with K of about
100 or more; broader sets need a wider window. `count` keeps that many sets (spherical k-means,
every facet in one); `windows` are your own sets, kept in your order. Per set: the mean pole, Fisher
K = (N − 1) / (N − R) and the 95 % cone (NaN under 2 facets), the facet count and the area.

**Tuning for real rock.** The defaults suit smooth, clean planes. A blasted or weathered wall is
rough at the scale of centimetres, so with them facets stop growing at the first bump and stay
small and few. On a handheld pit-wall scan (tens of millions of points) these worked well:
`maxDistance` 0.6 (normals fitted over joint-face-sized patches), `maxAngle` 20–30,
`planeDistance` 2–3 (large: the normal test does the work), `minArea` 0.5, giving 7,000–18,000
facets and 6–13 joint sets; `jointSets` with `maxAngle` 15 separated the steep sets. A large
`maxDistance` is slower (normals take longer). On a scan whose lines are farther apart than its
points along a line (a tripod scan at a grazing angle), the default `outlineCell` (2 x the spacing
along a line) leaves empty rows between the lines, so `area` and `outline` shrink to strips: set
`outlineCell` above the line spacing. Joint **traces** (where a joint cuts the face, a line
not a face) are not facets; tracing them is later work.

On synthetic walls (9 planes in 3 sets, 5 mm noise) every plane comes back as one facet with its
dip and dip direction within 0.1° and its area within 2 %; joint sets from Fisher-distributed
poles come back within 2° and K within 25 %.

**Speed:** growth costs about as much as `pointNormals` (0.7.0); each point is visited at most
about three times, so rough ground does not regrow (a speck under `minPoints` is dropped for
good; a point dropped twice stays out). A 2.4 M-point wall region: normals 14 s, facets 15–60 s
depending on the tolerances (Node).

### In the demo

The Facets tab runs both on the selection (a polygon round the wall) or the whole cloud: colour by
facet or joint set (points in no set grey), outlines on the cloud, the sets table with **Select**
(the set's points become the selection, to Classify or delete), an equal-area stereonet, a hover
readout, and downloads: facets CSV, sets CSV, and **Facets DXF** (each outline a closed 3D polyline,
a layer per set, world coordinates: the facets as surfaces for CAD or Kirra).

## Fragments

Split a muckpile scan into **fragments**, the rocks, and turn them into a **size distribution**:
% passing by size, P-values and a fitted Swebrec or Rosin–Rammler curve, with no dependencies.

```js
import { findFragments, sizeDistribution } from "las-laz-js";

var fr = findFragments(pts, { maxDistance: 0.06 });   // the pile's points (a selection), any frame
fr.fragment;        // Uint32Array per point: its fragment (1 … n, largest first), 0 = none
fr.fragments;       // [{ id, count, centroid, normal, axes: [a, b, c], size, area, outline, facets }]
fr.surfaceArea;     // the scan's area
fr.unassignedArea;  // the part in no fragment

var psd = sizeDistribution(fr.fragments);              // by volume, Swebrec fitted from 60 % passing
psd.size, psd.passing;   // the measured curve, sizes ascending
psd.sizeAt(80);          // P80
psd.p;                   // { 10, 20, 50, 80, 90: { size, extrapolated } }
psd.fit;                 // { model, x50, xmax, b, rmse, from, range, passing(x), sizeAt(P) } or null
```

**`findFragments`** runs `findFacets` at rock-face settings (`maxAngle` 20, `minArea` 0,
`minPoints` 10; override with `facetOptions`), so each face of a rock is a facet, then joins the
facets of one rock. Where two facets touch, each boundary pair of points votes: a ridge (convex)
says one rock, a valley (concave) says two. Two facets within `concaveAngle` (default 10°) of each
other on one plane are one face; parallel but offset is a step, a rock on a rock. Merges go
strongest first and only while the fragment stays convex, so rough ground does not chain into
one huge fragment. Each facet's outward side comes from the pile's own direction, a coarse grid
of `surfaceDistance` (default a quarter of the cloud's longest side); give `viewpoint` (the
scanner, or any point on the open side) for a drawpoint or a steep face. A point in no facet
joins the nearest fragment within `fillDistance` (default `maxDistance`), one hop only, so fines
between rocks stay out. Fragments under `minPoints` (50) are dropped. `axes` are the 2nd–98th
percentile spans along the fragment's principal axes, longest first; `size` is b, the
intermediate one, the sieve-size estimate.

**`sizeDistribution`** weighs each fragment by `volume` ((π/6)·a·b², the unseen depth taken as b;
the default), `area` or `count`. The fit uses only the coarse part, from `fitFrom` (default 60 %)
up, where a scan's sizes hold; P-values below the measured curve come from the fit and are
marked `extrapolated`. `fines` (a share of the whole mass) adds a bin under the smallest fragment;
`unassignedArea / surfaceArea` is a start for it, not applied by itself, as a scan cannot see how
deep fines go. `model: "rosin-rammler"` fits Rosin–Rammler instead.

**What a scan can and cannot see.** Only the visible surface is measured: c is the depth of the
shell the scan saw, not the rock's, which is why `size` is b. Fragments under a few point spacings
are not resolved. Anything flat at the facets' scale is a facet like a rock face: a bench floor or
a wall in the run comes back as one big fragment and swamps a volume-weighted curve (keep the run
to the pile; the demo warns when one fragment covers a quarter of the surface), and pebbly fines
come back as pebble-sized fragments at the fine end. Two rocks pressed flush whose tops form one
convex surface merge, as they would for any method without a crack to go on.

On a synthetic pile (boxes of known size on pebbly fines, 5 mm noise at 2 cm spacing) 93 % of the
boxes come back as one fragment each with `size` within 10 % of what was visible, and P50 and P80
within 3 % and 7 %. At SLAM-like noise (2 cm at 4 cm spacing) that falls to about 70 % of boxes:
faces split more. No real muckpile scan has been checked yet.

**Speed:** about 6–11 s a million points in Node (`findFacets` most of it), and about 80–110
bytes a point beyond the columns.

### In the demo

The Fragments tab runs on the selection (a polygon round the pile) or the whole cloud, the
camera's position as the viewpoint: colour by fragment, outlines on the cloud, a hover readout
(fragment, size, axes), **Select fragment** (the one last hovered) and **Select oversize** (the
fragments above a size become the selection, to delete or Classify), the floor warning, the size
curve (model, weight, fit from, fines) with its P-values, and downloads: fragments CSV, curve CSV
and **Fragments DXF** (each outline a closed 3D polyline). Save with facet / set / fragment
writes the `fragment` extra-bytes field.

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

**Speed.** LAZ chunks are independent, so they are decoded on a pool of workers — browser
`Worker`s or Node `worker_threads`, one fewer than the cores (at most 16) — while the next window
is already decoding. A 10-million-point LAZ reads in about 0.6 s on a 24-core machine (about 4 s
on one core). Files under four chunks (200,000 points) stay on one thread, where starting workers
would cost more than it saves. `openLas(file, { threads: 1 })` decodes on the calling thread;
`threads: n` asks for n workers. If workers cannot start, it falls back to one thread.

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

## Tiles and level of detail

For clouds bigger than a GPU (or a tab) holds. `buildTiles` splits a LAS / LAZ file into an
octree of tiles kept in binary scratch; `selectTiles` picks the ones a camera needs within a point
budget; each tile loads as point columns. The library draws nothing: rendering stays with you.

```js
import { openLas, buildTiles, openTiles, selectTiles } from "las-laz-js";

// in a Worker (OPFS writes need one)
var store = await buildTiles(await openLas(file), { where: { opfs: "scan-123" }, compress: true, onProgress });
// later, after a reload: no rebuild
var store = await openTiles({ opfs: "scan-123" });
await store.matches(file);              // true when built from this file

// every frame, on the main thread, from the manifest the Worker posts
var pick = selectTiles(store.manifest, { viewProjection, width, height, pointBudget: 20e6, localOrigin });
// -> [{ key, depth, count, box }], most important first, a tile's parent always before it
var keys = pick.map(function (n) { return n.key; });
for await (var t of store.readTiles(keys, { fields: ["x", "y", "z", "red", "green", "blue"], localOrigin, float32: true })) {
	draw(t.key, t.points);
}
```

- **Where:** `{ memory: true }` (gone with the page), `{ opfs: id }` (an OPFS folder
  `las-tiles/<id>`, kept until removed; `listTiles()` lists them, `removeTiles(where)` removes one),
  or `{ dir: path }` in Node.
- **The octree is additive** (as Potree's): each tile holds an even sample of its box, one point
  per cell of a 128³ grid (the one nearest the cell centre), and its children hold the rest. Every
  point is stored once, so loading deeper tiles adds detail without repeating points. On a surface,
  as scans are, that is about 16,000 points a tile; a sparse cloud's root holds most of it.
- **A tile is the file's own LAS records** (optionally one LAZ chunk each, `compress: true`), so
  every field and extra byte is kept.
- **The build** streams the file and never holds the cloud: it counts points in a grid, cuts the
  cloud into chunks of `chunkPoints`, appends each record to its chunk, then builds each chunk's
  octree on the worker pool. A grid cell still holding more than `chunkPoints` (one stray point far
  off stretches the grid; so does a dense spot by a scanner) is counted again on a finer grid below
  it, one more read each time, so no chunk is over `chunkPoints` unless its points cannot be split. Measured in Node: the peak stays about the same from 2 to
  16 million points (about 95 MB on one thread, about 280 MB with two workers, most of it the
  workers' own heaps); a 10-million-point LAZ builds in about 4 s on the worker pool (5 s
  compressed). In Chrome, a 34-million-point LAS (1.16 GB) builds into 2,634 compressed tiles
  (113 MB of OPFS) in about 37 s; reopened after a reload, its first tiles draw in about 0.6 s.
  The same file and options give the same store, byte for byte, whatever `threads` is.
- **`selectTiles`** works on the manifest alone (plain JSON), so it runs every frame on the main
  thread. `viewProjection` is Three.js's `camera.projectionMatrix × camera.matrixWorldInverse`
  (16 numbers, column-major), in world coordinates minus `localOrigin`. A tile's size on screen is
  measured by projecting its box's corners, so orthographic and perspective cameras both work.
  Tiles outside the view are skipped with everything under them; the largest on screen come
  first; a tile's children are considered once it covers `minPixels`. Each manifest is prepared
  once and cached by the object (under half a millisecond a frame on 2,634 tiles in Chrome; about
  2 ms for 10,000 picked of 16,000), so never edit a manifest in place: the store and the Worker
  hand out a new one on every change.
- **Reopen:** the store's manifest is written in two alternating copies, so a crash mid-write
  leaves the previous one; the store records the source's name, size, date and a hash of its
  first 4 KB (`store.matches(file)`).

| Option | Default | Meaning |
|---|---|---|
| `where` | required | `{ memory: true }`, `{ opfs: id }` or `{ dir: path }` |
| `compress` | `false` | each tile one LAZ chunk (point formats 0–3 and 6–8) |
| `tilePoints` | `50000` | a tile splits while it holds more |
| `chunkPoints` | `2000000` | points per build chunk: the build's memory |
| `threads` | automatic | workers for the chunk octrees and compression; `1`: this thread |
| `replace` | `false` | rebuild over an existing store |
| `pointBudget` | `10000000` | `selectTiles`: the most points to return |
| `minPixels` | `100` | `selectTiles`: a tile smaller on screen is not opened further |

### Editing tiles

```js
var sel = await store.selectBox({ minX, maxX, minY, maxY });      // also selectPolygon, selectClasses
var sel = await store.select(function (cols, tile) { return selectPolygon(cols, poly); }, { fields: ["x", "y"] });
await store.deletePoints(sel);                                     // or keepPoints
await store.setColumn(sel, "classification", 64);                  // a value, or { [key]: typed array }
await store.addColumn("facet", "i32", -1);                         // written back as extra bytes
await store.transform(T);                                          // makeTransform's { m, t }; no tile rewritten
await store.writeLas(sink, { compress: true });                    // tile by tile through createLasWriter
```

A selection is `{ deletes, count, tiles: { [key]: Uint32Array } }` (`combineTileSelections(a, b,
"union" | "intersect" | "subtract")`). A delete or keep moves points, so a selection made before
one is refused: select again. `setColumn` takes `classification`, `classificationFlags`,
`intensity`, `userData`, `pointSourceId`, `red`, `green`, `blue` or an added column; only that
field's bytes change, in every point format. Edits on one store run one at a time, in the order
asked. Each writes the tiles it changes as new files as it goes (one tile in memory at a time),
then the manifest, then removes the old files, so an edit cut short leaves the store as it was. A
store changed in another tab or worker since this one was opened refuses the edit (`BAD_STORE`):
open it again. A read that an edit on the same store overtakes reads the new tile.
`writeLas` writes the source's version, point format, scale, offset, CRS, class names and extra
bytes, plus the added columns; an unedited store gives back every source record byte for byte (in
tile order, not the file's). Undo is the caller's.

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
var laz = await writeLas(pts, { compress: true, pointFormat: 3 });   // LAZ

var w = await createLasWriter(sink, { version: "1.2", pointFormat: 3, scale, offset });
// sink: an OPFS writer from openScratchSyncWriter, a Node FileHandle, or any { write(bytes, position) }
await w.writePoints(batch1); await w.writePoints(batch2);
await w.close();   // patches the header totals
```

A version and point format that do not go together (format 6 in LAS 1.2) are refused, never
silently changed. Scale and offset are chosen from the bounds when not given. `crs.epsg`
writes a GeoKey record; `crs.wkt` a WKT record. Point formats 6–10 must carry WKT (LAS 1.4), so
an EPSG code alone is refused for them — the library has no projection database to turn a code
into WKT.

`classNames: { 64: "Bench face", 65: "Crest" }` writes the Classification Lookup VLR (codes
0–255, names of 1 to 15 printable ASCII characters, not all spaces); `openLas` reads it back as
`classNames`, keeping only names it could write again, so a file's names always survive a save.
Point formats 0–5 store a class in 5 bits, so a class above 31 there is refused, naming the
point (`point 4 has class 64; point formats 0-5 hold classes 0-31 — write point format 6 or
higher`); write point format 6, or 7 / 8 to keep RGB, in LAS 1.4.

| Option | Default | Meaning |
|---|---|---|
| `compress` | `false` | write LAZ (LASzip) instead of LAS: point formats 0–3 and 6–8; formats 4, 5, 9, 10 are refused (`UNSUPPORTED`) |
| `chunkSize` | `50000` | points per LAZ chunk, a whole number from 1 to 4294967294; ignored without `compress` |
| `threads` | automatic | workers that compress chunks: automatic by default (from 4 chunks up, at most 4 workers), `1` compresses on the calling thread, `n` asks for n workers; only with `compress` |

### Writing LAZ

`writeLas(pts, { compress: true })` and `createLasWriter(sink, { compress: true, ... })` write the
same records as the LAS writers, compressed `chunkSize` points at a time (LASzip's 50,000 by
default) behind a LASzip VLR, with the chunk table at the end of the point data. The layout and
the compressed bytes are those PDAL (LAZperf) writes: for the same points, version, format, scale
and offset, the point data is identical to PDAL's — with one exception: in formats 6–8 a GPS time
of −0 following +0 is coded as a change, so it reads back as −0 (lossless), where LAZperf compares
the doubles, finds them equal and writes no change. Point formats 0–3 are written point-wise
(LASzip item version 2), 6–8 layered (item version 3).

- **Speed.** Chunks are independent, so they compress on the same pool of workers that decode
  LAZ, and are written strictly in chunk order: the bytes are the same for any `threads`. Gains
  flatten after about four workers, so with `threads` automatic the writers use at most four (one
  fewer than the cores, if that is less): a 10-million-point format 3 file writes in about 1.7 s
  that way on a 24-core machine, 1.6 s with `threads: 16`, about 7 s on one thread. A write of
  under four chunks (200,000 points) stays on one thread, where workers would cost more than they
  save. If workers cannot start, it falls back to one thread.
- **Memory.** With workers, up to about 2 tasks of 4 chunks per worker are in flight at once —
  about 55 MB of records at the automatic four workers with 50,000-point format 3 chunks (about
  220 MB at `threads: 16`). That bound holds across awaited `writePoints` calls; calls made
  without waiting, or one huge batch, submit all at once. Pass a smaller `threads` or `chunkSize`
  to bound it further. A writer that is abandoned without `close()` keeps its workers in a
  browser until it is closed.
- **Errors.** A streaming LAZ writer stops for good at its first error — in a chunk, in a sink
  write or in `close()` — and `writePoints` and `close` keep rejecting with it. Start a new
  writer. After a successful `close()`, both reject (`ABORTED`, "the LAZ writer is closed").
- **Extra bytes** are compressed in LASzip's Byte (formats 0–3) or Byte14 (6–8) item: see Extra
  bytes, below.
- The streaming writer needs `scale` and `offset` up front, as for LAS.

## Extra bytes

A LAS record can be longer than its point format. The bytes past it are extra bytes, described by
the Extra Bytes VLR (LAS 1.4: one 192-byte descriptor a field, with a name, a type, an optional
scale and offset, a no-data value and the field's raw min and max). They are read into columns
and written from them, LAS and LAZ.

```js
var las = await openLas(file);
las.extraBytes;   // [{ name: "echo width", column: "echo width", type: "i16", k: 1, size: 2, at: 34,
                  //    scale: 0.01, offset: 0, noData: -32768, min: 12, max: 4000, description: "" }, …]
var p = await las.readPoints({ fields: ["x", "y", "z", "extra"] });   // "extra": every extra column
p["echo width"];  // Float64Array: raw × scale + offset; the no-data value is NaN

await writeLas(p, { version: "1.4", pointFormat: 6, extraBytes: las.extraBytes });   // keeps them all
await writeLas(cols, { version: "1.4", pointFormat: 6, extraBytes: [
	{ name: "facet", type: "u32", description: "las-laz-js findFacets" },
	{ name: "joint_set", type: "u16" },
	{ name: "height", type: "i16", scale: 0.01, offset: 300, noData: -32768 }
] });
```

**Reading.** Extra columns are read only when asked for, by `column` in `fields` or all of them
with `"extra"`; the default fields are unchanged. The same names work in `chunks`,
`readPointsToScratch` and the Worker.
- A field with neither scale nor offset comes back in its stored type (`Uint8Array` …
  `Float64Array`; the 64-bit integers as `BigUint64Array` / `BigInt64Array`), its no-data value
  as stored. A field with a scale or an offset comes back as `Float64Array`, raw × scale + offset,
  and the no-data value as NaN.
- The deprecated 2- and 3-value array types (11–30) come back with `k` 2 or 3 values a point,
  interleaved, as `positions` is.
- Undocumented bytes (past the descriptors, or every extra byte when there is no VLR) come back as
  one raw `Uint8Array` column, `extraBytes`, of `size` bytes a point. Nothing is lost.
- `noData`, `min` and `max` are raw values, as the LAS spec stores them; a 64-bit one past 2^53 is
  a BigInt.
- A name that is a standard field (`intensity`) or a reserved one (`count`, `positions`, `bounds`,
  `stats`, `colours`, `normal`, `extra`, `extraBytes`) is read as `intensity_extra`; a name used
  twice gets `_2`. `column` says where each went.
- A VLR that cannot be right (it describes more bytes than the records have, a reserved type, a
  length that is not whole descriptors, two of them) does not stop a read: all the extra bytes come
  back as `extraBytes`, and `las.extraBytesProblem` says why (null when the VLR is good).

**Writing.** `extraBytes` on `writeLas` and `createLasWriter`: per field a `name` (up to 32
characters, one byte each; it may be empty, or repeat another field's when the columns differ), a `type` (`"u8" "i8" "u16" "i16" "u32" "i32" "u64" "i64" "f32" "f64"`, the codes
1–10, or `"raw"` with a `size`), and optionally `column` (default the name), `scale`, `offset`,
`noData` (raw) and `description`. A reader's `extraBytes` can be passed back as they are.
- Values come from `points[column]`, which must be there (a standard field that is missing is
  still written as 0). With a scale or offset the writer quantises, raw = round((value − offset) /
  scale), and writes NaN as `noData`. Unscaled integers must be whole numbers in the type's range
  (BigInt or Number for 64-bit; a Number past 2^53 is refused, since it is not exact).
- The writer works out each field's raw min and max (no-data and NaN left out) and stores them.
- A refused value names the field and the point (`extra bytes field "v": point 2: 256 is outside
  u8's range (0 to 255)`); every value of a batch is checked before any byte is written, so a
  refused `writePoints` leaves the writer as it was (LAS and LAZ).
- The deprecated array types are read, not written: write 2 or 3 scalar fields instead.
- The VLR is written in any LAS version. It is defined in 1.4; LAStools and CloudCompare read it
  in 1.0–1.3 too, but PDAL writes extra bytes in 1.4 only, so write 1.4 for files that go to PDAL.
- Without `extraBytes`, the bytes written are as before.

The point data of a LAZ file with extra bytes is PDAL's, byte for byte (the test fixtures), and
PDAL reads the fields we write.

## In a Worker

```js
var worker = new Worker(new URL("las-laz-js/worker", import.meta.url), { type: "module" });
worker.postMessage({ id: 1, type: "open", payload: { blob: file } });
worker.postMessage({ id: 2, type: "chunks", payload: { fields: ["x", "y", "z"], colour: { by: "rgb" } } });
// replies: { id, type: "progress" | "chunk" | "result" | "error", ... }; buffers are transferred
```

The protocol is documented in `src/workers/workerProtocol.js` and can be driven directly with
`createWorkerHandler(post)`.

Tile stores: `buildTiles` (from the open file), `openTiles`, `readTiles` (streams
`{ type: "tile", key, points }`), `selectBox` / `selectPolygon` / `selectClasses`, `deletePoints`,
`keepPoints`, `setColumn`, `addColumn`, `removeColumn`, `transform`, `writeTiles` (to an OPFS
scratch file) and `closeTiles`; each change returns the manifest, for `selectTiles` on the main
thread.

**Bundlers.** The worker entry and the LAZ decode and encode workers are found through
`new Worker(new URL(..., import.meta.url))`, which Vite and webpack 5 follow. With Vite, keep the
package out of dependency pre-bundling (`optimizeDeps: { exclude: ["las-laz-js"] }`), so the
worker files stay next to the module that loads them.

## Errors

Every failure is a `LasError` with a stable `code` (`ERROR_CODES`) and, for byte-level problems,
the file `offset`: `NOT_LAS`, `UNSUPPORTED_VERSION`, `UNSUPPORTED`, `TRUNCATED`, `BAD_HEADER`,
`BAD_VLR`, `INVALID_ARGUMENT`, `ABORTED`, `TOO_MANY_POINTS`, `BAD_STORE` (a tile store with no
manifest, a missing or damaged tile file, a store changed in another tab or worker since it was
opened, or one being written there). A file shorter than its header
promises is `TRUNCATED`, never garbage points. (`COMPRESSED_LAZ` is kept for 0.1 callers but is no
longer thrown: LAZ is read.)

## Scope

Reprojection is out of scope (the coordinate system is reported, not changed). Waveform
formats 4, 5, 9 and 10 have their point fields read from LAS; the waveform data itself is not.
COPC, EPT and E57 are not read.

## Provenance

The LAS reader, writer and big-file handling come from [Kirra](https://kirra-design.com),
Brent Buffham's blast-design app, rewritten as a standalone library. The LAZ decoder and encoder in
`src/laz/` are a JavaScript translation of [laz-rs](https://github.com/laz-rs/laz-rs) by Thomas
Montaigu, itself a Rust port of [LASzip](https://laszip.org) by Martin Isenburg (rapidlasso).
It is checked against an independent implementation: the test fixtures were compressed by
[PDAL](https://pdal.io), every record must equal PDAL's own decompression, and what this
library compresses must equal PDAL's bytes and be read by PDAL.
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
`samples/paths.txt`; the sample tests compare each file with its own header, each LAZ with a
LAS twin (same count and bounds) field by field, and compress each file to LAZ and read it back.
Set `LAS_PDAL=<path to pdal>` to also have PDAL read what this library writes
(`test/laz/pdalWrite.test.js` and the sample tests).

## Licence

`MIT AND Apache-2.0`. The library is MIT © Brent Buffham (`LICENSE`). The LAZ decoder and encoder in
`src/laz/`, translated from laz-rs / LASzip, is under the Apache License 2.0 (`LICENSE-APACHE`,
`NOTICE`). Both are permissive: use, change and ship it in open or closed software, keeping the
notices.
