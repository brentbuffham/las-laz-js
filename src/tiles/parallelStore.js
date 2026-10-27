// src/tiles/parallelStore.js
//==========================================================
// findFragmentsParallel and findFacetsParallel on a tile store: the
// cloud is never read whole. Work tiles are cut from the store's box
// on its two widest axes; each worker opens the store itself and reads
// its tile and the overlap at full density (regionJobs.js). This thread
// keeps one label a point, per node (4 bytes a point), the fragments or
// facets, and the plan grid. The labels come back per node
// ({ key: Uint32Array }, the node's point order), and with column they
// are written to the store as an added u32 column (where the store's
// edits run: a Worker for OPFS). A store in memory, or threads 1, runs
// its tiles here, one by one. Memory: this thread about 6.5 bytes a
// point (59.7 M points: 386 MB); each worker about 0.3 GB, so threads
// defaults to 8 here (59.7 M: 8 threads 119 s, 3 GB; 16 threads 86 s,
// 5.2 GB; 4 threads 175 s, 1.8 GB).
// Fragments: kept from the tile whose core holds the centroid; a core
// tile's claim on a point holds over another's; a copy across a seam
// left with under half its points goes. Facets: each point takes its
// core tile's facet; pieces of one face in neighbouring tiles meet in
// a seam cell (maxDistance wide along the shared core edge) within
// maxAngle and twice the plane distance, and are joined; a joined facet
// is measured from its pieces' plane sums, its area their areas' sum,
// its outline the largest piece's (all in outlineParts).
//==========================================================

import { LasError, ERROR_CODES } from "../errors.js";
import { createLazPool, defaultThreads } from "../laz/pool.js";
import { storeNodes, nodesMeeting, readRegion } from "./region.js";
import { fragmentsRegion, facetsRegion } from "./regionJobs.js";
import { pointSpacing } from "../fragments/spacing.js";
import { resultFields } from "../fragments/resolution.js";
import { estimateNoise, smallestEigen } from "../ops/normals.js";
import { checkFacetOptions } from "../facets/findFacets.js";
import { poleOf, orientationOf } from "../facets/orientation.js";

var STORE_THREADS = 8, SAMPLE_POINTS = 200000, SAMPLE_MIN = 1000, TILE_POINTS = 500000, CELL_SPACINGS = 1.5, MAX_CELLS = 6e7, D = Math.PI / 180;
var MIN = ["minX", "minY", "minZ"], MAX = ["maxX", "maxY", "maxZ"];
var FACET_ONLY = ["maxDistance", "k", "normals", "facetOptions", "concaveAngle", "surfaceDistance", "viewpoint", "fill", "fillDistance"];
var STRIP = ["onProgress", "signal", "threads", "tile", "overlap", "normals", "keepNormals", "column", "localOrigin", "tilePoints"];

function bad(message) { return new LasError(ERROR_CODES.INVALID_ARGUMENT, message); }
function stopped() { return new LasError(ERROR_CODES.ABORTED, "the run was stopped"); }
function strip(opts) { var o = {}; Object.keys(opts).forEach(function (k) { if (STRIP.indexOf(k) < 0) o[k] = opts[k]; }); return o; }

/** Whether a parallel run's first argument is a tile store rather than point columns. */
export function isTileStore(x) { return !!x && typeof x === "object" && !!x.manifest && typeof x.readTile === "function"; }

