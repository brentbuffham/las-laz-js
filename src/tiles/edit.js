// src/tiles/edit.js
//==========================================================
// Edits on a tile store, in place:
//  - selections: { deletes, count, tiles: { key: ascending Uint32Array } },
//    indices into each node's points, stamped with the store's delete
//    counter (a delete or keep moves points, so older ones are refused)
//  - delete / keep: each touched node rewritten without the points
//  - setColumn: a standard field by re-encoding the node's records
//    twice (as they are, and with the new values) and copying only the
//    bytes that differ, so nothing else changes in any point format
//    (wave packets and extra bytes included); added columns directly
//  - addColumn / removeColumn: a typed array per node, in every node
//  - transform: composed into the manifest; no node is rewritten
// Every edit writes nodes as their next generation, then the manifest,
// then removes the old generation: cut short, the old manifest still
// names the old files, and the new ones are orphans that the next
// opening removes.
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { decodeRecords, recordFields, FIELD_TYPES } from "../read/decodeRecords.js";
import { encodeRecords } from "../write/encodeRecords.js";
import { createChunkCompressor } from "../laz/compressChunk.js";
import { EXTRA_TYPES } from "../format/ExtraBytes.js";
import { selectBox as boxOf, selectPolygon as polygonOf, selectClasses as classesOf, unionSelections, intersectSelections, subtractSelections } from "../ops/select.js";
import { checkTransform } from "../ops/transform.js";
import { writeManifest } from "./manifest.js";
import { encodeTile, COLUMN_TYPES } from "./tileFile.js";
import { tileName } from "./TileStore.js";
import { tightBox } from "./build.js";
import { loadTile, rawRecords } from "./read.js";
import { nodeWorldBox } from "./select.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }

var SETTABLE = { classification: [0, 255], classificationFlags: [0, 15], intensity: [0, 65535], userData: [0, 255], pointSourceId: [0, 65535], red: [0, 65535], green: [0, 65535], blue: [0, 65535] };
var MORE_RESERVED = ["count", "positions", "bounds", "stats", "colours", "normal", "extra", "extraBytes", "index"];

function keyOrder(a, b) {
	var p = a.split("-").map(Number), q = b.split("-").map(Number);
	for (var i = 0; i < 4; i++) if (p[i] !== q[i]) return p[i] - q[i];
	return 0;
}

// ---- selections ----

function meets(nb, box) {
	if (!nb) return false;
	function lo(k) { return box[k] === undefined || box[k] === null ? -Infinity : box[k]; }
	function hi(k) { return box[k] === undefined || box[k] === null ? Infinity : box[k]; }
	return nb.maxX >= lo("minX") && nb.minX <= hi("maxX") && nb.maxY >= lo("minY") && nb.minY <= hi("maxY") && nb.maxZ >= lo("minZ") && nb.minZ <= hi("maxZ");
}

/**
 * A selection across the store: fn picks points tile by tile.
 * @param {object} store
 * @param {function(object, {key: string, count: number, box: object}): (Uint32Array|null)} fn
 * @param {{fields?: string[], box?: object}} [opts] - only tiles whose box (moved by the transform) meets box
 * @returns {Promise<{deletes: number, count: number, tiles: object}>}
 */
export async function select(store, fn, opts) {
	opts = opts || {};
	if (typeof fn !== "function") throw bad("select needs a function (cols, tile) -> Uint32Array or null");
	var m = store.manifest, keys = Object.keys(m.nodes).sort(keyOrder), out = { deletes: m.deletes, count: 0, tiles: {} };
	for (var i = 0; i < keys.length; i++) {
		var node = m.nodes[keys[i]];
		if (!node.count) continue;
		var nb = nodeWorldBox(m, keys[i]);
		if (opts.box && !meets(nb, opts.box)) continue;
		var cols = await store.readTile(keys[i], { fields: opts.fields || ["x", "y", "z"] });
		var picked = fn(cols, { key: keys[i], count: node.count, box: nb });
		if (picked && picked.length) { out.tiles[keys[i]] = picked instanceof Uint32Array ? picked : Uint32Array.from(picked); out.count += picked.length; }
	}
	return out;
}

/** The points inside a box (world coordinates, after the store transform). */
export function selectBox(store, box) {
	if (!box || typeof box !== "object") throw bad("box must be an object { minX, maxX, minY, maxY, minZ, maxZ }");
	var useZ = box.minZ !== undefined || box.maxZ !== undefined;
	return select(store, function (cols) { return boxOf(cols, box); }, { fields: useZ ? ["x", "y", "z"] : ["x", "y"], box: box });
}

