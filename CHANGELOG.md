# Changelog

## 0.1.1 (2026-10-21)

Fixes from the 0.1.0 review. No breaking changes.

- `maxPoints` keeps exactly that many of the points that pass the filters, spread over the whole
  file. It used to keep only the start of a file, and with filters set could return nothing.
- Streamed chunks are coloured by one rule for the whole file, so windows no longer show seams
  (new `createChunkColourizer`; `colourize` gains `eightBit`).
- Opening a LAS 1.4 file no longer reads its EVLRs to the end of the file: a big EVLR has
  `bytes: null` until `readEvlrBytes(i)`. VLRs and EVLRs report `length`.
- Browser bundlers (esbuild, webpack, Vite) can bundle the package; the lazy Node import no
  longer stops them.
- `readPoints` and `writeLas` peak near the size of what they return (a 69 MB read peaked at
  233 MB, now 74 MB); Node files are read into one reused window buffer.
- `dedupe` is about 7 times faster.
- `createLasWriter` works with OPFS scratch writers and Node file handles, and with
  `writePoints` calls made without waiting.
- A custom `{ size, read }` source that returns a short read is `TRUNCATED`, never fewer points.
- Point formats 6–10 write their coordinate system as WKT, as LAS 1.4 requires; an EPSG code
  alone is refused for them.
- `strideFor` is deprecated (the reader no longer uses it) and goes in 0.2.0; `countKept` is new.
- Demo: bounds, dedupe, colour range, return and intensity histograms; safe on big files.

## 0.1.0 (2026-10-21)

First release: read and write ASPRS LAS.

- `openLas` reads the header, VLRs, EVLRs and coordinate system (GeoKeys / WKT) of LAS 1.0–1.4,
  from a File / Blob, ArrayBuffer, Uint8Array, Node path or any `{ size, read }` source.
- `readPoints` and `chunks` decode every point format (0–10) in windows of whole records, never
  holding the file whole; filters (classes, returns, bounds), even thinning (`maxPoints`),
  `dedupe`, `localOrigin` + `float32`, progress and abort.
- `readPointsToScratch` streams columns into OPFS scratch files.
- `colourize` by RGB (with 8-bit files detected), intensity, elevation or classification.
- `writeLas` and the streaming `createLasWriter` write LAS 1.0–1.4, formats 0–10, with EPSG or
  WKT coordinate systems.
- `las-laz-js/worker`: a module Worker with a documented message protocol.
- A Three.js demo.
- LAZ files open and report `compressed`; reading their points arrives in 0.2.0.