// the run's frame and tiles: the store's box, its two widest axes, the origin, the spacing sample, the cores
async function layout(store, opts, threads, M) {
	var nodes = storeNodes(store.manifest), n = 0, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	nodes.counts.forEach(function (c) { n += c; });
	nodes.boxes.forEach(function (b) { for (var a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b[MIN[a]]); hi[a] = Math.max(hi[a], b[MAX[a]]); } });
	if (!n) return { n: 0, nodes: nodes };
	var axes = [0, 1, 2].sort(function (p, q) { return (hi[q] - lo[q]) - (hi[p] - lo[p]); }).slice(0, 2);
	var origin = opts.localOrigin || { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 };
	var u0 = lo[axes[0]], v0 = lo[axes[1]], du = Math.max(hi[axes[0]] - u0, 1e-9), dv = Math.max(hi[axes[1]] - v0, 1e-9);
	// samples at full density in a 3 x 3 spread: the spacing is their median (one patch reads a scan's local density,
	// not its own); the middle one (or the fullest) for the plane distance
	var side = Math.sqrt(du * dv * Math.min(1, SAMPLE_POINTS / 9 / n)), spacings = [], sample = null;
	for (var sv = 1; sv <= 5; sv += 2) for (var su = 1; su <= 5; su += 2) {
		var cu = u0 + du * su / 6, cv = v0 + dv * sv / 6, sbox = [cu - side / 2, cu + side / 2, cv - side / 2, cv + side / 2];
		var part = await readRegion(store, nodes.keys, nodesMeeting(nodes, axes, sbox), axes, sbox, origin);
		if (part.count >= SAMPLE_MIN) spacings.push(pointSpacing(part));
		if (!sample || (su === 3 && sv === 3 && part.count >= SAMPLE_MIN) || part.count > sample.count && !(sample.count >= SAMPLE_MIN)) sample = part;
	}
	spacings = spacings.filter(function (s) { return s > 0; }).sort(function (p, q) { return p - q; });
	var spacing = spacings.length ? spacings[Math.floor((spacings.length - 1) / 2)] : NaN;
	var tilePoints = opts.tilePoints === undefined ? TILE_POINTS : opts.tilePoints;
	if (!(tilePoints > 0)) throw bad("tilePoints must be a positive number, not " + JSON.stringify(opts.tilePoints));
	var T = opts.tile !== undefined ? opts.tile : Math.max(4 * M, Math.min(Math.sqrt(du * dv / (2 * threads)), Math.sqrt(du * dv * tilePoints / n)));
	var NU = Math.max(1, Math.ceil(du / T)), NV = Math.max(1, Math.ceil(dv / T)), tiles = [];
	for (var tv = 0; tv < NV; tv++) for (var tu = 0; tu < NU; tu++) {
		var core = [tu ? u0 + tu * T : -Infinity, tu < NU - 1 ? u0 + (tu + 1) * T : Infinity, tv ? v0 + tv * T : -Infinity, tv < NV - 1 ? v0 + (tv + 1) * T : Infinity];
		var box = [Math.max(u0, u0 + tu * T) - M, Math.min(u0 + du, u0 + (tu + 1) * T) + M, Math.max(v0, v0 + tv * T) - M, Math.min(v0 + dv, v0 + (tv + 1) * T) + M];
		var which = nodesMeeting(nodes, axes, box), w = 0;
		which.forEach(function (i) { w += nodes.counts[i]; });
		tiles.push({ tu: tu, tv: tv, core: core, box: box, which: which, weight: w });
	}
	return { n: n, nodes: nodes, axes: axes, origin: origin, u0: u0, v0: v0, du: du, dv: dv, T: T, NU: NU, NV: NV, tiles: tiles, sample: sample, spacing: spacing };
}

