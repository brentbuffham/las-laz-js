# LAS format notes

Working notes on the parts of ASPRS LAS 1.0–1.4 (R15) that the code depends on, and the traps
met while building it. The specification is the authority; these are reminders.

## Public header

| Offset | Field | Notes |
|---|---|---|
| 0 | "LASF" | signature |
| 24, 25 | version major, minor | 1.0–1.4 |
| 94 | header size | 227 (1.0–1.2), 235 (1.3), 375 (1.4); use the stored value |
| 96 | offset to point data | after the VLRs |
| 100 | number of VLRs | |
| 104 | point format | low 6 bits; **bit 7 (and in some writers bit 6) marks LAZ** — 131 = format 3, compressed |
| 105 | record length | may exceed the format's size ("extra bytes") |
| 107 | legacy point count (u32) | **0 in LAS 1.4 for formats 6–10 or counts above 2^32** |
| 111 | legacy points by return (5 × u32) | |
| 131–227 | scale, offset (f64 × 3 each), max / min X, Y, Z | bounds are max then min |
| 227 | waveform data start (u64) | 1.3+ |
| 235, 243 | first EVLR (u64), number of EVLRs | 1.4 |
| 247 | point count (u64) | 1.4 — always prefer this |
| 255 | points by return (15 × u64) | 1.4 |

64-bit values are built as `hi * 2^32 + lo` and refused above 2^53, never assembled with bit
operators (they wrap past 2^31).

## Point formats

| Format | Size | Layout | Adds |
|---|---|---|---|
| 0 | 20 | legacy | — |
| 1 | 28 | legacy | GPS time at 20 |
| 2 | 26 | legacy | RGB at 20 |
| 3 | 34 | legacy | GPS time at 20, RGB at 28 |
| 4 | 57 | legacy | GPS time, wave packet at 28 |
| 5 | 63 | legacy | GPS time, RGB at 28, wave packet at 34 |
| 6 | 30 | extended | GPS time at 22 |
| 7 | 36 | extended | RGB at 30 |
| 8 | 38 | extended | RGB at 30, NIR at 36 |
| 9 | 59 | extended | wave packet at 30 |
| 10 | 67 | extended | RGB, NIR, wave packet at 38 |

**Legacy** (0–5): byte 14 = return number (3 bits), number of returns (3), scan direction,
edge of flight line; byte 15 = classification (5 bits) + synthetic / key-point / withheld;
byte 16 = scan angle rank (int8, degrees); 17 user data; 18 point source ID.

**Extended** (6–10): byte 14 = return number (4 bits), number of returns (4); byte 15 =
classification flags (4 bits), scanner channel (2), scan direction, edge; byte 16 =
classification (8 bits); 17 user data; 18 scan angle (int16, 0.006° steps); 20 point source ID;
22 GPS time.

## VLRs and EVLRs

VLR header 54 bytes (u16 data length), EVLR header 60 bytes (u64 data length). The coordinate
system lives in `LASF_Projection` records: 34735 GeoKey directory (EPSG from key 3072, else
2048; 32767 means user-defined), 2112 OGC WKT. LAS 1.4 sets global-encoding bit 4 when WKT is
the definition.

## Colour

RGB is 16-bit. Some writers store 8-bit values in it; if every value is 255 or less the reader
treats the file as 8-bit rather than dividing it to near black.

## Traps met

- Reading only the legacy count on LAS 1.4 gives 0 points for formats 6–10.
- A window boundary must fall between records; the reader splits point data into windows of
  whole records.
- Asking for one colour channel must not assume the others were asked for too.

## LAZ (LASzip)

A LAZ file is a LAS file whose point format byte has bit 7 set and whose point records are
replaced by compressed chunks. The `laszip encoded` VLR (record 22204) says how:

| Field | Notes |
|---|---|
| compressor | 1 point-wise (one stream), 2 point-wise chunked (formats 0-5), 3 layered chunked (formats 6-10) |
| chunk size | usually 50,000 points; 0 or 0xFFFFFFFF means variable (the table then carries point counts) |
| items | one record = the items in order (Point10, GpsTime11, RGB12, Byte / Point14, RGB14, RGBNIR14, Byte14), each with size and coder version |

Point data starts with an i64 offset to the **chunk table**; chunk 0 starts 8 bytes later. The
table (u32 version, u32 count, then arithmetic-coded byte counts, and point counts if variable) is
written last, so a streaming writer leaves -1 at the start and repeats the offset in the file's
final 8 bytes.

Every chunk is independent. Its first record is stored raw; the rest are arithmetic-coded. In a
point-wise chunk one stream follows the raw record. In a layered chunk, after the raw record come
a u32 point count, each field's layer sizes (Point14 has nine: channel / returns / XY, Z,
classification, flags, intensity, scan angle, user data, point source, GPS time), then the
layers; a layer of size 0 never changed in that chunk, so the value stays the last one.

### Traps met

- The first point's intensity is NOT a prediction for the second (Point10 v2 resets it to 0); only
  a point that changes nothing reveals it.
- GPS time is coded as the 64-bit pattern of the double, so it is held as two 32-bit halves with
  carry, never as a float. Up to four time sequences are tracked; a point can switch back to one.
- Point14 keeps a context per scanner channel, started from the last point of the channel it left.
  In item version 3 the RGB / NIR / Byte items only see the channel on the point where it changed
  (context 0 otherwise) — a LASzip quirk that version 4 fixed. It must be reproduced exactly.
- PDAL pads LAZ point format 8 with 2 extra bytes (records of 40, not 38), and drops extra bytes
  from LAS 1.2 files when compressing.
- Decoding past a chunk's end means the data is cut short or corrupt: stop with TRUNCATED.
