// src/tiles/write.js
//==========================================================
// A tile store written out as LAS / LAZ through createLasWriter, node
// by node in key order (LAZ nodes decoded on the store's pool), never
// the whole cloud in memory. The source's
// version, point format, scale and offset, CRS, class names and extra
// bytes, plus the added columns as extra bytes. A transformed store
// keeps the source's scale with an offset chosen from the moved
// bounds. Points come out in tile order.
//==========================================================

import { createLasWriter } from "../write/writeLas.js";
import { chooseScaleOffset } from "../write/scaleOffset.js";
import { transformBounds } from "../ops/transform.js";
import { recordFields } from "../read/decodeRecords.js";
import { readTiles } from "./read.js";

function keyOrder(a, b) {
	var p = a.split("-").map(Number), q = b.split("-").map(Number);
	for (var i = 0; i < 4; i++) if (p[i] !== q[i]) return p[i] - q[i];
	return 0;
}

/**
 * Write the store to a sink.
 * @param {object} store - a TileStore
 * @param {object} sink - as createLasWriter: an OPFS scratch writer, a Node FileHandle, or any { write(bytes, position) }
 * @param {{compress?: boolean, chunkSize?: number, threads?: number, version?: string, pointFormat?: number}} [opts]
 * @returns {Promise<{count: number}>}
 */
export async function writeTilesLas(store, sink, opts) {
	opts = opts || {};
	var m = store.manifest, h = store.header;
	var fmt = opts.pointFormat === undefined ? m.pointFormat : opts.pointFormat;
	var scale = m.scale, offset = m.offset;
	if (m.transform) {
		var b = transformBounds(m.transform, h.bounds);
		offset = chooseScaleOffset(b).offset;
	}
	var crs;
	if (store.crs && (store.crs.wkt || (store.crs.epsg && fmt < 6))) crs = { wkt: store.crs.wkt, epsg: store.crs.epsg };
	var extra = store.extraBytes.concat(m.columns.map(function (c) { return { name: c.name, type: c.type }; }));
	var w = await createLasWriter(sink, {
		version: opts.version || h.versionMajor + "." + h.versionMinor, pointFormat: fmt, scale: scale, offset: offset,
		crs: crs, classNames: Object.keys(store.classNames).length ? store.classNames : undefined,
		extraBytes: extra.length ? extra : undefined, compress: !!opts.compress, chunkSize: opts.chunkSize, threads: opts.threads
	});
	var fields = recordFields(m.pointFormat).concat(["extra"]);
	var keys = Object.keys(m.nodes).sort(keyOrder).filter(function (k) { return m.nodes[k].count > 0; });
	// LAZ nodes decode on the store's pool, ahead of the writer
	for await (var t of readTiles(store, keys, { fields: fields, threads: opts.threads })) await w.writePoints(t.points);
	return w.close();
}