// run every tile: in the pool (the store opened in each worker), or here; apply(result, tile number) as each ends
async function runAll(store, L, opts, threads, op, task, apply) {
	var where = store.where, shareable = where && (where.opfs !== undefined || where.dir !== undefined), signal = opts.signal;
	var pool = threads > 1 && shareable && L.tiles.length > 1 ? await createLazPool(Math.min(threads, L.tiles.length)) : null;
	var share = new Float64Array(L.tiles.length), total = 0, last = -1, run = Math.random().toString(36).slice(2);
	L.tiles.forEach(function (t) { total += t.weight; });
	function report(i, f) {
		share[i] = Math.max(share[i], Math.min(1, f));
		if (!opts.onProgress) return;
		var done = 0;
		for (var k = 0; k < share.length; k++) done += share[k] * L.tiles[k].weight;
		if (done - last >= 0.01 * total || done >= total) { last = done; opts.onProgress(done, total); }
	}
	if (opts.onProgress) opts.onProgress(0, total);
	var abort = function () { if (pool) pool.close(); };
	if (signal) signal.addEventListener("abort", abort);
	try {
		if (pool) {
			await Promise.all(L.tiles.map(function (t, i) {
				return pool.region(op, Object.assign(task(t), { keys: L.nodes.keys }), where, run, function (f) { report(i, f); }).then(function (r) { apply(r, i); report(i, 1); });
			}));
		} else {
			for (var i = 0; i < L.tiles.length; i++) {
				if (signal && signal.aborted) throw stopped();
				var t = Object.assign(task(L.tiles[i]), { keys: L.nodes.keys }), k = i;
				t.onProgress = function (d, n) { report(k, n ? d / n : 1); };
				apply(await (op === "fragmentsRegion" ? fragmentsRegion : facetsRegion)(store, t), i);
				report(i, 1);
			}
		}
		if (signal && signal.aborted) throw stopped();
		return pool ? Math.min(threads, L.tiles.length) : 1;
	} catch (err) {
		throw signal && signal.aborted ? stopped() : err;
	} finally {
		if (signal) signal.removeEventListener("abort", abort);
		if (pool) pool.close();
	}
}

function labelArrays(L) { return L.nodes.counts.map(function (c) { return new Uint32Array(c); }); }
function byTile(L, labels) { var out = {}; L.nodes.keys.forEach(function (k, i) { out[k] = labels[i]; }); return out; }

// the labels as an added u32 column of the store (made, or set again)
async function writeColumn(store, name, out) {
	var has = store.manifest.columns.filter(function (c) { return c.name === name; })[0];
	if (has && has.type !== "u32") throw bad("column " + name + " is taken by an added " + has.type + " column; give another name");
	if (!has) await store.addColumn(name, "u32", 0);   // refuses a name a standard field or the file's extra bytes hold
	var sel = { deletes: store.manifest.deletes, count: 0, tiles: {} };
	Object.keys(out).forEach(function (k) {
		var idx = new Uint32Array(out[k].length);
		for (var i = 0; i < idx.length; i++) idx[i] = i;
		sel.tiles[k] = idx; sel.count += idx.length;
	});
	await store.setColumn(sel, name, out);
}

async function common(store, opts, name) {
	if (opts === undefined || opts === null || typeof opts !== "object") throw bad(name + " needs options");
	// each worker's heap grows to about 0.3 GB on a run and keeps it: 8 by default (about 3 GB), more when asked
	var threads = opts.threads === undefined ? Math.min(STORE_THREADS, await defaultThreads()) : opts.threads;
	if (!Number.isInteger(threads) || threads < 1) throw bad("threads must be a whole number >= 1, not " + JSON.stringify(opts.threads));
	if (opts.tile !== undefined && !(typeof opts.tile === "number" && opts.tile > 0 && isFinite(opts.tile))) throw bad("tile must be a positive distance, not " + JSON.stringify(opts.tile));
	if (opts.column !== undefined && (typeof opts.column !== "string" || !opts.column)) throw bad("column must be a column name, not " + JSON.stringify(opts.column));
	if (opts.normals !== undefined) throw bad("normals cannot be given for a run on a tile store (each tile makes its own)");
	if (opts.signal && opts.signal.aborted) throw stopped();
	return threads;
}

/**
 * findFragmentsParallel on a tile store (see the banner).
 * @param {object} store - an open TileStore.
 * @param {object} opts - findFragments' options, and threads, tile, overlap, tilePoints (about how many points a tile's core
 *   holds, default 500,000: each worker holds its tile and the overlap, about 100 bytes a point while it runs), localOrigin (the frame of the results; default the store box's centre), column (write the
 *   labels to this added column), onProgress, signal.
 * @returns {Promise<object>} findFragments' result without fragment (its labels are byTile: { key: Uint32Array })
 *   plus origin, tiles, threads; facets null.
 */
