// examples/browser/tiles.js
//==========================================================
// The demo's Tiles tab: build a tile store from the open file in the
// library's Worker (OPFS, so it stays after a reload), or reopen one
// from the list; then fly within a point budget: selectTiles runs on
// the main thread on the manifest the Worker posts (at most once a
// frame, when the camera moves), the Worker streams the missing tiles
// (readTiles), and tiles no longer picked are dropped. Edits go to the
// store: delete or classify inside the Edit tab's polygon. Save writes
// the store (LAS / LAZ) through the Worker to an OPFS scratch file,
// then downloads it.
//==========================================================

import { selectTiles, listTiles, removeTiles, colourize, getScratchFile } from "../../src/index.js";

var RGB_FORMATS = [2, 3, 5, 7, 8, 10];

export function initTiles(ctx) {
	var $ = ctx.$, viewer = ctx.viewer;
	var manifest = null, storeId = null, tileOrigin = null, active = false;
	var loaded = new Map();        // key -> generation drawn
	var reading = false, scheduled = false, lastSelectMs = 0, lastPick = [];

	function info(text) { $("tilesInfo").textContent = text; }
	function budget() { return Number($("tilesBudget").value) * 1e6; }
	function idFor(file) { return (file.name.replace(/[^\w.-]+/g, "_") + "-" + file.size).slice(0, 120); }
	function rootBox() { var b = manifest.nodes["0-0-0-0"].box; return b || [0, 0, 0, 0, 0, 0]; }

	function showing(on) {
		active = on;
		ctx.setMainVisible(!on);
		ctx.polygonTools(on);
		["tilesDelete", "tilesClassify", "tilesSave", "tilesClose", "dlFind"].forEach(function (id) { $(id).disabled = !on; });
		dlFound(false);
		if (!on) { viewer.clearTiles(); loaded.clear(); manifest = null; info("No tiles shown."); }
		document.dispatchEvent(new Event("las:source"));   // the Ghosting overview redraws
	}

	// a store is open in the Worker: draw it from its manifest
	function opened(result, id) {
		manifest = result.manifest;
		storeId = id;
		var b = rootBox();
		tileOrigin = ctx.origin() || { x: (b[0] + b[3]) / 2, y: (b[1] + b[4]) / 2, z: (b[2] + b[5]) / 2 };
		viewer.clearTiles();
		loaded.clear();
		showing(true);
		viewer.fitBox({ min: [b[0] - tileOrigin.x, b[1] - tileOrigin.y, b[2] - tileOrigin.z], max: [b[3] - tileOrigin.x, b[4] - tileOrigin.y, b[5] - tileOrigin.z] });
		schedule();
		refreshList();
	}

	function colourOf(points) {
		var by = $("tilesColour").value;
		if (by === "rgb" && RGB_FORMATS.indexOf(manifest.pointFormat) < 0) by = "elevation";
		if (by === "elevation") { var b = rootBox(); return colourize(points, { by: "elevation", range: [b[2] - tileOrigin.z, b[5] - tileOrigin.z] }); }
		return colourize(points, { by: by });
	}

	function interleave(p) {
		var out = new Float32Array(p.count * 3);
		for (var i = 0; i < p.count; i++) { out[3 * i] = p.x[i]; out[3 * i + 1] = p.y[i]; out[3 * i + 2] = p.z[i]; }
		return out;
	}

	function schedule() {
		if (scheduled || !active) return;
		scheduled = true;
		requestAnimationFrame(function () { scheduled = false; update(); });
	}

	// pick, drop what is no longer picked, load what is missing (one readTiles at a time)
	function update() {
		if (!manifest) return;
		var view = viewer.viewState(), t0 = performance.now();
		view.pointBudget = budget();
		view.localOrigin = tileOrigin;
		var crop = ctx.clipBox ? ctx.clipBox() : null;   // the Ghosting tab's box, in this frame: tiles outside it cost no budget
		if (crop) view.clipBox = crop;
		var pick = selectTiles(manifest, view);
		lastSelectMs = performance.now() - t0;
		lastPick = pick;
		var want = new Map(pick.map(function (n) { return [n.key, manifest.nodes[n.key].gen]; }));
		viewer.tileKeys().forEach(function (k) { if (want.get(k) !== loaded.get(k)) { viewer.removeTile(k); loaded.delete(k); } });
		status();
		if (reading) return;
		var missing = pick.filter(function (n) { return !loaded.has(n.key) && n.count > 0; }).slice(0, loaded.size ? 64 : 8).map(function (n) { return n.key; });   // a few first, so something shows at once
		if (!missing.length) return;
		reading = true;
		var fields = ["x", "y", "z", "classification", "intensity"].concat(RGB_FORMATS.indexOf(manifest.pointFormat) >= 0 ? ["red", "green", "blue"] : []);
		var gens = new Map(missing.map(function (k) { return [k, manifest.nodes[k].gen]; }));
		ctx.call("readTiles", { keys: missing, fields: fields, localOrigin: tileOrigin, float32: true }, function (m) {
			if (m.type !== "tile" || !manifest || manifest.nodes[m.key] === undefined || manifest.nodes[m.key].gen !== gens.get(m.key)) return;
			if (!lastPick.some(function (n) { return n.key === m.key; })) return;   // the camera moved on
			viewer.setTile(m.key, interleave(m.points), colourOf(m.points));
			loaded.set(m.key, gens.get(m.key));
		}).promise.catch(function (err) { console.error("[tiles] read", err); ctx.setStatus("Reading tiles: " + (err.code || "") + " " + err.message, true); }).finally(function () {
			reading = false;
			status();
			schedule();
		});
	}

	function status() {
		var points = viewer.tilePoints(), want = lastPick.reduce(function (s, n) { return s + n.count; }, 0);
		info(ctx.fmt(viewer.tileKeys().length) + " of " + ctx.fmt(lastPick.length) + " tiles drawn, " + ctx.fmt(points) + " of " + ctx.fmt(want) + " points (budget " + ctx.fmt(budget()) + ") · selectTiles " + lastSelectMs.toFixed(2) + " ms · " + ctx.fmt(Object.keys(manifest ? manifest.nodes : {}).length) + " tiles in the store");
	}

	async function build() {
		var f = ctx.file();
		if (!f) { ctx.setStatus("Open a file first", true); return; }
		var id = idFor(f), t0 = performance.now();
		$("tilesBuild").disabled = true;
		ctx.setStatus("Building tiles…");
		try {
			var r = await ctx.call("buildTiles", { where: { opfs: id }, compress: $("tilesCompress").checked, replace: true, name: f.name }, function (m) {
				if (m.type !== "progress") return;
				$("progress").value = m.fraction;
				ctx.setStatus("Building tiles: " + m.phase + " " + Math.round(100 * m.fraction) + " %");
			}).promise;
			ctx.setStatus("Built " + ctx.fmt(r.count) + " points into " + ctx.fmt(Object.keys(r.manifest.nodes).length) + " tiles in " + ctx.fmt(ctx.since(t0)) + " ms");
			console.log("[tiles] build", { points: r.count, tiles: Object.keys(r.manifest.nodes).length, ms: ctx.since(t0), compressed: !!r.manifest.laz, bytes: r.manifest.bytes });
			opened(r, id);
		} catch (err) {
			ctx.setStatus("Build: " + err.message, true);
		} finally {
			$("tilesBuild").disabled = !ctx.file();
		}
	}

	async function open(id) {
		var t0 = performance.now();
		try {
			var r = await ctx.call("openTiles", { where: { opfs: id } }).promise;
			opened(r, id);
			ctx.setStatus("Opened tiles " + id + " (" + ctx.fmt(r.count) + " points) in " + ctx.fmt(ctx.since(t0)) + " ms");
			console.log("[tiles] open", { id: id, ms: ctx.since(t0) });
		} catch (err) { ctx.setStatus("Open tiles: " + err.message, true); }
	}

	async function remove(id) {
		try {
			if (id === storeId) { await ctx.call("closeTiles", {}).promise; showing(false); storeId = null; }
			await removeTiles({ opfs: id });
			ctx.setStatus("Removed tiles " + id);
		} catch (err) { ctx.setStatus("Remove tiles: " + err.message, true); }
		refreshList();
	}

	async function refreshList() {
		var t = $("tilesList");
		t.innerHTML = "";
		var list = [];
		try { list = await listTiles(); } catch (err) { info("OPFS is not available here: " + err.message); return; }
		if (!list.length) { t.insertRow().insertCell().textContent = "No stored tiles yet."; return; }
		list.forEach(function (s) {
			var tr = t.insertRow();
			tr.insertCell().textContent = (s.source && s.source.name) || s.id;
			tr.insertCell().textContent = ctx.fmt(s.points) + " pts, " + (s.bytes / 1048576).toFixed(1) + " MB";
			var c = tr.insertCell(), o = document.createElement("button"), x = document.createElement("button");
			o.className = "button small"; o.textContent = "Open"; o.addEventListener("click", function () { open(s.id); });
			x.className = "button small"; x.textContent = "Remove"; x.addEventListener("click", function () { remove(s.id); });
			c.appendChild(o); c.appendChild(x);
		});
	}

	function worldPolygon() {
		var p = ctx.polygon();
		if (!p) throw new Error("draw and close a polygon on the Edit tab first");
		return p.map(function (v, i) { return v + (i % 2 ? tileOrigin.y : tileOrigin.x); });
	}

	// one edit at a time: the edit buttons wait for it (the library queues edits too)
	function busy(on) { ["tilesDelete", "tilesClassify", "tilesSave", "dlFind"].forEach(function (id) { $(id).disabled = on || !active; }); $("dlClassify").disabled = $("dlSnap").disabled = on || !active || !found; }

	async function edit(label, run) {
		var t0 = performance.now();
		busy(true);
		try {
			var sel = await ctx.call("selectPolygon", { polygon: worldPolygon() }).promise;
			if (!sel.count) { ctx.setStatus(label + ": no points inside the polygon", true); return; }
			var r = await run(sel);
			manifest = r.manifest;
			document.dispatchEvent(new Event("las:source"));
			ctx.setStatus(label + ": " + ctx.fmt(sel.count) + " points in " + ctx.fmt(ctx.since(t0)) + " ms; the store now holds " + ctx.fmt(Object.keys(manifest.nodes).reduce(function (s, k) { return s + manifest.nodes[k].count; }, 0)) + " points");
			schedule();
		} catch (err) { ctx.setStatus(label + ": " + err.message, true); } finally { busy(false); }
	}

	// Double layer: find in the Worker (it keeps the points), then classify or snap them
	var found = null;
	function dlFound(f) { found = f; $("dlClassify").disabled = $("dlSnap").disabled = !f; if (!f) $("dlInfo").textContent = "Nothing found yet."; }

	async function dlFind() {
		var t0 = performance.now(), mode = $("dlMode").value, gap = $("dlMaxGap").value;
		var opts = { cell: Number($("dlCell").value), minGap: Number($("dlGap").value), keep: $("dlKeep").value, minPoints: Number($("dlMin").value), smooth: Number($("dlSmooth").value), partner: mode === "average" };
		if (gap !== "") opts.maxGap = Number(gap);
		if ($("dlArea").value !== "") opts.minArea = Number($("dlArea").value);
		if ($("dlCoh").value !== "") opts.coherence = Number($("dlCoh").value);
		var limit = ctx.findBox ? ctx.findBox() : null;
		if (limit) opts.box = limit;   // file coordinates: only the tiles the box meets are read
		busy(true);
		try {
			ctx.setStatus("Finding the double layer…");
			var r = await ctx.call("findDoubleLayer", opts, function (m) { if (m.type === "progress") $("progress").value = m.fraction; }).promise;
			dlFound(r.count ? r : null);
			var s = r.stats, d = function (v) { return v.toFixed(3); };
			$("dlInfo").textContent = r.count ? ctx.fmt(r.count) + " ghost points" + (limit ? " in the box" : "") + "; offset to the kept layer: median " + d(s.median) + " m, 5-95 % " + d(s.p05) + " to " + d(s.p95) + ", range " + d(s.min) + " to " + d(s.max) + " (" + r.tiles + " work tiles, " + ctx.fmt(ctx.since(t0)) + " ms)" : "No ghost found: try a smaller gap, a smaller minimum patch or a different cell.";
			ctx.setStatus("Double layer: " + ctx.fmt(r.count) + " points in " + ctx.fmt(ctx.since(t0)) + " ms");
			console.log("[tiles] double layer", { opts: opts, count: r.count, stats: r.stats, ms: ctx.since(t0) });
		} catch (err) { dlFound(null); ctx.setStatus("Double layer: " + err.message, true); } finally { busy(false); }
	}

	async function dlApply(label, type, payload) {
		var t0 = performance.now();
		busy(true);
		try {
			var r = await ctx.call(type, payload).promise;
			manifest = r.manifest;
			if (type === "snapDoubleLayer") dlFound(null);
			ctx.setStatus(label + ": " + ctx.fmt(found ? found.count : r.moved) + " points in " + ctx.fmt(ctx.since(t0)) + " ms");
			viewer.clearTiles(); loaded.clear();
			if (type === "snapDoubleLayer") document.dispatchEvent(new Event("las:source"));   // heights moved: the overview's colours
			schedule();
		} catch (err) { ctx.setStatus(label + ": " + err.message, true); } finally { busy(false); }
	}

	async function save() {
		var compress = $("tilesSaveCompress").checked, name = (storeId || "tiles").replace(/\.(las|laz)-\d+$/i, "") + "-tiles." + (compress ? "laz" : "las");
		var t0 = performance.now(), scratchId = "las-laz-js-tiles-save." + (compress ? "laz" : "las");
		try {
			ctx.setStatus("Saving the store…");
			var r = await ctx.call("writeTiles", { scratchId: scratchId, compress: compress }).promise;
			var file = await getScratchFile(scratchId);
			var a = document.createElement("a");
			a.href = URL.createObjectURL(file);
			a.download = name;
			a.click();
			setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
			ctx.setStatus("Saved " + ctx.fmt(r.count) + " points as " + name + " in " + ctx.fmt(ctx.since(t0)) + " ms");
			console.log("[tiles] save", { name: name, points: r.count, bytes: file.size, ms: ctx.since(t0) });
		} catch (err) { ctx.setStatus("Save tiles: " + err.message, true); }
	}

	viewer.onCameraChange(schedule);
	$("tilesBuild").addEventListener("click", build);
	$("tilesRefresh").addEventListener("click", refreshList);
	$("tilesBudget").addEventListener("input", function () { $("tilesBudgetText").textContent = $("tilesBudget").value + " M"; schedule(); });
	$("tilesColour").addEventListener("change", function () { viewer.clearTiles(); loaded.clear(); schedule(); });
	$("tilesDelete").addEventListener("click", function () { edit("Delete inside polygon", function (sel) { return ctx.call("deletePoints", { selection: sel }).promise; }); });
	$("tilesClassify").addEventListener("click", function () {
		var cls = Number($("tilesClass").value);
		edit("Classify inside polygon as " + cls, function (sel) { return ctx.call("setColumn", { selection: sel, name: "classification", value: cls }).promise; });
	});
	$("dlFind").addEventListener("click", dlFind);
	$("dlClassify").addEventListener("click", function () { dlApply("Classify the double layer", "classifyDoubleLayer", { value: Number($("dlClass").value) }); });
	$("dlSnap").addEventListener("click", function () { dlApply("Snap the double layer", "snapDoubleLayer", { mode: $("dlMode").value, blend: Number($("dlBlend").value) }); });
	$("dlMode").addEventListener("change", function () { if (found && $("dlMode").value === "average" && !found.partner) { dlFound(null); ctx.setStatus("Average needs the kept layer's points too: find again", true); } });
	$("tilesSave").addEventListener("click", save);
	$("tilesClose").addEventListener("click", async function () { await ctx.call("closeTiles", {}).promise; storeId = null; showing(false); ctx.setStatus("Tiles closed"); });
	refreshList();

	return {
		/** True while tiles are shown (the Edit tab's polygon tool works on them). */
		active: function () { return active; },
		/** The origin the shown tiles are local to ({ x, y, z }, file coordinates). */
		origin: function () { return tileOrigin; },
		/** Choose the tiles again now (the Ghosting box moved). */
		reselect: function () { schedule(); },
		/** The middle Z of the store, local: where the polygon is drawn. */
		midZ: function () { var b = rootBox(); return (b[2] + b[5]) / 2 - tileOrigin.z; },
		/** A file was opened: building is possible. */
		fileOpened: function () { $("tilesBuild").disabled = false; },
		get manifest() { return manifest; }, get lastPick() { return lastPick; }, get selectMs() { return lastSelectMs; }
	};
}
