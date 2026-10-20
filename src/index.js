// src/index.js
//==========================================================
// Public entry point for las-laz-js.
// VERSION is kept in step with package.json by test/package.test.js
// (a JSON import would need import attributes in browsers).
//==========================================================

/** Library version, matches package.json. */
export var VERSION = "0.1.0";

export { LasError, ERROR_CODES } from "./errors.js";