export async function fragmentsOnStore(store, opts) {
	var threads = await common(store, opts, "findFragmentsParallel"), method = opts.method === undefined ? "facets" : opts.method;
	var rr = opts.reliefRadius === undefined ? 1 : opts.reliefRadius;
	var M = opts.overlap === undefined ? Math.max(2.5, rr + 1.5) : opts.overlap;
	if (!(typeof M === "number" && M >= 0 && isFinite(M))) throw bad("overlap must be a distance >= 0, not " + JSON.stringify(opts.overlap));
	var L = await layout(store, opts, threads, M);
	if (!L.n) return resultFields({ byTile: {}, fragments: [], surfaceArea: 0, unassignedArea: 0, method: method, facets: null, planeDistance: NaN, origin: null, tiles: 0, threads: 1 }, NaN, {});
	var spacing = opts.spacing !== undefined ? opts.spacing : L.spacing;
	if (!(spacing > 0)) throw bad("the store is too sparse to measure its point spacing; give spacing");
	var px = CELL_SPACINGS * spacing, GW = Math.floor(L.du / px) + 1, GH = Math.floor(L.dv / px) + 1;
	while (GW * GH > MAX_CELLS) { px *= 2; GW = Math.floor(L.du / px) + 1; GH = Math.floor(L.dv / px) + 1; }
	var grid = { px: px, u0: L.u0, v0: L.v0, W: GW, H: GH }, hit = new Uint8Array(GW * GH), held = new Uint8Array(GW * GH);
	var labels = labelArrays(L), kept = [], planeDistances = [], cell = NaN, sideOn = false, tileOpts = Object.assign(strip(opts), { spacing: spacing });
	var ran = await runAll(store, L, opts, threads, "fragmentsRegion", function (t) {
		return { which: t.which, axes: L.axes, box: t.box, core: t.core, origin: L.origin, opts: tileOpts, grid: grid };
	}, function (r) {
		var base = kept.length;
		r.kept.forEach(function (f) { kept.push(f); });
		for (var q = 0; q < r.gid.length; q++) {
			var lab = labels[r.node[q]], ix = r.index[q];
			if (r.core[q] || !lab[ix]) lab[ix] = base + r.gid[q];   // a core tile's claim holds over another's
		}
		if (r.win) for (var wv = 0; wv < r.win.H; wv++) for (var wu = 0; wu < r.win.W; wu++) {
			var c = r.win.hit[wv * r.win.W + wu];
			if (!c) continue;
			var g = (r.win.v0 + wv) * GW + r.win.u0 + wu;
			hit[g] = 1; if (r.win.held[wv * r.win.W + wu]) held[g] = 1;
		}
		if (r.planeDistance > 0) planeDistances.push(r.planeDistance);
		if (r.cell > 0) cell = r.cell;
		if (r.sideOn) sideOn = true;
	});
	// copies across a seam: a fragment left with under half its points goes; then ids by size
	var have = new Uint32Array(kept.length + 1), i, k;
	labels.forEach(function (lab) { for (var j = 0; j < lab.length; j++) if (lab[j]) have[lab[j]]++; });
	var live = [];
	kept.forEach(function (f, q) { if (have[q + 1] >= 0.5 * f.count) live.push({ f: f, g: q + 1 }); });
	live.sort(function (p, q) { return q.f.size - p.f.size || q.f.count - p.f.count || p.g - q.g; });
	var newId = new Uint32Array(kept.length + 1), fragments = live.map(function (e, q) { newId[e.g] = q + 1; return Object.assign({}, e.f, { id: q + 1 }); });
	labels.forEach(function (lab) { for (var j = 0; j < lab.length; j++) if (lab[j]) lab[j] = newId[lab[j]]; });
	var cells = 0, none = 0;
	for (k = 0; k < hit.length; k++) if (hit[k]) { cells++; if (!held[k]) none++; }
	planeDistances.sort(function (p, q) { return p - q; });
	var out = { byTile: byTile(L, labels), fragments: fragments, surfaceArea: cells * px * px, unassignedArea: none * px * px, method: method, facets: null,
		planeDistance: planeDistances.length ? planeDistances[Math.floor((planeDistances.length - 1) / 2)] : NaN, origin: L.origin };
	if (method !== "facets") out.cell = cell;
	if (method === "hybrid") { out.fromWatershed = 0; for (i = 0; i < fragments.length; i++) if (fragments[i].from === "watershed") out.fromWatershed++; out.fromFacets = fragments.length - out.fromWatershed; }
	var given = { sideOn: sideOn };
	if (method !== "watershed" && opts.maxDistance !== undefined) given.maxDistance = opts.maxDistance;
	if (method === "watershed") given.ignored = FACET_ONLY.filter(function (key) { return opts[key] !== undefined; });
	if (opts.column) await writeColumn(store, opts.column, out.byTile);
	return Object.assign(resultFields(out, spacing, given), { tiles: L.tiles.length, threads: ran });
}

