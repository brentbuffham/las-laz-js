# las-laz-js 0.9.2 — Extra bytes — Design Spec

- **Status:** section 1 (API) agreed in chat 2026-10-24; sections 4, 7 and 8 (demo, errors, testing)
  are new here; the whole spec awaits Brent's review
- **Author:** Brent Buffham (https://kirra-design.com), with Claude
- **Library spec:** `2026-10-21-las-laz-js-design.md` (roadmap: 0.9.2) · **Builds on:**
  `2026-10-23-facets-0.9.0-design.md`

## 1. Intent

A LAS point record can be longer than its point format: the bytes past the format are "extra
bytes", described by the Extra Bytes VLR (`LASF_Spec`, record 4: one 192-byte descriptor a
field). Today the reader skips them and the writers never write them, so a file read with extra
bytes loses them on save, and the 0.9.0 facet and joint-set columns cannot go back into a file.

Decisions (Brent, 2026-10-24):
- Ships as **0.9.2**, after the 0.9.1 normals range.
- **Read every type, write the scalars:** read types 1–10, the deprecated 2- and 3-value array
  types 11–30, and undocumented bytes; write types 1–10 and raw (undocumented) bytes.
- **Scaled fields come back as Float64:** a field with a scale or offset is read as
  raw × scale + offset, its no-data value as NaN. A field with neither keeps its stored type.

Success:
- Any file's extra bytes survive a read → save, LAS or LAZ, byte for byte where the type is
  writable.
- A caller writes its own columns (facet, joint set, echo width, …) as named, typed fields that
  PDAL, CloudCompare and LAStools read.
- Nothing changes for a caller who does not ask for extra bytes: the default fields and every
  existing file written are as in 0.9.1.

The LAS 1.4 R15 text (ASPRSorg/LAS `source/04_optional_vlrs.txt`, "Extra Bytes") fixes what the
spec here leans on: the 192-byte layout; `no_data`, `min` and `max` are **raw** stored values,
upcast to 8 bytes (u64 for unsigned, i64 for signed, double for floats); scale is applied before
offset; bits 0–4 of `options` mark no_data, min, max, scale and offset as set; data type 0 is
undocumented bytes with their count in `options`; bytes past the descriptors are undocumented;
a VLR that describes more bytes than each record has is invalid ("extra bytes mismatch");
only one Extra Bytes VLR may exist.

## 2. API

### Reading

```js
var las = await openLas(file);
las.extraBytes;   // [{ name, column, type, k, size, at, scale, offset, noData, min, max, description }]
var p = await las.readPoints({ fields: ["x", "y", "z", "facet", "joint_set"] });
var all = await las.readPoints({ fields: ["x", "y", "z", "extra"] });   // "extra": every extra column
```

