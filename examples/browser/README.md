# las-laz-js demo

A browser demo of the library: drop a LAS file and it is read in the library's own Worker
(`las-laz-js/worker`), a window of whole records at a time, and streamed into a Three.js
point-cloud viewer. The side panel drives the public API:

| Tab | Library calls |
|---|---|
| Header | `openLas` — version, point format, count, bounds, scale / offset, CRS, VLRs |
| Read | `chunks` with classes, returns, max points and window size |
| Colour | `colourize` — elevation, RGB, intensity, classification; ramp; point size |
| Stats | per-class counts, first returns, Z range |
| Write | `writeLas` to a new file, read back with `openLas` to check the round trip |

Hover a point to see its coordinates and fields. Your file never leaves your browser.

Run it locally with `npm run demo` (http://localhost:8080/). Three.js 0.170.0 is loaded from a
CDN through an import map; the library itself has no dependencies.