/**
 * findFacetsParallel on a tile store (see the banner).
 * @param {object} store - an open TileStore.
 * @param {object} opts - findFacets' options, and threads, tile, overlap, tilePoints, localOrigin, column, onProgress,
 *   signal.
 * @returns {Promise<object>} findFacets' result without facet (byTile: { key: Uint32Array }) plus origin, tiles,
 *   threads; a joined facet has outlineParts.
 */
export async function facetsOnStore(store, opts) {
	var threads = await common(store, opts, "findFacetsParallel");
	var o = checkFacetOptions({ count: 0, x: [], y: [], z: [] }, Object.assign({}, opts, { normals: undefined }));
	var M = opts.overlap === undefined ? Math.max(0.5, 5 * o.maxDistance) : opts.overlap;
	if (!(typeof M === "number" && M >= 0 && isFinite(M))) throw bad("overlap must be a distance >= 0, not " + JSON.stringify(opts.overlap));
	var L = await layout(store, opts, threads, M);
	if (!L.n) return { byTile: {}, facets: [], planeDistance: NaN, origin: null, tiles: 0, threads: 1 };
	var pd = o.planeDistance;
	if (pd === undefined) { var noise = estimateNoise(L.sample, { k: o.k, maxDistance: o.maxDistance }); pd = noise > 0 ? 3 * noise : o.maxDistance / 10; }
	var tileOpts = Object.assign(strip(opts), { planeDistance: pd }), labels = labelArrays(L), pieces = [], ofTile = [];
	var ran = await runAll(store, L, opts, threads, "facetsRegion", function (t) {
		return { which: t.which, axes: L.axes, box: t.box, core: t.core, origin: L.origin, opts: tileOpts, seam: o.maxDistance };
	}, function (r, ti) {
		var base = pieces.length;
		for (var f = 1; f < r.parts.length; f++) pieces.push({ facet: r.facets[f - 1], part: r.parts[f], tile: ti });
		ofTile[ti] = { base: base, n: r.parts.length - 1 };
		for (var q = 0; q < r.fid.length; q++) labels[r.node[q]][r.index[q]] = base + r.fid[q];
	});
	// join the pieces of one face across each shared core edge (east, north)
	var parent = new Uint32Array(pieces.length + 1), cosA = Math.cos(o.maxAngle * D), i, j;
	for (i = 0; i <= pieces.length; i++) parent[i] = i;
	function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
	function join(ta, tb, ea, eb) {
		if (!ofTile[ta] || !ofTile[tb]) return;
		var cells = new Map(), A = ofTile[ta], B = ofTile[tb];
		for (j = 1; j <= B.n; j++) {
			var sb = pieces[B.base + j - 1].part.seams[eb];
			for (var s = 0; s < sb.length; s += 5) { var list = cells.get(sb[s]); if (!list) cells.set(sb[s], list = []); list.push([B.base + j, sb[s + 1], sb[s + 2], sb[s + 3]]); }
		}
		for (j = 1; j <= A.n; j++) {
			var pa = pieces[A.base + j - 1], sa = pa.part.seams[ea], na = pa.facet.normal;
			for (var t = 0; t < sa.length; t += 5) for (var dc = -1; dc <= 1; dc++) {
				var hits = cells.get(sa[t] + dc);
				if (!hits) continue;
				hits.forEach(function (h) {
					var nb = pieces[h[0] - 1].facet.normal;
					if (Math.abs(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]) < cosA) return;
					if (Math.abs(na[0] * (h[1] - sa[t + 1]) + na[1] * (h[2] - sa[t + 2]) + na[2] * (h[3] - sa[t + 3])) > 2 * pd) return;
					var ra = find(A.base + j), rb = find(h[0]);
					if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
				});
			}
		}
	}
	for (var tv = 0; tv < L.NV; tv++) for (var tu = 0; tu < L.NU; tu++) {
		var ti = tv * L.NU + tu;
		if (tu + 1 < L.NU) join(ti, ti + 1, "u1", "u0");
		if (tv + 1 < L.NV) join(ti, ti + L.NU, "v1", "v0");
	}
	// the joined facets: one piece whole is its tile's facet; else measured from the pieces' sums
	var groups = new Map();
	for (i = 1; i <= pieces.length; i++) { if (!pieces[i - 1].part.count) continue; var rt = find(i), gr = groups.get(rt); if (!gr) groups.set(rt, gr = []); gr.push(i); }
	var found = [], cov = new Float64Array(6), eig = new Float64Array(5);
	groups.forEach(function (ids, rt) {
		if (ids.length === 1 && pieces[ids[0] - 1].part.whole) { found.push({ rt: rt, f: Object.assign({}, pieces[ids[0] - 1].facet) }); return; }
		var c = 0, S = [0, 0, 0, 0, 0, 0, 0, 0, 0], area = 0, parts = [], big = null;
		ids.forEach(function (id) {
			var p = pieces[id - 1].part;
			c += p.count; for (var q = 0; q < 9; q++) S[q] += p.sums[q]; area += p.area;
			var ol = p.whole ? pieces[id - 1].facet.outline : p.outline;
			if (ol) { parts.push(ol); if (!big || p.area > big.area) big = { area: p.area, outline: ol }; }
		});
		if (c < o.minPoints || area < o.minArea) return;
		var cx = S[0] / c, cy = S[1] / c, cz = S[2] / c;
		cov[0] = S[3] / c - cx * cx; cov[1] = S[4] / c - cx * cy; cov[2] = S[5] / c - cx * cz; cov[3] = S[6] / c - cy * cy; cov[4] = S[7] / c - cy * cz; cov[5] = S[8] / c - cz * cz;
		if (!smallestEigen(cov, eig)) return;
		var nrm = poleOf([eig[0], eig[1], eig[2]]), or = orientationOf(nrm);
		found.push({ rt: rt, f: { count: c, normal: nrm, centroid: [cx, cy, cz], dip: or.dip, dipDirection: or.dipDirection, area: area, rms: Math.sqrt(Math.max(0, eig[3])), outline: big ? big.outline : new Float64Array(0), outlineParts: parts } });
	});
	found.sort(function (a, b) { return b.f.area - a.f.area || a.rt - b.rt; });
	var idOf = new Uint32Array(pieces.length + 1);
	var facets = found.map(function (e, w) { idOf[e.rt] = w + 1; return Object.assign(e.f, { id: w + 1 }); });
	labels.forEach(function (lab) { for (var q = 0; q < lab.length; q++) if (lab[q]) lab[q] = idOf[find(lab[q])]; });
	var out = { byTile: byTile(L, labels), facets: facets, planeDistance: pd, origin: L.origin, tiles: L.tiles.length, threads: ran };
	if (opts.column) await writeColumn(store, opts.column, out.byTile);
	return out;
}
