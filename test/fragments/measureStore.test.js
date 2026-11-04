// test/fragments/measureStore.test.js
//==========================================================
// measureFragmentsOnStore: a fragments run on a UTM-scale tile store
// carries measure and a plan box per rock; with no edit, a rock is its
// run record to the digit (a watershed rock no seam trimmed) and the
// areas do not move; a split and a send-to-fines measured from the
// nodes in box give the areas a whole count gives after the edit is
// written; a hybrid's facet rocks; minPoints; bad inputs. Synthetic.
//==========================================================
/* prettier-ignore-file */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLas, writeLas, buildTiles, findFragmentsParallel, measureFragments, measureFragmentsOnStore, FRAGMENT_REMOVED } from "../../src/index.js";
import { rockPile } from "../helpers/rocks.js";

var E = 478000, N = 6771000, H = 240;
var PILE = rockPile({ count: 30, swebrec: { x50: 0.5, xmax: 1.2, b: 2 }, extent: 8, spacing: 0.02, noise: 0.002, seed: 4, fines: "pebbles" });
var OPTS = { tile: 3, overlap: 1.5, threads: 1 };

async function storeOf() {
	var n = PILE.cols.count, c = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
	for (var i = 0; i < n; i++) { c.x[i] = PILE.cols.x[i] + E; c.y[i] = PILE.cols.y[i] + N; c.z[i] = PILE.cols.z[i] + H; }
	var bytes = await writeLas(c, { scale: { x: 0.001, y: 0.001, z: 0.001 } });
	return buildTiles(await openLas(bytes), { where: { memory: new Map() }, tilePoints: 20000, replace: true });
}
// every point's label and plan position (world), node by node
async function labelsOf(store, col) {
	var out = [];
	for (var k of Object.keys(store.manifest.nodes).filter(function (k) { return store.manifest.nodes[k].count > 0; }).sort()) {
		var p = await store.readTile(k, { fields: ["x", "y", "z", col] });
		out.push({ key: k, x: p.x, y: p.y, lab: p[col] });
	}
	return out;
}
// a store selection of the points passing test(label, x, y)
function selectWhere(store, nodes, test) {
	var sel = { deletes: store.manifest.deletes, count: 0, tiles: {} };
	nodes.forEach(function (nd) {
		var idx = [];
		for (var i = 0; i < nd.lab.length; i++) if (test(nd.lab[i], nd.x[i], nd.y[i])) idx.push(i);
		if (idx.length) { sel.tiles[nd.key] = Uint32Array.from(idx); sel.count += idx.length; }
	});
	return sel;
}
function union(a, b) { return [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])]; }
function same(got, want, label) {
	["id", "count", "size", "area"].forEach(function (key) { assert.equal(got[key], want[key], label + " " + key); });
	["centroid", "normal", "axes"].forEach(function (key) { assert.deepEqual(got[key], want[key], label + " " + key); });
	assert.deepEqual(Array.from(got.outline), Array.from(want.outline), label + " outline");
}

var cache = {};
async function run(method) {
	if (!cache[method]) {
		var store = await storeOf();
		cache[method] = { store: store, fr: await findFragmentsParallel(store, Object.assign({ method: method, column: "rock" }, OPTS)) };
	}
	return cache[method];
}

test("a store run carries measure and each rock's plan box", async function () {
	var r = await run("watershed"), fr = r.fr, m = fr.measure;
	assert.equal(m.method, "watershed");
	assert.ok(m.areas.world && m.areas.px > 0 && m.areas.W > 0 && m.cell > 0);
	assert.deepEqual(m.origin, fr.origin);
	fr.fragments.forEach(function (f) {
		assert.equal(f.box.length, 4);
		// the box holds the centroid (local + origin)
		assert.ok(f.box[0] <= f.centroid[0] + m.origin.x && f.centroid[0] + m.origin.x <= f.box[1] && f.box[2] <= f.centroid[1] + m.origin.y && f.centroid[1] + m.origin.y <= f.box[3], "rock " + f.id);
	});
	// a store run's measure is refused in memory, and the other way round
	assert.throws(function () { measureFragments(PILE.cols, new Uint32Array(PILE.cols.count), { measure: m }); }, /measureFragmentsOnStore/);
});