- **`las.extraBytes`**, one entry per field, in record order:
  - `name`: as in the file (ASCII, up to 32 characters, trailing zeros dropped).
  - `column`: the column it is read into, `name` unless that clashes (below).
  - `type`: `"u8" "i8" "u16" "i16" "u32" "i32" "u64" "i64" "f32" "f64"`, or `"raw"`.
  - `k`: values a point, 1; 2 or 3 for the deprecated array types; for `"raw"`, its byte count.
  - `size`: bytes a point; `at`: the field's first byte in the record.
  - `scale`, `offset`, `noData`, `min`, `max`: numbers (arrays of k for the array types), or
    null when the descriptor does not set them. `noData`, `min` and `max` are raw values (the
    spec's rule); a u64 / i64 one past 2^53 is a BigInt.
  - `description`: as in the file.
  - `[]` when the record has no extra bytes.
- **Columns.** Unscaled fields come back in their stored type: `Uint8Array` … `Float64Array`,
  64-bit ones as `BigUint64Array` / `BigInt64Array`. A field with a scale or offset comes back as
  `Float64Array`, raw × scale + offset (scale 1 or offset 0 when only one is set), and a raw
  value equal to `noData` becomes NaN. An unscaled field keeps its no-data value as stored.
  Array types are k values a point, interleaved (length k × count), as `positions` is.
- **Undocumented bytes.** Bytes past the last descriptor, or every extra byte when there is no
  VLR, come back as one `"raw"` field, `column: "extraBytes"`, a `Uint8Array` of size bytes a
  point. A type-0 descriptor is a `"raw"` field under its own name (`"extraBytes"` when its name
  is empty). The undocumented field has `name: ""`. Nothing is lost.
- **Columns never clash.** A name equal to a standard field (`FIELD_TYPES`) or a reserved column
  (`count`, `positions`, `bounds`, `stats`, `colours`, `normal`, `extra`, `extraBytes`) is read
  as `<name>_extra`; a name already used in the file gets `_2`, `_3`, ….
- **A bad VLR never stops a read** (as `classNames`): an extra bytes mismatch, a reserved type
  (31–255), a length that is not a whole number of descriptors, or two Extra Bytes VLRs give one
  `"extraBytes"` raw field over all the extra bytes, and `las.extraBytesProblem` says why (null
  when the VLR is good). The VLR is looked for in the VLRs, then the EVLRs.
- **Field names.** `readPoints`, `chunks`, `readPointsToScratch` and the Worker take extra
  columns in `fields` by `column`, and `"extra"` for all of them. An unknown name is refused as
  today, the message listing the file's extra columns. **Default fields are unchanged**: extra
  columns are read only when asked for.
- `parseExtraBytes(vlrs, header)` (`src/format/ExtraBytes.js`, exported) does the parse;
  `decodeRecords(bytes, header, { extraBytes, fields })` takes its result.

### Writing

```js
await writeLas(p, { version: "1.4", pointFormat: 6, extraBytes: [
	{ name: "facet", type: "u32", description: "las-laz-js findFacets" },
	{ name: "joint_set", type: "u16", description: "las-laz-js jointSets" },
	{ name: "echo width", column: "echo", type: "i16", scale: 0.01, noData: -32768 }
] });
await writeLas(p, { extraBytes: las.extraBytes });   // read -> save keeps every writable field
```

- `extraBytes` on `writeLas` and `createLasWriter`, LAS and LAZ, any LAS version (the VLR is
  defined in 1.4; LAStools and CloudCompare read it in 1.0–1.3 too; PDAL writes extra bytes in
  1.4 only). Each descriptor:
  - `name` (ASCII, 1–32 characters; empty only for `"raw"`, written as undocumented bytes), `type` (`"u8"` … `"f64"` or the codes 1–10, or
    `"raw"` / 0), `column` (default `name`), `size` (bytes, `"raw"` only), `scale`, `offset`,
    `noData` (raw), `description` (ASCII, up to 32). Other properties (`at`, `min`, `max`, read
    from a file) are ignored, so the reader's list can be passed back as it is; `k` above 1 on a
    typed field (a deprecated array read from a file) is refused: read, not written.
  - A `"raw"` descriptor is written as type 0 with its size in `options` (the reader's
    undocumented field, `name: ""`, stays unnamed); one over 255 bytes is written as several type-0 descriptors of up
    to 255 (it reads back as `extraBytes`, `extraBytes_2`, …: the bytes are the same).
- **Values** come from `points[column]`, which must exist with length count × (1, or size for
  raw); a missing extra column is refused (a standard field missing is still written as 0).
  - Integer types, unscaled: whole numbers in the type's range (Number or BigInt for 64-bit;
    Numbers past 2^53 are refused).
  - With a scale or offset: raw = round((value − offset) / scale) for integer types,
    (value − offset) / scale for f32 / f64; NaN is written as `noData`, and refused when there
    is none.
  - f32 / f64 unscaled: stored as given (NaN included).
- **Min and max** are worked out by the writer over the raw values written (no-data and NaN
  left out) and stored with their bits set; a field with no such value stores none.
- **Record length** = the format's size + the extra fields' sizes; LAZ adds its Byte (formats
  0–3, version 2) or Byte14 (6–8, version 3) item, which the codec already has. The header and
  VLR sizes do not depend on the values, so the header is patched at the end as today.
- **Without `extraBytes`, the bytes written are the 0.9.1 bytes.**

## 3. Internals

- **`src/format/ExtraBytes.js`**: `parseExtraBytes(vlrs, header) -> { fields, problem }` and
  `buildExtraBytes(layout, ranges) -> Uint8Array` (the VLR payload, min / max from the writer).
  The `LasReader` sets `extraBytes` and `extraBytesProblem` from the parse.
- **Decode.** `resolveFields(header, fields, extra)` expands `"extra"` and accepts extra
  columns; `columnType` gives an extra column's type and k. Each extra column is read with a
  DataView getter at `at + j × elementSize`; scaled ones go through one multiply-add and a
  no-data compare. Raw columns copy their bytes. `readPoints` sizes and grows columns by k (a
  column is count × k long), so the in-place read and the doubling path both carry k > 1.
- **Encode.** `settle` turns `extraBytes` into a layout (`at`, element size, setter, range check,
  quantiser) and the record length; `encodeRecords` checks every extra value of a batch first
  (as it does classes above 31), so a refused batch leaves the totals untouched, then writes.
  `totals.extra` holds each field's raw min / max; `headerBytes` builds the VLR from them.
  `lazSetup` and both writers use the record length, not the format's size.
- **Worker.** `open` returns `extraBytes` and `extraBytesProblem`; columns transfer as today
  (BigInt arrays included).
- The column ops (`keepPoints` … `mergePoints`, `dedupe`, `transformPoints`) already carry any
  typed column of k values a point, so extra columns follow edits unchanged.

## 4. Demo

- **File tab:** an Extra bytes table under the VLRs: name (column when it differs), type,
  scale / offset, no-data, description; "none" when the file has none; the problem in red when
  the VLR is bad.
