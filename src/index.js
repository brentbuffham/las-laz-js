// src/index.js
//==========================================================
// Public entry point for las-laz-js.
// VERSION is kept in step with package.json by test/package.test.js
// (a JSON import would need import attributes in browsers).
//==========================================================

/** Library version, matches package.json. */
export var VERSION = "0.3.1";

export { LasError, ERROR_CODES } from "./errors.js";
export { openLas, LasReader } from "./LasReader.js";
export { parseHeader } from "./format/LasHeader.js";
export { parseVlrs, parseEvlrs } from "./format/LasVlr.js";
export { parseCrs } from "./format/LasCrs.js";
export { POINT_FORMATS, formatHasRgb } from "./format/PointFormats.js";
export { decodeRecords, DEFAULT_FIELDS, FIELD_TYPES } from "./read/decodeRecords.js";
export { makeKeep, countKept } from "./filter/filters.js";
export { dedupe } from "./filter/dedupe.js";
export { MemorySource } from "./io/MemorySource.js";
export { BlobSource } from "./io/BlobSource.js";
export { NodeFileSource } from "./io/NodeFileSource.js";
export { SCRATCH_DIR, openScratchSyncWriter, openScratchReader, removeScratchFile, sweepStaleScratchFiles, listScratchFiles, getScratchFile } from "./io/ScratchBinaryFile.js";
export { colourize, createChunkColourizer, RAMPS, CLASS_COLOURS } from "./colour/colourize.js";
export { writeLas, createLasWriter } from "./write/writeLas.js";
export { chooseScaleOffset } from "./write/scaleOffset.js";
export { createWorkerHandler } from "./workers/workerProtocol.js";