test("no edit: rocks are their run records to the digit, the areas do not move", async function () {
	var r = await run("watershed"), fr = r.fr, nodes = await labelsOf(r.store, "rock");
	var have = new Map();
	nodes.forEach(function (nd) { for (var i = 0; i < nd.lab.length; i++) if (nd.lab[i]) have.set(nd.lab[i], (have.get(nd.lab[i]) || 0) + 1); });
	// rocks no seam trimmed: every point of the tile's record still labelled
	var whole = fr.fragments.filter(function (f) { return have.get(f.id) === f.count; });
	assert.ok(whole.length >= 0.8 * fr.fragments.length, whole.length + " of " + fr.fragments.length);
	var pick = whole.slice(0, 6), box = pick.reduce(function (b, f) { return union(b, f.box); }, pick[0].box);
	var seen = [];
	// measure as Kirra posts it from its worker: through JSON (NaN comes back null)
	var m = await measureFragmentsOnStore(r.store, { column: "rock", measure: JSON.parse(JSON.stringify(fr.measure)), ids: pick.map(function (f) { return f.id; }), box: box, areas: fr,
		onProgress: function (d, t) { seen.push([d, t]); } });
	m.fragments.forEach(function (f, q) { same(f, pick[q], "rock " + f.id); assert.deepEqual(f.box, pick[q].box); assert.equal(f.small, false); });
	assert.equal(m.surfaceArea, fr.surfaceArea);
	assert.equal(m.unassignedArea, fr.unassignedArea);
	assert.deepEqual([m.gone, m.tooSmall], [[], []]);
	assert.equal(seen[seen.length - 1][0], seen[seen.length - 1][1]);
});

test("a split and a send-to-fines from the nodes in box: the areas a whole count gives after writing", async function () {
	var store = await storeOf(), fr = await findFragmentsParallel(store, Object.assign({ method: "watershed", column: "rock" }, OPTS)), ms = fr.measure;
	var nodes = await labelsOf(store, "rock"), A = fr.fragments[0], B = fr.fragments[3], cx = A.centroid[0] + ms.origin.x;
	var before = await measureFragmentsOnStore(store, { column: "rock", measure: ms, ids: [] });   // the whole store counted
	assert.ok(Math.abs(before.surfaceArea - fr.surfaceArea) <= 0.01 * fr.surfaceArea, before.surfaceArea + " vs " + fr.surfaceArea);
	// split A across its centroid (east half to 900), B to fines
	var east = selectWhere(store, nodes, function (l, x) { return l === A.id && x > cx; }), toFines = selectWhere(store, nodes, function (l) { return l === B.id; });
	var changes = [{ selection: east, label: 900 }, { selection: toFines, label: 0 }];
	var box = union(A.box, B.box);
	var m = await measureFragmentsOnStore(store, { column: "rock", measure: ms, ids: [A.id, 900, B.id], changes: changes, box: box, areas: before });
	assert.deepEqual(m.fragments.map(function (f) { return f.id; }), [A.id, 900]);
	assert.deepEqual(m.gone, [B.id]);
	assert.equal(m.fragments[0].count + m.fragments[1].count, A.count);
	m.fragments.forEach(function (f) { assert.ok(f.size < A.size && f.normal[2] > 0 && f.area > 0); assert.ok(f.box[0] >= A.box[0] && f.box[1] <= A.box[1]); });
	assert.ok(m.fragments[1].box[0] >= cx - 1e-6);
	assert.ok(m.unassignedArea > before.unassignedArea);
	// write the edit, count the whole store: the same areas
	await store.setColumn(east, "rock", 900);
	await store.setColumn(toFines, "rock", 0);
	var whole = await measureFragmentsOnStore(store, { column: "rock", measure: ms, ids: [A.id, 900] });
	assert.ok(Math.abs(whole.surfaceArea - m.surfaceArea) <= 1e-9 * whole.surfaceArea, whole.surfaceArea + " vs " + m.surfaceArea);
	assert.ok(Math.abs(whole.unassignedArea - m.unassignedArea) <= 1e-9 * whole.unassignedArea, whole.unassignedArea + " vs " + m.unassignedArea);
	whole.fragments.forEach(function (f, q) { same(f, m.fragments[q], "written rock " + f.id); });
	// removed: in neither area
	nodes = await labelsOf(store, "rock");
	var gone = selectWhere(store, nodes, function (l) { return l === 900; });
	var rm = await measureFragmentsOnStore(store, { column: "rock", measure: ms, ids: [900], changes: [{ selection: gone, label: FRAGMENT_REMOVED }], box: m.fragments[1].box, areas: whole });
	assert.deepEqual(rm.gone, [900]);
	assert.ok(rm.surfaceArea < whole.surfaceArea);
});

