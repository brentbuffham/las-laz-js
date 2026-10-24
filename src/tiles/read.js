// src/tiles/read.js
//==========================================================
// Loading a node as point columns, as readPoints gives them: the
// node's records through decodeRecords (record × scale + offset → the
// store transform → minus localOrigin → Float32 when asked), with the
// added columns attached by name. LAZ nodes decode on this thread, or
// on the store's pool for readTiles (started once, kept for later calls,
// closed by store.close()).
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { decodeRecords } from "../read/decodeRecords.js";
import { createChunkDecoder } from "../laz/decompressChunk.js";
import { createLazPool, defaultThreads } from "../laz/pool.js";
import { decodeTile } from "./tileFile.js";
import { tileName } from "./TileStore.js";

/**
 * A node's tile, decoded from its file (records raw: LAZ nodes are left packed), with size, the
 * file's byte length. An edit that commits while the file is read moves the node to its next
 * generation and removes this one: the read follows it.
 * @returns {Promise<{count, records, compressed, columns, size}>}
 * @throws {LasError} INVALID_ARGUMENT for a key not in the store; BAD_STORE for a missing or damaged file
 */
export async function loadTile(store, key) {
	for (;;) {
		var m = store.manifest, node = m.nodes[key];
		if (!node) throw new LasError(ERROR_CODES.INVALID_ARGUMENT, "no tile " + key + " in the store");
		var name = tileName(key, node.gen), bytes = await store._backend.get(name);
		if (!bytes) {
			if (store.manifest !== m) continue;   // an edit on this store moved it on: read the new one
			throw new LasError(ERROR_CODES.BAD_STORE, "tile file " + name + " is missing from the store (changed in another tab or worker? open it again)");
		}
		var t = decodeTile(bytes, m.columns.map(function (c) { return c.type; }), name);
		t.size = bytes.length;
		return t;
	}
}

/** A tile's raw records, decompressed on this thread when packed. */
export function rawRecords(store, t) {
	if (!t.compressed) return t.records;
	var m = store.manifest, out = new Uint8Array(t.count * m.recordLength);
	if (t.count) createChunkDecoder(m.laz, m.recordLength)(t.records, 0, t.records.length, t.count, new DataView(out.buffer), 0, 0);
	return out;
}

// The fields decodeRecords reads, and the added columns to attach
function splitFields(store, fields) {
	var added = store.manifest.columns.map(function (c) { return c.name; });
	if (!fields) return { record: undefined, added: [] };
	var record = [], want = [];
	fields.forEach(function (f) {
		if (added.indexOf(f) >= 0) { if (want.indexOf(f) < 0) want.push(f); }
		else record.push(f);
		if (f === "extra") added.forEach(function (a) { if (want.indexOf(a) < 0) want.push(a); });
	});
	return { record: record, added: want };
}

/** Columns from a tile's raw records and its added columns. */
export function columnsOf(store, t, records, opts) {
	opts = opts || {};
	var f = splitFields(store, opts.fields);
	var cols = decodeRecords(records, store.header, {
		fields: f.record, localOrigin: opts.localOrigin, float32: opts.float32,
		transform: store.manifest.transform || undefined, extraBytes: store.extraBytes
	});
	var names = store.manifest.columns.map(function (c) { return c.name; });
	f.added.forEach(function (name) { cols[name] = t.columns[names.indexOf(name)]; });
	return cols;
}

/**
 * One node as point columns.
 * @param {object} store - a TileStore
 * @param {string} key
 * @param {{fields?: string[], localOrigin?: object, float32?: boolean}} [opts]
 * @returns {Promise<object>} PointColumns
 */
export async function readTile(store, key, opts) {
	var t = await loadTile(store, key);
	return columnsOf(store, t, rawRecords(store, t), opts);
}

/**
 * Nodes as point columns, in the order given; LAZ nodes decode on a pool when threads is not 1
 * and there are two or more.
 * @param {object} store
 * @param {string[]} keys
 * @param {{fields?, localOrigin?, float32?, threads?: number}} [opts]
 * @returns {AsyncGenerator<{key: string, points: object}>}
 */
export async function* readTiles(store, keys, opts) {
	opts = opts || {};
	var m = store.manifest, pool = null;
	if (m.laz && opts.threads !== 1 && keys.length >= 2) pool = await storePool(store, opts.threads > 0 ? Math.floor(opts.threads) : 0);
	{
		if (!pool) {
			for (var i = 0; i < keys.length; i++) yield { key: keys[i], points: await readTile(store, keys[i], opts) };
			return;
		}
		// up to pool.size nodes decoding ahead of the one handed out
		var ahead = [], next = 0;
		var start = function () {
			var key = keys[next++];
			var job = loadTile(store, key).then(function (t) {
				if (!t.count) return { t: t, records: new Uint8Array(0) };
				return pool.decode({ vlr: m.laz, recordLength: m.recordLength, packed: t.records.slice().buffer, chunks: [{ s: 0, e: t.records.length, count: t.count }], base: 0 })
					.then(function (records) { return { t: t, records: records }; });
			});
			job.catch(function () {});
			ahead.push({ key: key, job: job });
		};
		while (next < keys.length && ahead.length < pool.size) start();
		while (ahead.length) {
			var head = ahead.shift(), got = await head.job;
			if (next < keys.length) start();
			yield { key: head.key, points: columnsOf(store, got.t, got.records, opts) };
		}
	}
}

// The store's decode pool: started on first use (n workers, or the default when n is 0) and
// kept, as a view loads tiles again and again; a different n starts a new one
async function storePool(store, n) {
	var want = n || await defaultThreads();
	if (want < 2) return null;
	if (store._pool && store._poolSize === want) return store._pool;
	if (store._pool) store._pool.close();
	store._pool = await createLazPool(want);
	store._poolSize = want;
	return store._pool;
}