/** The points inside a polygon in XY (selectPolygon's options). */
export function selectPolygon(store, polygon, opts) {
	if (!polygon || polygon.length < 6) throw bad("polygon must be [x0, y0, x1, y1, ...] with 3 or more vertices");
	var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
	for (var i = 0; i + 1 < polygon.length; i += 2) {
		b.minX = Math.min(b.minX, polygon[i]); b.maxX = Math.max(b.maxX, polygon[i]);
		b.minY = Math.min(b.minY, polygon[i + 1]); b.maxY = Math.max(b.maxY, polygon[i + 1]);
	}
	var tol = opts && opts.tolerance > 0 ? opts.tolerance : 0;
	b.minX -= tol; b.maxX += tol; b.minY -= tol; b.maxY += tol;
	if (opts && opts.minZ !== undefined) b.minZ = opts.minZ;
	if (opts && opts.maxZ !== undefined) b.maxZ = opts.maxZ;
	var useZ = opts && (opts.minZ !== undefined || opts.maxZ !== undefined);
	return select(store, function (cols) { return polygonOf(cols, polygon, opts); }, { fields: useZ ? ["x", "y", "z"] : ["x", "y"], box: b });
}

/** The points of some classes. */
export function selectClasses(store, classes) {
	return select(store, function (cols) { return classesOf(cols, classes); }, { fields: ["classification"] });
}

/**
 * Combine two tile selections tile by tile.
 * @param {object} a
 * @param {object} b
 * @param {"union"|"intersect"|"subtract"} op
 * @returns {{deletes: number, count: number, tiles: object}}
 */
export function combineTileSelections(a, b, op) {
	var fn = { union: unionSelections, intersect: intersectSelections, subtract: subtractSelections }[op];
	if (!fn) throw bad("op must be union, intersect or subtract");
	if (!a || !b || !a.tiles || !b.tiles) throw bad("combineTileSelections needs two tile selections");
	if (a.deletes !== b.deletes) throw bad("the selections were made at different edits (a delete or keep came between them)");
	var out = { deletes: a.deletes, count: 0, tiles: {} }, none = new Uint32Array(0);
	var keys = Object.keys(a.tiles).concat(Object.keys(b.tiles).filter(function (k) { return !a.tiles[k]; })).sort(keyOrder);
	keys.forEach(function (k) {
		var c = fn(a.tiles[k] || none, b.tiles[k] || none);
		if (c.length) { out.tiles[k] = c; out.count += c.length; }
	});
	return out;
}

function checkSelection(store, sel) {
	if (!sel || typeof sel !== "object" || !sel.tiles) throw bad("a tile selection is needed (store.select, selectBox, selectPolygon or selectClasses)");
	if (sel.deletes !== store.manifest.deletes) throw bad("this selection was made before the last delete or keep; select again");
	Object.keys(sel.tiles).forEach(function (k) {
		var node = store.manifest.nodes[k];
		if (!node) throw bad("the selection names tile " + k + ", which is not in the store");
		var s = sel.tiles[k];
		for (var i = 0; i < s.length; i++) {
			if (!(s[i] < node.count) || (i && s[i] <= s[i - 1])) throw bad("selection index " + s[i] + " is not an ascending point of tile " + k + " (" + node.count + " points)");
		}
	});
}

// ---- writing nodes ----

async function readNode(store, key) {
	var t = await loadTile(store, key);
	return { t: t, records: rawRecords(store, t) };
}

function packOf(store) {
	var m = store.manifest;
	return m.laz ? createChunkCompressor(m.laz, m.recordLength) : null;
}

// Write the nodes' next generations, then the manifest (change(body) edits it), then remove
// the old generations. The store's manifest is replaced only once the new one is written.
async function commit(store, writes, change) {
	var m = store.manifest, be = store._backend, len = m.recordLength, pack = packOf(store);
	var body = JSON.parse(JSON.stringify(m)), written = [];
	await be.lock();
	try {
		try {
			for (var i = 0; i < writes.length; i++) {
				var w = writes[i], old = m.nodes[w.key], count = w.records.length / len;
				var bytes = encodeTile({ count: count, records: pack ? pack(w.records, 0, count) : w.records, compressed: !!pack, columns: w.columns });
				var name = tileName(w.key, old.gen + 1);
				await be.put(name, bytes);
				written.push(name);
				body.nodes[w.key] = { count: count, gen: old.gen + 1, box: tightBox(w.records, len, m.scale, m.offset) };
				body.bytes += bytes.length - w.oldSize;
			}
			if (change) change(body);
			body.edits++;
			await writeManifest(be, body);
		} catch (err) {
			for (var j = 0; j < written.length; j++) { try { await be.remove(written[j]); } catch (e) { /* the next opening removes it */ } }
			throw err;
		}
		store.manifest = body;
		for (var k = 0; k < writes.length; k++) { try { await be.remove(tileName(writes[k].key, m.nodes[writes[k].key].gen)); } catch (e) { /* swept on open */ } }
	} finally {
		be.unlock();
	}
}

