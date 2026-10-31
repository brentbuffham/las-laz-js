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
import { selectBox as boxOf, selectPolygon as polygonOf, selectScreen as screenSel, selectClasses as classesOf, unionSelections, intersectSelections, subtractSelections } from "../ops/select.js";
import { checkTransform } from "../ops/transform.js";
import { makePolygonTest, rectAgainstPolygon } from "../ops/polygon.js";
import { screenOf, boxOnScreen } from "../ops/screen.js";
import { writeManifest, readManifest } from "./manifest.js";
import { encodeTile, COLUMN_TYPES } from "./tileFile.js";
import { tileName } from "./TileStore.js";
import { tightBox, phase } from "./build.js";
import { loadTile, rawRecords } from "./read.js";
import { nodeWorldBox } from "./select.js";
import { compareKeys as keyOrder } from "./octree.js";

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function aborted(signal) { if (signal && signal.aborted) throw new LasError(ERROR_CODES.ABORTED, "the edit was stopped"); }

var SETTABLE = { classification: [0, 255], classificationFlags: [0, 15], intensity: [0, 65535], userData: [0, 255], pointSourceId: [0, 65535], red: [0, 65535], green: [0, 65535], blue: [0, 65535] };
var MORE_RESERVED = ["count", "positions", "bounds", "stats", "colours", "normal", "extra", "extraBytes", "index"];


// ---- selections ----

function meets(nb, box) {
	if (!nb) return false;
	function lo(k) { return box[k] === undefined || box[k] === null ? -Infinity : box[k]; }
	function hi(k) { return box[k] === undefined || box[k] === null ? Infinity : box[k]; }
	return nb.maxX >= lo("minX") && nb.minX <= hi("maxX") && nb.maxY >= lo("minY") && nb.minY <= hi("maxY") && nb.maxZ >= lo("minZ") && nb.minZ <= hi("maxZ");
}

// A box's slack for pruning: rounding in a point's world coordinates (scale, offset, transform)
// cannot carry it this far past the node's box
function slack(nb) {
	return 1e-9 * (1 + Math.max(Math.abs(nb.minX), Math.abs(nb.maxX), Math.abs(nb.minY), Math.abs(nb.maxY), Math.abs(nb.minZ), Math.abs(nb.maxZ)));
}

// Where a node's box lies against limits on one axis (undefined: none): -1 clear of them, 1 within, 0 across
function axisAgainst(lo, hi, min, max, e) {
	if (min === undefined || min === null) min = -Infinity;
	if (max === undefined || max === null) max = Infinity;
	if (hi < min || lo > max) return -1;
	return lo >= min + e && hi <= max - e ? 1 : 0;
}

/**
 * A selection across the store: fn picks points tile by tile.
 * @param {object} store
 * @param {function(object, {key: string, count: number, box: object}): (Uint32Array|null)} fn
 * @param {{fields?: string[], box?: object, classify?: function(object): number, signal?: AbortSignal,
 *   onProgress?: function({phase: string, done: number, total: number}), threads?: number}} [opts] - box: only tiles
 *   whose box (moved by the transform) meets it; classify(box): -1 for a tile none of whose points fn
 *   would pick (skipped), 1 for one all of whose points it would (taken whole, not read), 0 to read it.
 *   The tiles to read are known before the first is read: onProgress({ phase: "select", done, total }) counts
 *   them; signal stops it (ABORTED; nothing is written by a selection); LAZ tiles decode on the store's pool
 *   (threads: 1 for this thread only)
 * @returns {Promise<{deletes: number, count: number, tiles: object}>}
 * @throws {LasError} ABORTED
 */
