# Changelog

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