async function nodeBytes(store, key) {
	var b = await store._backend.get(tileName(key, store.manifest.nodes[key].gen));
	return b ? b.length : 0;
}

// ---- delete / keep ----

async function removeWhere(store, sel, keepSelected) {
	checkSelection(store, sel);
	var m = store.manifest, len = m.recordLength, writes = [], removed = 0;
	var keys = keepSelected ? Object.keys(m.nodes).sort(keyOrder) : Object.keys(sel.tiles).sort(keyOrder);
	for (var i = 0; i < keys.length; i++) {
		var key = keys[i], node = m.nodes[key], picked = sel.tiles[key] || new Uint32Array(0);
		if (!node.count || (keepSelected && picked.length === node.count) || (!keepSelected && !picked.length)) continue;
		var n = await readNode(store, key), flag = new Uint8Array(node.count);
		for (var p = 0; p < picked.length; p++) flag[picked[p]] = 1;
		var stay = keepSelected ? 1 : 0, kept = 0;
		for (var q = 0; q < node.count; q++) if (flag[q] === stay) kept++;
		var records = new Uint8Array(kept * len), columns = n.t.columns.map(function (c) { return new c.constructor(kept); }), o = 0;
		for (var r = 0; r < node.count; r++) {
			if (flag[r] !== stay) continue;
			records.set(n.records.subarray(r * len, (r + 1) * len), o * len);
			for (var c = 0; c < columns.length; c++) columns[c][o] = n.t.columns[c][r];
			o++;
		}
		removed += node.count - kept;
		writes.push({ key: key, records: records, columns: columns, oldSize: await nodeBytes(store, key) });
	}
	await commit(store, writes, function (body) { body.deletes++; });
	return { removed: removed };
}

/** Delete the selected points. */
export function deletePoints(store, sel) { return removeWhere(store, sel, false); }

/** Keep only the selected points. */
export function keepPoints(store, sel) { return removeWhere(store, sel, true); }

// ---- columns ----

function checkValue(name, v, range, where) {
	if (typeof v !== "number" || !Number.isInteger(v) || v < range[0] || v > range[1]) throw bad(name + " must be a whole number from " + range[0] + " to " + range[1] + " (" + where + " is " + v + ")");
}

function checkTyped(type, v, name, where) {
	var e = EXTRA_TYPES[type];
	if (e.big) {
		if (typeof v !== "bigint" && !Number.isSafeInteger(v)) throw bad(name + " is " + type + ": " + where + " must be a whole number (or BigInt), not " + v);
		var b = BigInt(v);
		if (b < e.min || b > e.max) throw bad(name + " is " + type + ": " + where + " " + v + " is outside " + e.min + " to " + e.max);
		return b;
	}
	if (typeof v !== "number") throw bad(name + " is " + type + ": " + where + " must be a number, not " + typeof v);
	if (e.int && (!Number.isInteger(v) || v < e.min || v > e.max)) throw bad(name + " is " + type + ": " + where + " " + v + " is not a whole number from " + e.min + " to " + e.max);
	if (!e.int && isFinite(v) && Math.abs(v) > e.max) throw bad(name + " is " + type + ": " + where + " " + v + " is out of range");
	return v;
}

/**
 * Set a field for the selected points: one value, or { key: typed array } in the selection's order.
 */
export async function setColumn(store, sel, name, value) {
	checkSelection(store, sel);
	var m = store.manifest, added = m.columns.map(function (c) { return c.name; }), ai = added.indexOf(name);
	if (ai < 0 && !SETTABLE[name]) throw bad(name + " cannot be set on a tile store: classification, classificationFlags, intensity, userData, pointSourceId, red, green, blue or an added column");
	if (ai < 0 && (name === "red" || name === "green" || name === "blue") && recordFields(m.pointFormat).indexOf(name) < 0) throw bad(name + " cannot be set: point format " + m.pointFormat + " has no colour");
	var perTile = value !== null && typeof value === "object";
	var keys = Object.keys(sel.tiles).sort(keyOrder), writes = [], len = m.recordLength;
	keys.forEach(function (k) {
		var want = perTile ? value[k] : null, idx = sel.tiles[k];
		if (perTile && (!want || want.length !== idx.length)) throw bad("value[" + k + "] must hold one value for each of the tile's " + idx.length + " selected points");
		for (var i = 0; i < idx.length; i++) {
			var v = perTile ? want[i] : value;
			if (ai < 0) checkValue(name, v, SETTABLE[name], "point " + idx[i] + " of tile " + k);
			else checkTyped(m.columns[ai].type, v, name, "point " + idx[i] + " of tile " + k);
			if (!perTile) break;
		}
	});
	for (var t = 0; t < keys.length; t++) {
		var key = keys[t], idx = sel.tiles[key], n = await readNode(store, key), want = perTile ? value[key] : null;
		var records = n.records, columns = n.t.columns;
		if (ai >= 0) {
			var col = columns[ai].slice(), big = EXTRA_TYPES[m.columns[ai].type].big;
			for (var i = 0; i < idx.length; i++) { var v = perTile ? want[i] : value; col[idx[i]] = big ? BigInt(v) : v; }
			columns = columns.slice();
			columns[ai] = col;
		} else records = patchField(store, records, name, idx, perTile ? want : null, value);
		writes.push({ key: key, records: records, columns: columns, oldSize: await nodeBytes(store, key) });
	}
	await commit(store, writes, null);
}

