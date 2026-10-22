# las-laz-js demo

A browser demo of the library: drop a LAS file and it is read in the library's own Worker
(`las-laz-js/worker`), a window of whole records at a time, and streamed into a Three.js
point-cloud viewer. The side panel drives the public API:

| Tab | Library calls |
|---|---|
| Header | `openLas` — version, point format, count, bounds, scale / offset, CRS, VLRs |
| Read | `readPoints` with classes, returns, bounds, max points, dedupe and window size |
| Edit | `selectPolygon`, `selectBox`, `selectClasses`, `selectSparse`, `unionSelections`; `keepPoints`, `removePoints`, `splitPoints`, `mergePoints`; `makeTransform`, `transformPoints`; `readPoints` with `polygon` (crop on read) |
| Colour | `colourize` — elevation, RGB, intensity, classification; ramp; point size |
| Stats | per-class counts, first returns, Z range |
| Write | `writeLas` to a new LAS or LAZ file (`compress`), read back with `openLas` to check the round trip |

On the Edit tab, **Draw** a polygon on the viewer (click to add vertices, a drag still orbits,
double-click to close), select inside it, in a box, by class or the sparse points (dust: fewer than
the minimum neighbours within the radius) (yellow), then keep, delete, split or
transform the points in memory, or read the file again cropped to the polygon. Every edit is a
copy, so **Reset** goes back to the last read; **Save** on the Write tab then writes the edited cloud.

The viewer draws at most 20 million points. A bigger read stays whole in memory and is drawn as an
even spread over it; selections, edits and Save act on every point read, and the selection line says
how many of the selected points are on screen. Add `?drawCap=10000` to the URL to try this with a small file.

Hover a point to see its coordinates, fields and record number in the file. Your file never leaves your browser.

Run it locally with `npm run demo` (http://localhost:8080/). Three.js 0.170.0 is loaded from a
CDN through an import map; the library itself has no dependencies.