test("a piece under minPoints comes back small and counts as fines", async function () {
	var store = await storeOf(), fr = await findFragmentsParallel(store, Object.assign({ method: "watershed", column: "rock" }, OPTS)), ms = fr.measure;
	var nodes = await labelsOf(store, "rock"), A = fr.fragments[0], left = 20;
	var few = selectWhere(store, nodes, function (l) { return l === A.id && left-- > 0; });
	var m = await measureFragmentsOnStore(store, { column: "rock", measure: ms, ids: [77], changes: [{ selection: few, label: 77 }], box: A.box, areas: fr });
	assert.deepEqual(m.tooSmall, [77]);
	assert.equal(m.fragments[0].count, 20);
	// as fines: the same areas as sending them to 0
	var z = await measureFragmentsOnStore(store, { column: "rock", measure: ms, ids: [], changes: [{ selection: few, label: 0 }], box: A.box, areas: fr });
	assert.equal(m.unassignedArea, z.unassignedArea);
	assert.equal(m.surfaceArea, z.surfaceArea);
});

test("a hybrid store run: facet rocks measured from the pile round them", async function () {
	var r = await run("hybrid"), fr = r.fr, ms = fr.measure;
	assert.ok(ms.outlineCell > 0 && ms.surfaceDistance > 0, JSON.stringify(ms));
	var facets = fr.fragments.filter(function (f) { return f.from === "facets"; }).slice(0, 3);
	assert.ok(facets.length > 0, "facet rocks");
	var from = new Map();
	fr.fragments.forEach(function (f) { from.set(f.id, f.from); });
	var box = facets.reduce(function (b, f) { return union(b, f.box); }, facets[0].box);
	var m = await measureFragmentsOnStore(r.store, { column: "rock", measure: ms, ids: facets.map(function (f) { return f.id; }), box: box, areas: fr, from: from });
	m.fragments.forEach(function (f, q) {
		var w = facets[q];
		assert.equal(f.from, "facets");
		assert.ok(f.count <= w.count && f.count >= 0.5 * w.count, "rock " + f.id + " count " + f.count + " vs " + w.count);
		if (f.count === w.count) { assert.deepEqual(f.axes, w.axes); assert.ok(f.normal[0] * w.normal[0] + f.normal[1] * w.normal[1] + f.normal[2] * w.normal[2] > 0.999, "rock " + f.id + " normal"); }
	});
	assert.equal(m.surfaceArea, fr.surfaceArea);
});

test("bad inputs are named", async function () {
	var r = await run("watershed"), fr = r.fr, ms = fr.measure, A = fr.fragments[0], nodes = await labelsOf(r.store, "rock");
	var mem = { method: "watershed", minPoints: 50, cell: 0.03, areas: { px: 1, u0: 0, v0: 0, W: 1, H: 1 } };
	await assert.rejects(measureFragmentsOnStore(r.store, { column: "rock", measure: mem, ids: [] }), /use measureFragments/);
	await assert.rejects(measureFragmentsOnStore(r.store, { column: "nope", measure: ms, ids: [] }), /column must name/);
	await assert.rejects(measureFragmentsOnStore(r.store, { column: "rock", measure: ms }), /ids must be an array/);
	await assert.rejects(measureFragmentsOnStore(r.store, { column: "rock", measure: ms, ids: [], box: A.box }), /areas .* are needed with box/);
	await assert.rejects(measureFragmentsOnStore(r.store, { column: "rock", measure: ms, ids: [], box: [1, 0, 0, 1], areas: fr }), /box must be/);
	// a changed point outside box
	var far = fr.fragments[fr.fragments.length - 1], sel = selectWhere(r.store, nodes, function (l) { return l === far.id; });
	var tiny = [A.box[0], A.box[0] + 0.01, A.box[2], A.box[2] + 0.01];
	await assert.rejects(measureFragmentsOnStore(r.store, { column: "rock", measure: ms, ids: [], box: tiny, areas: fr, changes: [{ selection: sel, label: 0 }] }), /outside box/);
	await assert.rejects(measureFragmentsOnStore(r.store, { column: "rock", measure: ms, ids: [], changes: [{ selection: sel, label: 1.5 }] }), /label must be/);
	var ac = new AbortController(); ac.abort();
	await assert.rejects(measureFragmentsOnStore(r.store, { column: "rock", measure: ms, ids: [], signal: ac.signal }), function (e) { return e.code === "ABORTED"; });
});
