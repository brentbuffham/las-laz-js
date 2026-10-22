// src/index.js
//==========================================================
// Public entry point for las-laz-js.
// VERSION is kept in step with package.json by test/package.test.js
// (a JSON import would need import attributes in browsers).
//==========================================================

/** Library version, matches package.json. */
export var VERSION = "0.6.2";

export { LasError, ERROR_CODES } from "./errors.js";
export { openLas, LasReader } from "./LasReader.js";
export { parseHeader } from "./format/LasHeader.js";
export { parseVlrs, parseEvlrs } from "./format/LasVlr.js";
export { parseCrs } from "./format/LasCrs.js";
export { POINT_FORMATS, formatHasRgb } from "./format/PointFormats.js";
export { decodeRecords, DEFAULT_FIELDS, FIELD_TYPES } from "./read/decodeRecords.js";
export { makeKeep, countKept } from "./filter/filters.js";
export { dedupe, dedupeSelection } from "./filter/dedupe.js";
export { buildIndex } from "./index/grid.js";
export { pointsInRadius, nearestPoint, pointsNearRay } from "./index/query.js";
export { selectBox, selectPolygon, selectClasses, selectReturns, thinSelection, unionSelections, intersectSelections, subtractSelections } from "./ops/select.js";
export { keepPoints, removePoints, splitPoints, mergePoints } from "./ops/apply.js";
export { makeTransform, transformPoints } from "./ops/transform.js";
export { interleavePositions } from "./ops/interleave.js";
export { selectSparse } from "./ops/sparse.js";
export { MemorySource } from "./io/MemorySource.js";
export { BlobSource } from "./io/BlobSource.js";
export { NodeFileSource } from "./io/NodeFileSource.js";
export { SCRATCH_DIR, openScratchSyncWriter, openScratchReader, removeScratchFile, sweepStaleScratchFiles, listScratchFiles, getScratchFile } from "./io/ScratchBinaryFile.js";
export { colourize, createChunkColourizer, RAMPS, CLASS_COLOURS } from "./colour/colourize.js";
export { writeLas, createLasWriter } from "./write/writeLas.js";
export { chooseScaleOffset } from "./write/scaleOffset.js";
export { createWorkerHandler } from "./workers/workerProtocol.js";