export async function select(store, fn, opts) {
	opts = opts || {};
	if (typeof fn !== "function") throw bad("select needs a function (cols, tile) -> Uint32Array or null");
	if (opts.classify !== undefined && typeof opts.classify !== "function") throw bad("classify must be a function (box) -> -1, 0 or 1");
	var m = store.manifest, keys = Object.keys(m.nodes).sort(keyOrder), out = { deletes: m.deletes, count: 0, tiles: {} };
	aborted(opts.signal);
	// every tile is classified first (no reads), so the tiles to read are known and progress counts them
	var plan = [], toRead = [];
	for (var i = 0; i < keys.length; i++) {
		var node = m.nodes[keys[i]];
		if (!node.count) continue;
		var nb = nodeWorldBox(m, keys[i]);
		if (opts.box && !meets(nb, opts.box)) continue;
		var verdict = opts.classify ? opts.classify(nb) : 0;
		if (verdict < 0) continue;
		plan.push({ key: keys[i], count: node.count, box: nb, whole: verdict > 0 });
		if (verdict <= 0) toRead.push(keys[i]);
	}
	var reading = phase(opts.onProgress, "select", toRead.length), done = 0;
	var gen = store.readTiles(toRead, { fields: opts.fields || ["x", "y", "z"], threads: opts.threads });
	try {
		for (var p = 0; p < plan.length; p++) {
			var step = plan[p];
			aborted(opts.signal);
			if (step.whole) {
				var all = new Uint32Array(step.count);
				for (var a = 0; a < all.length; a++) all[a] = a;
				out.tiles[step.key] = all;
				out.count += all.length;
				continue;
			}
			var got = await gen.next();
			var picked = fn(got.value.points, { key: step.key, count: step.count, box: step.box });
			if (picked && picked.length) { out.tiles[step.key] = picked instanceof Uint32Array ? picked : Uint32Array.from(picked); out.count += picked.length; }
			reading.tick(++done);
		}
	} finally {
		await gen.return();
	}
	reading.finish();
	return out;
}

/** The points inside a box (world coordinates, after the store transform); opts: signal, onProgress, threads (as select). */
export function selectBox(store, box, opts) {
	if (!box || typeof box !== "object") throw bad("box must be an object { minX, maxX, minY, maxY, minZ, maxZ }");
	var useZ = box.minZ !== undefined || box.maxZ !== undefined;
	return select(store, function (cols) { return boxOf(cols, box); }, {
		fields: useZ ? ["x", "y", "z"] : ["x", "y"], box: box, signal: opts && opts.signal, onProgress: opts && opts.onProgress, threads: opts && opts.threads,
		classify: function (nb) {
			var e = slack(nb), v = Math.min(axisAgainst(nb.minX, nb.maxX, box.minX, box.maxX, e), axisAgainst(nb.minY, nb.maxY, box.minY, box.maxY, e));
			return useZ ? Math.min(v, axisAgainst(nb.minZ, nb.maxZ, box.minZ, box.maxZ, e)) : v;
		}
	});
}

/** The points inside a polygon in XY (selectPolygon's options, and signal, onProgress, threads as select): a tile wholly inside taken without reading it. */
export function selectPolygon(store, polygon, opts) {
	if (!polygon || polygon.length < 6) throw bad("polygon must be [x0, y0, x1, y1, ...] with 3 or more vertices");
	var shape = makePolygonTest(polygon, opts);
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
	return select(store, function (cols) { return polygonOf(cols, polygon, opts); }, {
		fields: useZ ? ["x", "y", "z"] : ["x", "y"], box: b, signal: opts && opts.signal, onProgress: opts && opts.onProgress, threads: opts && opts.threads,
		classify: function (nb) {
			var e = slack(nb), z = useZ ? axisAgainst(nb.minZ, nb.maxZ, opts.minZ, opts.maxZ, e) : 1;
			if (z < 0) return -1;
			var r = rectAgainstPolygon(shape.points, nb.minX, nb.minY, nb.maxX, nb.maxY, shape.tolerance + e);
			return r < 0 ? -1 : Math.min(r, z);
		}
	});
}

/**
 * The points inside a shape drawn on the screen (selectScreen's rule): every point it covers, at any
 * depth. A tile wholly outside the view or the shape is not read; one wholly inside both is taken
 * without reading it.
 * @param {object} store
 * @param {{viewProjection: number[], width: number, height: number, localOrigin?: {x, y, z}}} view - as selectTiles
 * @param {number[]|TypedArray} polygon - pixels from the view's top-left, y down
 * @param {{boundary?: "touching"|"inside", tolerance?: number, signal?: AbortSignal, onProgress?: function, threads?: number}} [opts] - signal, onProgress, threads as select
 */
export function selectScreen(store, view, polygon, opts) {
	var s = screenOf(view), shape = makePolygonTest(polygon, opts), margin = shape.tolerance + 1e-6 * (1 + s.width + s.height);
	return select(store, function (cols) { return screenSel(cols, view, polygon, opts); }, {
		fields: ["x", "y", "z"], signal: opts && opts.signal, onProgress: opts && opts.onProgress, threads: opts && opts.threads,
		classify: function (nb) { return boxOnScreen(s, nb, shape.points, margin); }
	});
}

