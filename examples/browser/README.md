# las-laz-js demo

A browser demo of the library: drop a LAS file and it is read in the library's own Worker
(`las-laz-js/worker`), a window of whole records at a time, and streamed into a Three.js
point-cloud viewer. The side panel drives the public API:

| Tab | Library calls |
|---|---|
| Header | `openLas` — version, point format, count, bounds, scale / offset, CRS, VLRs |
| Read | `readPoints` with classes, returns, bounds, max points, dedupe and window size |
| Edit | `selectPolygon`, `selectBox`, `selectClasses`, `unionSelections`; `keepPoints`, `removePoints`, `splitPoints`, `mergePoints`; `makeTransform`, `transformPoints`; `readPoints` with `polygon` (crop on read) |
| Colour | `colourize` — elevation, RGB, intensity, classification; ramp; point size |
| Stats | per-class counts, first returns, Z range |
| Write | `writeLas` to a new LAS or LAZ file (`compress`), read back with `openLas` to check the round trip |

On the Edit tab, **Draw** a polygon on the viewer (click to add vertices, a drag still orbits,
double-click to close), select inside it, in a box or by class (yellow), then keep, delete, split or
transform the points in memory, or read the file again cropped to the polygon. Every edit is a
copy, so **Reset** goes back to the last read; **Save** on the Write tab then writes the edited cloud.

Hover a point to see its coordinates, fields and record number in the file. Your file never leaves your browser.

Run it locally with `npm run demo` (http://localhost:8080/). Three.js 0.170.0 is loaded from a
CDN through an import map; the library itself has no dependencies.
