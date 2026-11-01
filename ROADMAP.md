# Roadmap

Speed is a priority for this library (see the README). This is what is next, most valuable first within each part, with
the measurement or reason behind each. Nothing here is started unless it says so. Numbers are from this library on a 16-worker
machine unless noted; "30 M" figures are scaled from 1.5 to 10 M point runs.

## What is already here

- **Octree tile store** (`buildTiles`, `selectTiles`, `readTiles`): a cloud of any size split into an octree of tiles in memory,
  OPFS or a Node folder, with a level of detail picked by camera and point budget. It plays the part Potree's octree does, in
  this library's own format; it is not Potree's or COPC's file format.
- **k-d tree** (`src/index/kdtree.js`): balanced, implicit, exact k-nearest; behind `selectOutliers`, `pointNormals`, `denoisePoints`,
  `alignCloud`, `pointSpacing`, `findFacets`, `findFragments`.
- **Voxel grid index** (`buildIndex`, `pointsInRadius`, `nearestPoint`, `pointsNearRay`): a sorted voxel grid, 34 M points in about 1 s.
- **Worker pool** for LAZ decode and compress, tile builds, store edits and the `...Parallel` tools.

## Left over from 0.19.x

1. **`estimateNoise` and `pointSpacing` on every core.** They measure a sample (100,000 and 10,000 points) but build a k-d tree of the
   whole cloud first, one thread, about 7 s at 30 M. Do not build the tree over the cloud at all: build it (or use the grid)
   over only the cells around the sampled points, or cut the sample into tiles and run them on the pool as the other `...Parallel` tools do.
2. **`writeLas` workers.** The automatic LAZ pool is capped at 4 workers and starts at the 4th chunk. Size it from the cores and the
   memory in flight instead of a constant; an explicit `threads` already goes higher.
3. **`dedupeStore` and `selectOutliersStore` certainty.** `dedupeStore` trusts a 2-tolerance overlap; `dedupeParallel` proves its answer
   (the tiles' beliefs about seam points are checked against their owners, and a wrong tile is swept again). Give the store version the same
   check. `selectOutliersStore` could certify each core point's k nearest by its k-th distance against the tile's edge, and recompute only the
   ones that fail.
4. **`alignCloud` match step on the pool** (the 50,000-point sample per ICP iteration splits by range).

## Speed: the k-d tree and the indexes

5. **Spatial order for the query loops.** `selectOutliers`, `pointNormals` and `denoisePoints` query in the file's order. On a cloud stored in
   scan lines that is already local; on a shuffled or merged cloud every query is a cache miss (dedupe is 2 times slower shuffled).
   Sort the queries by Morton code once (a radix sort, O(n), parallel) and write the answers back by point number.
6. **A tree that builds in parallel.** The median-select k-d build is sequential (about 7 s at 30 M). Two cheaper ways: split the top levels
   here and build the subtrees on the pool; or build a linear BVH from a Morton sort (radix sort, no selection), which parallelizes and
   gives the spatial order of item 5 for free. Keep exact k-nearest.
7. **Grid for fixed-radius work.** `pointNormals`, `denoisePoints` and `selectSparse` ask for neighbours within `maxDistance`; a grid with
   cells of that size builds in about 1 s at 34 M against the k-d tree's 7 s at 30 M. Use the grid when the density is even enough to keep
   cells near k points, the k-d tree when it is not (a handheld scan).
8. **Persist an index with the tile.** `selectOutliersStore`, `roughnessStore` and the ghost tools rebuild a tree per tile on every run. Store
   the tile's Morton order (or tree) beside its points and read it back; the work-tile reads get cheaper too.
9. **Dedupe's cell table in cache-line blocks.** The sweep is memory-latency bound: one hash look-up a cell. Group the cells of a block (4 x 4
   in plan) into one 64-byte slot so a point's neighbours share a cache line. Measured headroom: the cell size alone gave 2 to 4 times.
10. **Float32 tile frames.** Inside a tile, coordinates relative to the tile's corner fit Float32 at a millimetre; half the memory traffic
    for the neighbour searches. Only where the result may differ in the last bit (not for the tools that promise the serial answer).

## Speed: moving less data

11. **Keep the pool alive between calls.** Every `...Parallel` call starts its workers, loses the JIT warm-up and ends them (tens of ms, and
    the first seconds of each run are cold). A shared pool with an idle timeout (`closeAfter: 30 s`) helps every interactive tool most.
12. **No copy of the columns into the workers.** Each tile's x, y, z are copied (24 bytes a point, in all about the size of the cloud again).
    Use `SharedArrayBuffer` columns where the page is cross-origin isolated (and always in Node), or transfer the caller's buffers when it
    says it is done with them (`transfer: true`).
13. **Fewer files for OPFS.** Creating a file costs about 2.2 ms whatever its size, and does not run in parallel; a 100 M point store is
    about 11,000 files. Pack the tiles of a generation into a few append-only pack files with offsets in the manifest: `cloneStore`,
    `buildTiles`, `mergeStores` and `listTiles` all pay per file today.
14. **Reuse buffers.** Tiles, records and results are allocated and dropped per tile; a small pool of typed arrays would cut garbage-collection
    pauses, which show as gaps in the progress bar.

## Speed: LAZ

15. **Decode only the layers asked for.** LAZ for point formats 6 to 8 (LASzip 3) stores each field group in its own stream; reading only
    x, y, z and classification need not decode intensity, colour or time. A large saving for the common select, crop and render reads of
    formats 6 to 8. (Formats 0 to 3 are one stream: no.)
16. **Optional WebAssembly for the arithmetic decoder and the k-nearest loop, behind a flag.** The library is pure JavaScript on purpose and stays
    so by default; measure a SIMD build before deciding, and keep the JavaScript path byte for byte the reference.
17. **Spatial order inside a tile before compressing.** LAZ compresses spatially coherent points better and decodes them faster; sort a
    tile's points by Morton code as the tile is built.

## Formats and streaming

18. **Read COPC.** A COPC file is a LAZ file with an octree hierarchy inside it, readable by range requests: a viewer or `selectTiles`-style
    pick could stream a big cloud over HTTP, or from disk, without building a tile store first. Read it into the same `selectTiles` /
    `readTiles` interface as a tile store.
19. **Write COPC and a Potree 2.0 octree** from a tile store (the store already holds the octree and a level of detail), so a cloud edited
    here opens in QGIS, PDAL and Potree viewers. EPT (Entwine) read after COPC.
20. **Columnar tiles.** A tile holds whole records, so a read of x, y, z decodes every field of a LAZ tile. A columnar tile (one block a field,
    x, y, z first) reads only what a select or a render needs; combined with item 15 it is the cheapest read of all.

## Method and tooling

21. **Benchmarks in the test run.** `_dev/bench*.mjs` exist but nothing compares them. Keep a baseline per tool (points a second on a fixed
    synthetic cloud, ordered and shuffled) and fail `npm run test:bench` on a loss of more than 20 %, so the rule in the README is checked.
22. **Parallel versions of what is left single-threaded** as it turns up: `findFacets` below Kirra's parallel threshold, `selectDoubleLayer` (0.4 s
    at 5 M, low), the gather in `dedupeParallel` (one column at a time).
