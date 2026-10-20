# las-laz-js Demo — Design Spec

- **Status:** awaiting Brent's review (2026-10-21)
- **Parent spec:** `2026-10-21-las-laz-js-design.md`
- Brent, 2026-10-21: *"the library needs a ThreeJS Demo. All Libraries need Demos."*

## 1. Intent

A browser demo: drop a LAS (later LAZ) file, see it as a **Three.js point cloud**, and drive
every public library function from a side panel. The file is read locally and never uploaded.

## 2. Ground rules (as ecw-js)

- Vanilla HTML, CSS, JS modules in `examples/browser/`; never in the npm package.
- Imports the library from `../../src/index.js`, so it always runs the current code.
- Three.js is the demo's only dependency, pinned (`three@0.170.0`) through an import map from a
  CDN; the library itself stays dependency-free.
- Heavy work in the library's own Worker (`las-laz-js/worker`), so multi-GB files keep the page
  responsive.
- Light and dark follow `prefers-color-scheme`.

## 3. Hosting

- Local: `npm run demo` → `_dev/serve.mjs` (zero-dependency static server, secure context for
  OPFS and Workers) on `http://localhost:8080/`.
- Public: GitHub Pages via `.github/workflows/pages.yml` on push to `main`.

## 4. Layout

The Three.js viewer fills the page (orbit, pan, zoom, fit to cloud); a collapsible panel on the
right with one tab per function group; a status bar with the progress bar and headline stats
(points read / total, file size, time, points per second).

## 5. Tabs

| Tab | Library calls | Shows |
|---|---|---|
| **Header** | `openLas` | Version, point format, count, bounds, scale / offset, software, date, CRS, VLR list |
| **Read** | `readPoints` / `chunks` | Fields, classes, returns, bounds, max points, dedupe; streams into the viewer chunk by chunk |
| **Colour** | `colourize` | RGB / intensity / elevation / classification, ramp, range; point size |
| **Stats** | `PointColumns.stats` | Class histogram, return counts, Z range, intensity histogram |
| **Write** | `writeLas` | Save the current selection as LAS (1.2 / 1.4, chosen format); round-trip check button |
| **About** | — | Provenance, licence, link to the npm page and spec |

## 6. Rendering

- `THREE.Points` with a `BufferGeometry` per chunk; positions as Float32 **after** subtracting
  the cloud's local origin (the library's `localOrigin` option) — no jitter at UTM.
- A draw cap (default 20 M points, adjustable) with a "showing N of M" note; above it the demo
  reads with `maxPoints`.
- Picking: hover shows the nearest point's fields.
