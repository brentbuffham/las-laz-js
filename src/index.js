// src/index.js
//==========================================================
// Public entry point for las-laz-js.
// VERSION is kept in step with package.json by test/package.test.js
// (a JSON import would need import attributes in browsers).
//==========================================================

/** Library version, matches package.json. */
export var VERSION = "0.10.0";

export { LasError, ERROR_CODES } from "./errors.js";
export { openLas, LasReader } from "./LasReader.js";
export { parseHeader } from "./format/LasHeader.js";
export { parseVlrs, parseEvlrs } from "./format/LasVlr.js";
export { parseCrs } from "./format/LasCrs.js";
export { parseClassLookup } from "./format/ClassLookup.js";
export { parseExtraBytes } from "./format/ExtraBytes.js";
export { POINT_FORMATS, formatHasRgb } from "./format/PointFormats.js";
export { decodeRecords, DEFAULT_FIELDS, FIELD_TYPES } from "./read/decodeRecords.js";
export { makeKeep, countKept } from "./filter/filters.js";
export { dedupe, dedupeSelection } from "./filter/dedupe.js";
export { buildIndex } from "./index/grid.js";
export { pointsInRadius, nearestPoint, pointsNearRay } from "./index/query.js";
export { nearestPoints } from "./index/knn.js";
export { selectBox, selectPolygon, selectClasses, selectReturns, thinSelection, unionSelections, intersectSelections, subtractSelections } from "./ops/select.js";
export { keepPoints, removePoints, splitPoints, mergePoints } from "./ops/apply.js";
export { makeTransform, transformPoints } from "./ops/transform.js";
export { interleavePositions } from "./ops/interleave.js";
export { selectSparse } from "./ops/sparse.js";
export { selectOutliers } from "./ops/outliers.js";
export { pointNormals, estimateNoise } from "./ops/normals.js";
export { denoisePoints } from "./ops/denoise.js";
export { classifyPoints, ASPRS_CLASSES } from "./ops/classify.js";
export { fitTransform } from "./register/fit.js";
export { parseControlPoints, matchControlPoints } from "./register/controlPoints.js";
export { alignCloud } from "./register/align.js";
export { poleOf, orientationOf, poleFromOrientation } from "./facets/orientation.js";
export { findFacets } from "./facets/findFacets.js";
export { jointSets } from "./facets/jointSets.js";
export { sizeDistribution } from "./fragments/sizeDistribution.js";
export { MemorySource } from "./io/MemorySource.js";
export { BlobSource } from "./io/BlobSource.js";
export { NodeFileSource } from "./io/NodeFileSource.js";
export { SCRATCH_DIR, openScratchSyncWriter, openScratchReader, removeScratchFile, sweepStaleScratchFiles, listScratchFiles, getScratchFile } from "./io/ScratchBinaryFile.js";
export { colourize, createChunkColourizer, RAMPS, CLASS_COLOURS } from "./colour/colourize.js";
export { writeLas, createLasWriter } from "./write/writeLas.js";
export { chooseScaleOffset } from "./write/scaleOffset.js";
export { createWorkerHandler } from "./workers/workerProtocol.js";
export { buildTiles } from "./tiles/build.js";
export { openTiles, listTiles, removeTiles, TileStore } from "./tiles/TileStore.js";
export { selectTiles } from "./tiles/select.js";
export { combineTileSelections } from "./tiles/edit.js";