- **Read:** the cloud is read with `"extra"` too, so edits (Remove, Split, Classify, Register,
  Transform, Smooth) carry the extra columns. Hover shows the point's extra values.
- **Save, whole file:** streams `"extra"` and passes `info.extraBytes`, so every writable field
  survives; array-type fields (read, not written) are dropped and the result line says which.
- **Save, edited cloud:** writes the cloud's extra columns the same way.
- **Facets → Save with facet / set:** a checkbox in the Write panel, enabled once facets exist:
  the cloud as read is saved (as an edited save, with its Max-points note when the read was
  thinned) with two more fields, `facet` (u32, 0 none) and `joint_set` (u16, 0 none; only when
  sets were found). A file's own `facet` / `joint_set` fields are replaced by the new ones.

## 5. Files

- New: `src/format/ExtraBytes.js`; `test/format/extraBytes.test.js`; `test/read/extraBytes.test.js`;
  `test/write/extraBytes.test.js`; `test/pdal/extraBytes.test.js` (skipped without PDAL);
  `_dev/probeExtra.mjs` (which samples carry extra bytes).
- Changed: `src/read/decodeRecords.js`, `src/LasReader.js`, `src/write/writeLas.js`,
  `src/write/encodeRecords.js`, `src/workers/workerProtocol.js`, `src/index.js`;
  `test/write/writeLaz.test.js` (the f3x / f7x skip goes); `test/helpers/lazFixtureData.js`
  (fixture extra-byte columns); the demo (`demo.js`, `facets.js`, `index.html`); README,
  CHANGELOG, roadmap.

## 6. Speed and memory

- Reading costs nothing unless an extra column is asked for; each one asked for costs its column
  (size × count bytes, 8 a value when scaled) and one getter a value.
- Writing checks each extra value twice (check, then write); a write with no `extraBytes` runs
  the 0.9.1 path.

## 7. Errors

`INVALID_ARGUMENT`, naming the field (and the point, for a value):
- an unknown `type`; `size` missing or not 1–65535 on `"raw"`, or given on another type
- a name empty, over 32 characters or not ASCII; a description over 32 or not ASCII
- two descriptors with the same `name`, or the same `column`; a `column` equal to a standard field
  or reserved column (the message suggests `<name>_extra`)
- `scale` 0 or not finite; `offset` or `noData` not finite; `noData` outside the type's range
- the column missing, not a typed array or array, or of the wrong length
- a value not a whole number, outside the type's range after scaling, or NaN with no `noData`
- the record past 65,535 bytes
- reading: a field name that is neither standard nor one of the file's extra columns

Reading a bad VLR is not an error (section 2).

## 8. Testing (oracles, not snapshots)

- **Descriptor parse** on hand-built 192-byte descriptors (`test/helpers/buildLas.js`): every
  type 1–10 at its size and `at`; array types 11–30 (k and size); options bits; raw no_data /
  min / max upcast (u64, i64, double; a u64 past 2^53 as BigInt); type 0 with its count; bytes
  past the descriptors; no VLR; mismatch, reserved type, bad length and two VLRs → one raw
  field with the problem named; names clashing with a standard field and with each other.
- **Decode** against values computed in the test from the bytes it wrote: each type, little
  endian, at UTM-sized offsets in a record of format 0, 3, 6 and 8; scaled → raw × scale +
  offset, no-data → NaN; unscaled no-data kept; arrays interleaved; raw bytes exact; filters,
  `maxPoints` thinning, `chunks`, `readPointsToScratch` and the Worker give the same columns as
  `readPoints`; `"extra"` and named fields; the default fields unchanged.
- **Round trip:** a file with every writable type → `readPoints(["extra", …])` → `writeLas(p,
  { extraBytes: las.extraBytes })` → its records are the source's records byte for byte (LAS
  and LAZ, LAS 1.2 and 1.4, `createLasWriter` in batches equal to `writeLas`).
- **PDAL's bytes:** `f3x` and `f7x` (PDAL-compressed with three u8 extra bytes) now go through
  the writer: point data and LASzip VLR equal PDAL's, byte for byte (the skip in
  `writeLaz.test.js` goes).
- **PDAL reads ours** (skipped when PDAL is not installed; `PDAL=` or the QGIS install): a LAS
  1.4 file with u8, i16 scaled, u32, f32 and f64 fields → `pdal translate` to text → PDAL's values
  equal the columns written (scaled ones to the scale).
- **Writer refusals:** every line of section 7, with the batch's totals untouched after a refused
  `writePoints`.
- **Min / max:** the VLR's raw min and max equal the columns' over the points written, with
  no-data and NaN left out; across `createLasWriter` batches.
- **0.9.1 bytes unchanged:** every existing writer test passes untouched, the PDAL byte-for-byte
  fixtures included.

## 9. Out of scope

- Writing the deprecated array types 11–30 (read only; write three scalar fields instead).
- Filtering or colouring by an extra column.
- Editing a file's extra bytes in place (rewrite it).
- LAS 1.5.