/** The points of some classes; opts: signal, onProgress, threads (as select). */
export function selectClasses(store, classes, opts) {
	return select(store, function (cols) { return classesOf(cols, classes); }, { fields: ["classification"], signal: opts && opts.signal, onProgress: opts && opts.onProgress, threads: opts && opts.threads });
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

// A node for an edit that changes only its added columns: the records are left as stored (packed
// on a compressed store), never decompressed - put copies them through
async function readNodeColumns(store, key) {
	var t = await loadTile(store, key);
	return { t: t, records: null, packed: t.compressed ? t.records : null, raw: t.compressed ? null : t.records };
}

function packOf(store) {
	var m = store.manifest;
	return m.laz ? createChunkCompressor(m.laz, m.recordLength) : null;
}

// Edits on one store run one at a time, in the order asked
export function queued(store, fn) {
	var run = (store._editing || Promise.resolve()).then(fn);
	store._editing = run.catch(function () {});
	return run;
}

// One edit: under the backend's lock, from the manifest this store last saw (a store changed
// in another tab or worker since is refused, not overwritten). run(put) reads nodes and hands
// each node's new records and columns to put, which writes its next generation at once (an
// orphan until the manifest lands); then the manifest (change(body) edits it); then the old
// generations go. Cut short: the new files go, unless the manifest naming them landed.
async function session(store, run, change) {
	var be = store._backend;
	await be.lock();
	try {
		var disk = await readManifest(be);
		if (!disk || disk.seq !== store._seq) throw new LasError(ERROR_CODES.BAD_STORE, "the tile store changed in another tab or worker since it was opened here; open it again");
		var m = store.manifest, len = m.recordLength, pack = packOf(store);
		var body = JSON.parse(JSON.stringify(m)), written = [], replaced = [];
		var put = async function (key, records, columns, oldSize, same) {
			var old = m.nodes[key];
			// same: a column-only edit - the node's records go through as stored (packed or raw), its box stays
			if (same) {
				var keep = same.packed || same.raw;
				var kept = encodeTile({ count: old.count, records: keep, compressed: !!same.packed, columns: columns });
				var keptName = tileName(key, old.gen + 1);
				await be.put(keptName, kept);
				written.push(keptName);
				replaced.push(tileName(key, old.gen));
				body.nodes[key] = { count: old.count, gen: old.gen + 1, box: old.box };
				body.bytes += kept.length - oldSize;
				return;
			}
			var count = records.length / len;
			if (pack && store._onPack) store._onPack(key);
			var bytes = encodeTile({ count: count, records: pack ? pack(records, 0, count) : records, compressed: !!pack, columns: columns });
			var name = tileName(key, old.gen + 1);
			await be.put(name, bytes);
			written.push(name);
			replaced.push(tileName(key, old.gen));
			body.nodes[key] = { count: count, gen: old.gen + 1, box: tightBox(records, len, m.scale, m.offset) };
			body.bytes += bytes.length - oldSize;
		};
		var result, seq;
		try {
			result = await run(put, m);
			if (change) change(body);
			body.edits++;
			seq = await writeManifest(be, body);
		} catch (err) {
			var now = null;
			try { now = await readManifest(be); } catch (e) { now = null; }
			if (now && now.seq === store._seq + 1 && JSON.stringify(now.body) === JSON.stringify(body)) {
				// the manifest landed before the write reported its error: it stands
				store.manifest = now.body;
				store._seq = now.seq;
				await removeEach(be, replaced);
			} else await removeEach(be, written);
			throw err;
		}
		store.manifest = body;
		store._seq = seq;
		await removeEach(be, replaced);
		return result;
	} finally {
		be.unlock();
	}
}

async function removeEach(be, names) {
	for (var i = 0; i < names.length; i++) { try { await be.remove(names[i]); } catch (e) { /* the next opening sweeps it */ } }
}

// ---- delete / keep ----

function removeWhere(store, sel, keepSelected, opts) {
	return queued(store, function () {
		checkSelection(store, sel);
		var removed = 0;
		return session(store, async function (put, m) {
			var len = m.recordLength;
			var keys = keepSelected ? Object.keys(m.nodes).sort(keyOrder) : Object.keys(sel.tiles).sort(keyOrder);
			var working = phase(opts && opts.onProgress, "edit", keys.length);
			for (var i = 0; i < keys.length; i++) {
				aborted(opts && opts.signal);
				working.tick(i);
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
				await put(key, records, columns, n.t.size);
			}
			working.finish();
			return { removed: removed };
		}, function (body) { body.deletes++; });
	});
}

/**
 * Delete the selected points. opts: signal (stops it between tiles: ABORTED, the store as it was), onProgress({ phase: "edit", done, total }) by tile.
 */
export function deletePoints(store, sel, opts) { return removeWhere(store, sel, false, opts); }

/** Keep only the selected points (opts as deletePoints). */
export function keepPoints(store, sel, opts) { return removeWhere(store, sel, true, opts); }

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
 * opts: signal (stops it between tiles: ABORTED, the store as it was), onProgress({ phase: "edit", done, total }) by tile.
 */
export function setColumn(store, sel, name, value, opts) {
	return queued(store, function () {
		checkSelection(store, sel);
		var m = store.manifest, added = m.columns.map(function (c) { return c.name; }), ai = added.indexOf(name);
		if (ai < 0 && !SETTABLE[name]) throw bad(name + " cannot be set on a tile store: classification, classificationFlags, intensity, userData, pointSourceId, red, green, blue or an added column");
		if (ai < 0 && (name === "red" || name === "green" || name === "blue") && recordFields(m.pointFormat).indexOf(name) < 0) throw bad(name + " cannot be set: point format " + m.pointFormat + " has no colour");
		var perTile = value !== null && typeof value === "object";
		var keys = Object.keys(sel.tiles).sort(keyOrder);
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
		return session(store, async function (put) {
			var working = phase(opts && opts.onProgress, "edit", keys.length);
			for (var t = 0; t < keys.length; t++) {
				aborted(opts && opts.signal);
				working.tick(t);
				var key = keys[t], idx = sel.tiles[key], n = ai >= 0 ? await readNodeColumns(store, key) : await readNode(store, key), want = perTile ? value[key] : null;
				var records = n.records, columns = n.t.columns;
				if (ai >= 0) {
					var col = columns[ai].slice(), big = EXTRA_TYPES[m.columns[ai].type].big;
					for (var i = 0; i < idx.length; i++) { var v = perTile ? want[i] : value; col[idx[i]] = big ? BigInt(v) : v; }
					columns = columns.slice();
					columns[ai] = col;
				} else records = patchField(store, records, name, idx, perTile ? want : null, value);
				await put(key, records, columns, n.t.size, ai >= 0 ? n : null);
			}
			working.finish();
		}, null);
	});
}

/**
 * Move points: value { key: { index (ascending), x, y, z } } in world coordinates (after the store transform). The
 * records take the store transform's inverse, then the scale and offset; each node's box is measured again.
 */
export function setPositions(store, value) {
	return queued(store, function () {
		var m = store.manifest;
		if (!value || typeof value !== "object") throw bad("positions must be { key: { index, x, y, z } }");
		var keys = Object.keys(value).sort(keyOrder), inv = m.transform ? invertTransform(m.transform) : null;
		keys.forEach(function (k) {
			var v = value[k], node = m.nodes[k];
			if (!node) throw bad("the positions name tile " + k + ", which is not in the store");
			if (!v || !v.index || !v.x || !v.y || !v.z || v.x.length !== v.index.length || v.y.length !== v.index.length || v.z.length !== v.index.length) throw bad("positions[" + k + "] must be { index, x, y, z } of one length");
			for (var i = 0; i < v.index.length; i++) if (!(v.index[i] < node.count) || (i && v.index[i] <= v.index[i - 1])) throw bad("positions[" + k + "].index " + v.index[i] + " is not an ascending point of the tile (" + node.count + " points)");
		});
		return session(store, async function (put) {
			for (var t = 0; t < keys.length; t++) {
				var key = keys[t], n = await readNode(store, key);
				await put(key, patchPositions(store, n.records, value[key], inv), n.t.columns, n.t.size, null);
			}
		}, null);
	});
}

// { m, t } inverted: m^-1, -m^-1 t
function invertTransform(T) {
	var a = T.m, det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
	var i = [(a[4] * a[8] - a[5] * a[7]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
		(a[5] * a[6] - a[3] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[2] * a[3] - a[0] * a[5]) / det,
		(a[3] * a[7] - a[4] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[0] * a[4] - a[1] * a[3]) / det];
	return { m: i, t: [0, 1, 2].map(function (r) { return -(i[3 * r] * T.t[0] + i[3 * r + 1] * T.t[1] + i[3 * r + 2] * T.t[2]); }) };
}

// a node's records with new positions (world, taken back through inv when the store is moved)
function patchPositions(store, records, v, inv) {
	var m = store.manifest, len = m.recordLength;
	var cols = decodeRecords(records, store.header, { fields: recordFields(m.pointFormat) });
	var so = { scale: m.scale, offset: m.offset };
	for (var i = 0; i < v.index.length; i++) {
		var p = v.index[i], x = v.x[i], y = v.y[i], z = v.z[i];
		if (inv) { var q = inv.m; cols.x[p] = q[0] * x + q[1] * y + q[2] * z + inv.t[0]; cols.y[p] = q[3] * x + q[4] * y + q[5] * z + inv.t[1]; cols.z[p] = q[6] * x + q[7] * y + q[8] * z + inv.t[2]; }
		else { cols.x[p] = x; cols.y[p] = y; cols.z[p] = z; }
	}
	// the X, Y, Z bytes only (12 of each record): every other field stays as stored
	var out = new Uint8Array(len * cols.count);
	encodeRecords(cols, m.pointFormat, len, so, null, new DataView(out.buffer), 0, { bounds: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }, byReturn: new Array(15).fill(0) }, 0, null);
	var res = records.slice();
	for (i = 0; i < v.index.length; i++) { var o = v.index[i] * len; res.set(out.subarray(o, o + 12), o); }
	return res;
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
export function addColumn(store, name, type, fill) {
	return queued(store, function () {
		var m = store.manifest;
		if (typeof name !== "string" || !name || name.length > 32 || /[^\x01-\xff]/.test(name)) throw bad("a column name is 1 to 32 characters, one byte each");
		var taken = Object.keys(FIELD_TYPES).concat(MORE_RESERVED, store.extraBytes.map(function (f) { return f.column; }), m.columns.map(function (c) { return c.name; }));
		if (taken.indexOf(name) >= 0) throw bad("the column name " + name + " is taken (a standard field, a reserved name, a file extra column or an added column)");
		if (!COLUMN_TYPES[type]) throw bad("type " + type + " is not one of u8, i8, u16, i16, u32, i32, u64, i64, f32, f64");
		if (fill === undefined) fill = 0;
		var f = checkTyped(type, fill, name, "fill");
		return session(store, async function (put) {
			var keys = Object.keys(m.nodes).sort(keyOrder);
			for (var i = 0; i < keys.length; i++) {
				var n = await readNodeColumns(store, keys[i]), col = new COLUMN_TYPES[type](n.t.count);
				col.fill(f);
				await put(keys[i], null, n.t.columns.concat([col]), n.t.size, n);
			}
		}, function (body) { body.columns.push({ name: name, type: type, fill: typeof f === "bigint" ? String(f) : f }); });
	});
}

/** Remove an added column from every node. */
export function removeColumn(store, name) {
	return queued(store, function () {
		var m = store.manifest, ai = m.columns.map(function (c) { return c.name; }).indexOf(name);
		if (ai < 0) throw bad("no added column " + name + " in the store");
		return session(store, async function (put) {
			var keys = Object.keys(m.nodes).sort(keyOrder);
			for (var i = 0; i < keys.length; i++) {
				var n = await readNodeColumns(store, keys[i]);
				await put(keys[i], null, n.t.columns.filter(function (c, j) { return j !== ai; }), n.t.size, n);
			}
		}, function (body) { body.columns.splice(ai, 1); });
	});
}

// ---- transform ----

/**
 * Compose a transform onto the store's: T after the one it has. No node is rewritten.
 */
export function transform(store, T) {
	return queued(store, function () {
		checkTransform(T, "transform");
		var old = store.manifest.transform, m = Array.from(T.m), t = Array.from(T.t);
		if (old) {
			var a = m, b = old.m, mm = [];
			for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) mm.push(a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c]);
			t = [0, 1, 2].map(function (r) { return a[3 * r] * old.t[0] + a[3 * r + 1] * old.t[1] + a[3 * r + 2] * old.t[2] + t[r]; });
			m = mm;
		}
		return session(store, async function () {}, function (body) { body.transform = { m: m, t: t }; });
	});
}