// Re-encode the node twice and copy only the bytes the new values change
function patchField(store, records, name, idx, values, value) {
	var m = store.manifest, len = m.recordLength, n = records.length / len;
	var cols = decodeRecords(records, store.header, { fields: recordFields(m.pointFormat) });
	var so = { scale: m.scale, offset: m.offset };
	function encode() {
		var out = new Uint8Array(records.length);
		encodeRecords(cols, m.pointFormat, len, so, null, new DataView(out.buffer), 0, { bounds: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }, byReturn: new Array(15).fill(0) }, 0, null);
		return out;
	}
	var before = encode();
	for (var i = 0; i < idx.length; i++) cols[name][idx[i]] = values ? values[i] : value;
	var after = encode(), out = records.slice();
	for (var b = 0; b < n * len; b++) if (after[b] !== before[b]) out[b] = after[b];
	return out;
}

/**
 * Add a column every point holds, set to fill.
 */
export async function addColumn(store, name, type, fill) {
	var m = store.manifest;
	if (typeof name !== "string" || !name || name.length > 32 || /[^\x01-\xff]/.test(name)) throw bad("a column name is 1 to 32 characters, one byte each");
	var taken = Object.keys(FIELD_TYPES).concat(MORE_RESERVED, store.extraBytes.map(function (f) { return f.column; }), m.columns.map(function (c) { return c.name; }));
	if (taken.indexOf(name) >= 0) throw bad("the column name " + name + " is taken (a standard field, a reserved name, a file extra column or an added column)");
	if (!COLUMN_TYPES[type]) throw bad("type " + type + " is not one of u8, i8, u16, i16, u32, i32, u64, i64, f32, f64");
	if (fill === undefined) fill = 0;
	var f = checkTyped(type, fill, name, "fill");
	var keys = Object.keys(m.nodes).sort(keyOrder), writes = [];
	for (var i = 0; i < keys.length; i++) {
		var n = await readNode(store, keys[i]), col = new COLUMN_TYPES[type](n.t.count);
		col.fill(f);
		writes.push({ key: keys[i], records: n.records, columns: n.t.columns.concat([col]), oldSize: await nodeBytes(store, keys[i]) });
	}
	await commit(store, writes, function (body) { body.columns.push({ name: name, type: type, fill: typeof f === "bigint" ? String(f) : f }); });
}

/** Remove an added column from every node. */
export async function removeColumn(store, name) {
	var m = store.manifest, ai = m.columns.map(function (c) { return c.name; }).indexOf(name);
	if (ai < 0) throw bad("no added column " + name + " in the store");
	var keys = Object.keys(m.nodes).sort(keyOrder), writes = [];
	for (var i = 0; i < keys.length; i++) {
		var n = await readNode(store, keys[i]);
		writes.push({ key: keys[i], records: n.records, columns: n.t.columns.filter(function (c, j) { return j !== ai; }), oldSize: await nodeBytes(store, keys[i]) });
	}
	await commit(store, writes, function (body) { body.columns.splice(ai, 1); });
}

// ---- transform ----

/**
 * Compose a transform onto the store's: T after the one it has. No node is rewritten.
 */
export async function transform(store, T) {
	checkTransform(T, "transform");
	var old = store.manifest.transform, m = Array.from(T.m), t = Array.from(T.t);
	if (old) {
		var a = m, b = old.m, mm = [];
		for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) mm.push(a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c]);
		t = [0, 1, 2].map(function (r) { return a[3 * r] * old.t[0] + a[3 * r + 1] * old.t[1] + a[3 * r + 2] * old.t[2] + t[r]; });
		m = mm;
	}
	await commit(store, [], function (body) { body.transform = { m: m, t: t }; });
}

