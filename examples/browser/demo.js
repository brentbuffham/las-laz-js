// examples/browser/demo.js
//==========================================================
// las-laz-js demo: drop a LAS or LAZ file, read it in the library's Worker
// (las-laz-js/worker; LAZ chunks decode on every core) with a progress
// bar, then show it once in a Three.js viewer. Colour changes recolour the
// points kept in memory — only the read filters read the file again.
// The Edit tab selects and edits those points (src/ops) and can crop the
// file on read with the polygon drawn on the viewer.
// Imports the library from ../../src so it always runs current code.
//==========================================================

import {
	VERSION, writeLas, openLas, colourize, POINT_FORMATS,
	selectPolygon, selectBox, selectClasses, selectSparse, selectOutliers, unionSelections,
	estimateNoise, denoisePoints, pointNormals,
	keepPoints, removePoints, splitPoints, mergePoints, interleavePositions, thinSelection,
	makeTransform, transformPoints
} from "../../src/index.js";
import { createViewer } from "./viewer.js";

// ?drawCap=N lowers the cap, to try a cloud bigger than what is drawn with a small file
var DRAW_CAP = Math.floor(Number(new URLSearchParams(location.search).get("drawCap"))) || 20000000;
var $ = function (id) { return document.getElementById(id); };
var viewer = createViewer($("viewer"));
var worker = new Worker(new URL("../../src/workers/lasWorker.js", import.meta.url), { type: "module" });
var nextId = 1, pending = new Map();
var file = null, info = null, origin = null, readJob = null;

// --- worker calls -----------------------------------------------------------
worker.onmessage = function (event) {
	var m = event.data, job = pending.get(m.id);
	if (!job) return;
	if (m.type === "progress" || m.type === "chunk") { job.onEvent(m); return; }
	pending.delete(m.id);
	if (m.type === "result") job.resolve(m.result); else job.reject(Object.assign(new Error(m.message), { code: m.code }));
};
function call(type, payload, onEvent) {
	var id = nextId++;
	return { id: id, promise: new Promise(function (resolve, reject) {
		pending.set(id, { resolve: resolve, reject: reject, onEvent: onEvent || function () {} });
		worker.postMessage({ id: id, type: type, payload: payload });
	}) };
}

// --- helpers -----------------------------------------------------------------
function fmt(n) { return Number(n).toLocaleString(); }
function setStatus(text, isError) { $("status").textContent = text; $("status").className = isError ? "error" : "muted"; }
function row(table, k, v) { var tr = table.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }
function num(v) { return String(Number(v.toFixed(6))); } // stored doubles, shown without float noise
function list(text) { return text.trim() ? text.split(/[\s,]+/).map(Number).filter(function (n) { return isFinite(n); }) : undefined; }
function since(t0) { return Math.round(performance.now() - t0); }

// --- open --------------------------------------------------------------------
async function openFile(f) {
	file = f;
	$("fileName").textContent = f.name + " — " + fmt(f.size) + " bytes";
	setStatus("Opening…");
	try {
		info = await call("open", { blob: f, windowSize: Number($("windowMb").value) * 1048576 }).promise;
	} catch (err) { setStatus(err.message, true); return; }
	var h = info.header;
	origin = { x: (h.bounds.minX + h.bounds.maxX) / 2, y: (h.bounds.minY + h.bounds.maxY) / 2, z: (h.bounds.minZ + h.bounds.maxZ) / 2 };
	showHeader();
	var hasRgb = !!POINT_FORMATS[h.pointFormat].fields.red;
	$("colourBy").value = hasRgb ? "rgb" : "elevation";
	$("readButton").disabled = false;
	$("writeButton").disabled = true;
	clearPolygon();   // drawn relative to the last file's origin
	read();
}

function showHeader() {
	var h = info.header, t = $("headerTable");
	$("headerEmpty").classList.add("hidden");
	t.innerHTML = "";
	row(t, "Version", h.versionMajor + "." + h.versionMinor);
	row(t, "Point format", h.pointFormat + (info.compressed ? " (LAZ)" : "") + ", " + h.recordLength + " bytes");
	if (info.laz) row(t, "LAZ", ["", "point-wise", "point-wise, chunked", "layered, chunked"][info.laz.compressor] + (info.laz.variableChunks ? ", variable chunks" : ", chunks of " + fmt(info.laz.chunkSize)) + ", LASzip " + info.laz.version.major + "." + info.laz.version.minor);
	row(t, "Points", fmt(h.pointCount));
	row(t, "Bounds X", num(h.bounds.minX) + " … " + num(h.bounds.maxX));
	row(t, "Bounds Y", num(h.bounds.minY) + " … " + num(h.bounds.maxY));
	row(t, "Bounds Z", num(h.bounds.minZ) + " … " + num(h.bounds.maxZ));
	row(t, "Scale", [h.scale.x, h.scale.y, h.scale.z].join(", "));
	row(t, "Offset", [h.offset.x, h.offset.y, h.offset.z].join(", "));
	row(t, "Software", h.software || "—");
	row(t, "System", h.systemId || "—");
	row(t, "Created", h.creationYear ? "day " + h.creationDay + " of " + h.creationYear : "—");
	row(t, "CRS", info.crs.epsg ? "EPSG " + info.crs.epsg : (info.crs.kind === "wkt" ? "WKT" : "none"));
	var v = $("vlrTable");
	v.innerHTML = "<tr><th>User</th><th>Record</th><th>Bytes</th><th>Description</th></tr>";
	info.vlrs.concat(info.evlrs).forEach(function (r) {
		var tr = v.insertRow();
		[r.userId, r.recordId, r.length, r.description].forEach(function (c) { tr.insertCell().textContent = c; });
	});
	var sel = $("writeFormat");
	sel.innerHTML = "";
	for (var f = 0; f <= 10; f++) { var o = document.createElement("option"); o.value = f; o.textContent = f; sel.appendChild(o); }
	sel.value = h.pointFormat;
	$("writeVersion").value = h.pointFormat >= 6 ? "1.4" : "1.2";
	$("writeCompress").checked = !!info.compressed;
	writeChoice();
}

// --- read --------------------------------------------------------------------
// "x y z" with blanks -> [x, y, z], a blank or bad value becoming `fill`
function triple(text, fill) {
	var p = text.trim() ? text.trim().split(/[\s,]+/) : [];
	return [0, 1, 2].map(function (i) { var v = p[i] === undefined || p[i] === "" ? NaN : Number(p[i]); return isFinite(v) ? v : fill; });
}
function boundsFilter() {
	if (!$("boundsMin").value.trim() && !$("boundsMax").value.trim()) return undefined;
	var lo = triple($("boundsMin").value, -Infinity), hi = triple($("boundsMax").value, Infinity);
	return { minX: lo[0], minY: lo[1], minZ: lo[2], maxX: hi[0], maxY: hi[1], maxZ: hi[2] };
}
function colourOpts() {
	var by = $("colourBy").value, o = { by: by, ramp: $("ramp").value };
	var lo = $("rangeMin").value.trim(), hi = $("rangeMax").value.trim();
	if (lo !== "" && hi !== "" && (by === "elevation" || by === "intensity")) {
		var shift = by === "elevation" ? origin.z : 0;   // points are read relative to the local origin
		o.range = [Number(lo) - shift, Number(hi) - shift];
	}
	return o;
}

var cloud = null;      // the points on screen, kept so colour changes and edits never re-read the file
var lastRead = null;   // the points last read: Reset goes back to them (every edit makes a copy)
var edited = false;    // cloud is an edit of lastRead, so Save writes it rather than re-reading
var transformed = false;   // cloud has been through Transform since the last read or Reset
var readCrop = null;   // { polygon, boundary, tolerance } of the last read (world), or null
var ext = null;        // the cloud's local extent { minX … maxZ, midZ }
// Over the draw cap the viewer draws an even spread of the cloud: drawnIdx holds the cloud
// indices drawn (null: every point), drawn the columns colourize needs for just those points.
// Selections and edits always act on the whole cloud in memory.
var drawnIdx = null, drawn = null;
var roughness = null;      // the drawn points' residuals for the Roughness colour, made on demand
var beforeSmooth = null;   // the cloud before the last Smooth, for Undo smooth

// Decode out of sight (the library's worker, its chunks on every core), show progress, then
// build the cloud once. Only the read filters (classes, returns, bounds, max points, dedupe)
// need a new read; colour changes recolour the points kept here. crop: a polygon in world
// coordinates to read inside (the Edit tab's "Read inside polygon"), or nothing; note is
// appended to the status line when the read finishes.
async function read(crop, note) {
	if (!info) return;
	if (readJob) await stop();
	$("viewerEmpty").classList.add("hidden");
	$("readHint").classList.add("hidden");
	$("readButton").disabled = true; $("abortButton").disabled = false; $("writeButton").disabled = true;
	editEnabled(false);
	$("progress").value = 0;
	setStatus("Decoding…");
	await call("open", { blob: file, windowSize: Number($("windowMb").value) * 1048576 }).promise;
	var hasRgb = !!POINT_FORMATS[info.header.pointFormat].fields.red;
	var t0 = performance.now();
	var tol = Number($("dedupe").value) || 0;
	readJob = call("readPoints", Object.assign({
		fields: ["x", "y", "z", "classification", "intensity", "returnNumber", "numberOfReturns", "index"].concat(hasRgb ? ["red", "green", "blue"] : []),
		classes: list($("classes").value), returns: list($("returns").value), bounds: boundsFilter(),
		maxPoints: Number($("maxPoints").value) || 0, dedupe: tol > 0 ? tol : undefined,
		localOrigin: origin, float32: true
	}, crop || {}), function (m) {
		if (m.type !== "progress") return;
		$("progress").value = m.fraction;
		setStatus("Decoding " + Math.round(m.fraction * 100) + "% · " + ((performance.now() - t0) / 1000).toFixed(1) + " s");
	});
	try {
		cloud = lastRead = await readJob.promise;
		beforeSmooth = null;
		readCrop = crop || null;
		edited = false; transformed = false; selection = null; splitAt = -1;
		var secs = (performance.now() - t0) / 1000;
		$("progress").value = 1;
		setStatus("Building the view…");
		await new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); });   // paint before the build
		display(true);
		var showing = drawnIdx ? " (" + fmt(drawnIdx.length) + " drawn, spread over the whole cloud; selections and edits apply to all " + fmt(cloud.count) + ")" : "";
		if (crop) setStatus("Read inside polygon: " + fmt(info.header.pointCount) + " → " + fmt(cloud.count) + " points in " + Math.round(secs * 1000) + " ms" + showing + (note || ""));
		else setStatus("Read " + fmt(cloud.count) + " points in " + secs.toFixed(1) + " s" + showing);
		// every record is decoded (thinning picks from all of them), so the rate is over the whole file
		$("stats").textContent = (crop ? "read " : "decoded ") + fmt(info.header.pointCount) + " points in " + secs.toFixed(1) + " s (" + fmt(Math.round(info.header.pointCount / Math.max(secs, 0.001))) + " pts/s) · kept " + fmt(cloud.count) + (crop ? " inside the polygon" : "");
		showStats();
		showSelection();
		$("writeButton").disabled = false;
	} catch (err) {
		setStatus(err.code === "ABORTED" ? "Stopped" : err.message, err.code !== "ABORTED");
	} finally {
		readJob = null;
		$("readButton").disabled = false; $("abortButton").disabled = true;
		editEnabled(!!cloud);
	}
}

// The cloud on screen: all of it, or over the draw cap an even spread (thinSelection) over the
// whole cloud. Its positions are already local, so no origin.
// refit: frame the camera on it (after a read; edits keep the view where it is).
function display(refit) {
	viewer.clear();
	drawnIdx = cloud.count > DRAW_CAP ? thinSelection(cloud.count, DRAW_CAP) : null;
	drawn = cloud;
	if (drawnIdx) {
		var part = { count: cloud.count };
		["x", "y", "z", "red", "green", "blue", "intensity", "classification"].forEach(function (k) { if (cloud[k]) part[k] = cloud[k]; });
		drawn = keepPoints(part, drawnIdx);
	}
	roughness = null;
	viewer.addChunk(interleavePositions(drawn), colours(), DRAW_CAP);
	if (refit) viewer.fit();
	ext = extent(cloud);
}

// The normal colours, then the Split view's outside part dimmed grey and the selection yellow
function colours() {
	if ($("colourBy").value === "rgb" && !cloud.red) $("colourBy").value = "elevation";   // this format holds no colour
	var c = $("colourBy").value === "roughness" ? roughColours() : colourize(drawn, colourOpts());
	for (var j = 0; j < drawn.count; j++) {
		var i = drawnIdx ? drawnIdx[j] : j;
		if (splitAt >= 0 && i >= splitAt) for (var d = j * 3; d < j * 3 + 3; d++) c[d] = 70 + c[d] * 0.2;
	}
	onScreen(selection).forEach(function (j) { c[j * 3] = 255; c[j * 3 + 1] = 214; c[j * 3 + 2] = 0; });
	return c;
}

// Roughness: the residual of each drawn point's plane fit on the ramp, 0 to its 98th percentile
// (fewer than 3 neighbours: 0). Over the draw cap it is fitted on the drawn spread only.
function roughColours() {
	if (!roughness) {
		var r = pointNormals(drawn, { k: Number($("smoothK").value) || 16, maxDistance: Number($("smoothMaxDist").value) || 0.3 }).residual;
		roughness = new Float32Array(r.length);
		for (var i = 0; i < r.length; i++) roughness[i] = r[i] === r[i] ? r[i] : 0;
	}
	var sorted = Float32Array.from(roughness).sort(), hi = sorted[Math.floor(0.98 * (sorted.length - 1))] || 1;
	return colourize({ count: drawn.count, z: roughness }, { by: "elevation", ramp: $("ramp").value, range: [0, hi] });
}

// The drawn positions of the selected points (a merge of two ascending lists)
function onScreen(sel) {
	if (!sel) return [];
	if (!drawnIdx) return sel;
	var out = [];
	for (var a = 0, b = 0; a < sel.length && b < drawnIdx.length;) {
		if (sel[a] === drawnIdx[b]) { out.push(b); a++; b++; }
		else if (sel[a] < drawnIdx[b]) a++;
		else b++;
	}
	return out;
}

// Colour, ramp or range changed: recolour the points on screen, no re-read
function recolour() {
	if (!cloud || !cloud.count) return;
	var t0 = performance.now();
	viewer.setColours(colours());
	setStatus("Recoloured " + fmt(Math.min(cloud.count, DRAW_CAP)) + " points in " + since(t0) + " ms");
}

async function stop() {
	if (!readJob) return;
	call("abort", { id: readJob.id });
	try { await readJob.promise; } catch (e) { /* stopped */ }
}

function table(id, head, rows) {
	var t = $(id);
	t.innerHTML = "<tr>" + head.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr>";
	rows.forEach(function (r) { var tr = t.insertRow(); r.forEach(function (v) { tr.insertCell().textContent = v; }); });
}

function showStats() {
	var c = cloud, n = c.count, classes = {}, returns = {}, inten = new Uint32Array(65536), minZ = Infinity, maxZ = -Infinity;
	for (var j = 0; j < n; j++) {
		classes[c.classification[j]] = (classes[c.classification[j]] || 0) + 1;
		returns[c.returnNumber[j]] = (returns[c.returnNumber[j]] || 0) + 1;
		inten[c.intensity[j]]++;
		if (c.z[j] < minZ) minZ = c.z[j];
		if (c.z[j] > maxZ) maxZ = c.z[j];
	}
	var share = function (k) { return (100 * k / n).toFixed(1) + " %"; };
	var t = $("statsTable");
	$("statsEmpty").classList.add("hidden");
	t.innerHTML = "";
	row(t, edited ? "Points (edited)" : "Points read", fmt(n));
	row(t, "Z range", n ? (minZ + origin.z).toFixed(3) + " … " + (maxZ + origin.z).toFixed(3) : "—");
	var keys = function (o) { return Object.keys(o).sort(function (a, b) { return a - b; }); };
	table("classTable", ["Class", "Points", "Share"], keys(classes).map(function (k) { return [k, fmt(classes[k]), share(classes[k])]; }));
	table("returnTable", ["Return", "Points", "Share"], keys(returns).map(function (k) { return [k, fmt(returns[k]), share(returns[k])]; }));
	// 16 equal bins over the intensities actually present
	var lo = 0, hi = 65535;
	while (lo < 65535 && !inten[lo]) lo++;
	while (hi > 0 && !inten[hi]) hi--;
	var rows = [];
	if (n && lo <= hi) {
		var width = Math.max(1, Math.ceil((hi - lo + 1) / 16));
		for (var b = lo; b <= hi; b += width) {
			var k = 0, top = Math.min(hi, b + width - 1);
			for (var v = b; v <= top; v++) k += inten[v];
			rows.push([b + " … " + top, fmt(k), share(k)]);
		}
	}
	table("intensityTable", ["Intensity", "Points", "Share"], rows);
}

// The cloud's local min / max and middle Z (zeros for no points)
function extent(c) {
	var e = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
	for (var i = 0; i < c.count; i++) {
		var x = c.x[i], y = c.y[i], z = c.z[i];
		if (x < e.minX) e.minX = x; if (x > e.maxX) e.maxX = x;
		if (y < e.minY) e.minY = y; if (y > e.maxY) e.maxY = y;
		if (z < e.minZ) e.minZ = z; if (z > e.maxZ) e.maxZ = z;
	}
	if (!c.count) e = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
	e.midZ = (e.minZ + e.maxZ) / 2;
	return e;
}

// --- edit: polygon -----------------------------------------------------------
var poly = [];          // the outline, local [x0, y0, x1, y1, ...]
var polyZ = 0;          // the local Z it is drawn (and clicked) at: the cloud's middle when drawing began
var polyClosed = false, drawing = false;
var lastClick = null;   // screen position of the last vertex, to drop a double-click's second click

function setDrawing(on) {
	drawing = on;
	$("drawButton").classList.toggle("active", on);
	$("drawButton").textContent = on ? "Drawing…" : "Draw";
	$("viewer").querySelector("canvas").classList.toggle("drawing", on);
	if (!on) viewer.setOutline(poly, polyZ, polyClosed);   // drop the rubber band to the cursor
}
function polyInfo(text) { $("polyInfo").textContent = text; }

function toggleDraw() {
	if (!cloud) return;
	if (drawing) { setDrawing(false); polyInfo(poly.length / 2 + " vertices (open) — Draw to add more, Finish to close"); return; }
	if (polyClosed || !poly.length) {          // start a new polygon, looking straight down
		poly = []; polyClosed = false; lastClick = null;
		polyZ = ext ? ext.midZ : 0;
		viewer.setOutline([]);
		viewer.topView();
	}
	setDrawing(true);
	polyInfo("Click to add vertices (a drag orbits); double-click or Finish closes it.");
}
function addVertex(clientX, clientY) {
	if (lastClick && Math.abs(clientX - lastClick.x) < 4 && Math.abs(clientY - lastClick.y) < 4) return;   // a double-click's second click
	var p = viewer.planePoint(clientX, clientY, polyZ);
	if (!p) return;   // the ray misses the plane (looking above the horizon)
	lastClick = { x: clientX, y: clientY };
	poly.push(p.x, p.y);
	viewer.setOutline(poly, polyZ, false);
	polyInfo(poly.length / 2 + " vertices — double-click or Finish closes it");
}
function finishPolygon() {
	if (poly.length < 6) { setStatus("A polygon needs three or more vertices: Draw, then click the viewer", true); return; }
	setDrawing(false);
	polyClosed = true; lastClick = null;
	viewer.setOutline(poly, polyZ, true);
	polyInfo("Polygon: " + poly.length / 2 + " vertices, closed");
	setStatus("Polygon closed: " + poly.length / 2 + " vertices");
}
function clearPolygon() {
	if (drawing) setDrawing(false);
	poly = []; polyClosed = false; lastClick = null;
	viewer.setOutline([]);
	polyInfo("Draw, then click the viewer to add vertices (a drag still orbits); double-click or Finish closes it.");
}
function needPolygon() {
	if (poly.length < 6) throw new Error("draw a polygon first (three or more vertices)");
	return poly;
}

// A click (the pointer moved less than 4 px) adds a vertex while drawing; a drag still orbits
var downAt = null;
$("viewer").addEventListener("pointerdown", function (e) { downAt = { x: e.clientX, y: e.clientY }; });
$("viewer").addEventListener("pointerup", function (e) {
	var d = downAt;
	downAt = null;
	if (!drawing || !d || e.button !== 0) return;
	var dx = e.clientX - d.x, dy = e.clientY - d.y;
	if (dx * dx + dy * dy < 16) addVertex(e.clientX, e.clientY);
});
$("viewer").addEventListener("dblclick", function () { if (drawing) finishPolygon(); });

// --- edit: selection ---------------------------------------------------------
var selection = null;   // ascending Uint32Array of indices into cloud, or null
var splitAt = -1;       // after Split: the points from here on are the outside part (dimmed)

function showSelection() {
	if (!selection) { $("selInfo").textContent = "nothing selected"; return; }
	$("selInfo").textContent = fmt(selection.length) + " selected" + (drawnIdx ? " · " + fmt(onScreen(selection).length) + " of them on screen; edits apply to all" : "");
}

// Run one selection and add it to the current one (unionSelections), then show it yellow
function select(name, make) {
	if (!cloud) return;
	var t0 = performance.now(), s;
	try { s = make(); } catch (err) { setStatus(name + ": " + err.message, true); return; }
	selection = selection ? unionSelections(selection, s) : s;
	var ms = since(t0);
	viewer.setColours(colours());
	showSelection();
	setStatus(name + ": " + fmt(s.length) + " of " + fmt(cloud.count) + " points in " + ms + " ms · " + fmt(selection.length) + " selected");
}
function selectInsidePolygon() {
	return selectPolygon(cloud, needPolygon(), { boundary: $("boundary").value, tolerance: Number($("tolerance").value) || 0 });
}
// The Read tab's bounds are world coordinates; the cloud is local, so subtract the origin
function selectInBox() {
	var b = boundsFilter();
	if (!b) throw new Error("set Bounds min / max on the Read tab first");
	var box = {};
	["x", "y", "z"].forEach(function (a) {
		var A = a.toUpperCase();
		if (isFinite(b["min" + A])) box["min" + A] = b["min" + A] - origin[a];
		if (isFinite(b["max" + A])) box["max" + A] = b["max" + A] - origin[a];
	});
	return selectBox(cloud, box);
}
function selectInClasses() {
	var codes = list($("selClasses").value);
	if (!codes || !codes.length) throw new Error("type the class codes, e.g. 2,6");
	return selectClasses(cloud, codes);
}
function clearSelection() {
	if (!selection) return;
	selection = null;
	if (cloud) viewer.setColours(colours());
	showSelection();
	setStatus("Selection cleared");
}

// --- edit: apply -------------------------------------------------------------
// Replace the cloud with an edited copy, redraw it where the camera is, re-run the stats.
// make() -> { cloud, note?, keep? } (keep: the selection and Split view still apply).
function edit(name, make) {
	if (!cloud) return;
	var before = cloud.count, t0 = performance.now(), out;
	try { out = make(); } catch (err) { setStatus(name + ": " + err.message, true); return; }
	var ms = since(t0);
	cloud = out.cloud;
	edited = true;
	// Undo smooth goes back exactly one Smooth; any other edit ends that
	beforeSmooth = null; $("undoSmoothButton").disabled = true;
	if (out.transformed) transformed = true;
	if (!out.keep) { selection = null; splitAt = -1; }
	if (out.splitAt !== undefined) splitAt = out.splitAt;
	display(false);
	showStats();
	showSelection();
	setStatus(name + ": " + fmt(before) + " → " + fmt(cloud.count) + " points in " + ms + " ms" + (out.note || ""));
}
function needSelection() {
	if (!selection) throw new Error("select points first (Inside polygon, In box or Classes)");
	return selection;
}
function smoothOpts() {
	var sigma = $("smoothSigma").value.trim();
	return { method: $("smoothMethod").value, k: Number($("smoothK").value), maxDistance: Number($("smoothMaxDist").value), sigma: sigma === "" ? undefined : Number(sigma), iterations: Number($("smoothIter").value) };
}
function measureNoise() {
	if (!cloud) return;
	var o = smoothOpts(), t0 = performance.now(), s;
	try { s = estimateNoise(cloud, { k: o.k, maxDistance: o.maxDistance }); } catch (err) { setStatus("Measure noise: " + err.message, true); return; }
	if (s === s) $("smoothSigma").value = Number(s.toFixed(4));
	setStatus("Noise: " + (s === s ? (s * 100).toFixed(2) + " cm" : "too few neighbours to measure (raise the max distance)") + " in " + since(t0) + " ms");
}
// Every point read moves; the selection and the Split view still apply (the points are the same)
function smooth() {
	setStatus("Smoothing " + fmt(cloud.count) + " points…");
	requestAnimationFrame(function () { setTimeout(function () {
		var prior = cloud;
		edit("Smooth", function () {
			var o = smoothOpts(), noise = o.sigma !== undefined ? o.sigma : estimateNoise(cloud, { k: o.k, maxDistance: o.maxDistance });
			var out = denoisePoints(cloud, Object.assign({}, o, { sigma: noise > 0 ? noise : undefined }));
			var after = estimateNoise(out, { k: o.k, maxDistance: o.maxDistance }), moved = 0;
			for (var i = 0; i < out.count; i++) if (out.x[i] !== cloud.x[i] || out.y[i] !== cloud.y[i] || out.z[i] !== cloud.z[i]) moved++;
			// a point needs 5 neighbours within the max distance to move
			var hint = moved < 0.5 * out.count ? " — most points have fewer than 5 neighbours within " + o.maxDistance + " m: raise the max distance" : "";
			return { cloud: out, keep: true, note: " · " + fmt(moved) + " moved, noise " + (noise * 100).toFixed(2) + " cm → " + (after * 100).toFixed(2) + " cm (" + o.method + ")" + hint };
		});
		if (cloud !== prior) { beforeSmooth = prior; $("undoSmoothButton").disabled = false; }
	}, 0); });
}
function undoSmooth() {
	if (!beforeSmooth) return;
	var prior = beforeSmooth;
	edit("Undo smooth", function () { return { cloud: prior, keep: true }; });
	beforeSmooth = null;
	$("undoSmoothButton").disabled = true;
}
function keepSelected() { edit("Keep selected", function () { return { cloud: keepPoints(cloud, needSelection()) }; }); }
function deleteSelected() { edit("Delete selected", function () { return { cloud: removePoints(cloud, needSelection()) }; }); }
// Both parts stay on screen, one after the other: the inside part in its colours, the outside dimmed
function split() {
	edit("Split", function () {
		var parts = splitPoints(cloud, needSelection());
		return { cloud: mergePoints(parts), splitAt: parts[0].count, note: " (" + fmt(parts[0].count) + " inside, " + fmt(parts[1].count) + " outside, dimmed)" };
	});
}
// Shift, rotate about Z and scale, about the cloud's centre (local coordinates)
function transform() {
	edit("Transform", function () {
		var about = [(ext.minX + ext.maxX) / 2, (ext.minY + ext.maxY) / 2, (ext.minZ + ext.maxZ) / 2];
		var scale = $("scale").value.trim() === "" ? 1 : Number($("scale").value);
		if (!(scale > 0)) throw new Error("scale must be greater than 0");
		var T = makeTransform({ shift: triple($("shift").value, 0), rotateZ: Number($("rotateZ").value) || 0, scale: scale, about: about });
		return { cloud: transformPoints(cloud, T), keep: true, transformed: true };
	});
}
// Read the file again inside the polygon: the outline is local, the read wants world coordinates
function cropRead() {
	if (poly.length < 6) { setStatus("Read inside polygon: draw a polygon first (three or more vertices)", true); return; }
	var world = poly.map(function (v, i) { return v + (i % 2 ? origin.y : origin.x); });
	// The read is in file coordinates, so after a Transform the outline (drawn over the moved cloud) is not what is cropped
	var note = transformed ? " · crop reads the file in its own coordinates; the outline was drawn over the transformed cloud" : "";
	read({ polygon: world, boundary: $("boundary").value, tolerance: Number($("tolerance").value) || 0 }, note);
}
function reset() {
	if (!lastRead) return;
	var before = cloud.count, t0 = performance.now();
	cloud = lastRead;
	edited = false; transformed = false; selection = null; splitAt = -1; beforeSmooth = null;
	$("undoSmoothButton").disabled = true;
	display(false);
	showStats();
	showSelection();
	setStatus("Reset: " + fmt(before) + " → " + fmt(cloud.count) + " points in " + since(t0) + " ms (the last read)");
}

function editEnabled(on) {
	document.querySelectorAll("#tab-edit button").forEach(function (b) { b.disabled = !on; });
	$("undoSmoothButton").disabled = !on || !beforeSmooth;
	if (!on && drawing) setDrawing(false);
}

// --- write -------------------------------------------------------------------
var WRITE_CAP = 5000000;   // every field of 5 M points is ~0.5 GB in a page; stream more with createLasWriter
var NO_LAZ = [4, 5, 9, 10];   // point formats the LAZ writer does not support

// LAZ for the formats that allow it; the button says what Save will write
function writeChoice() {
	var noLaz = NO_LAZ.indexOf(Number($("writeFormat").value)) >= 0;
	$("writeCompress").disabled = noLaz;
	if (noLaz) $("writeCompress").checked = false;
	$("writeButton").textContent = $("writeCompress").checked ? "Save as LAZ" : "Save as LAS";
}

// The edited cloud's own columns: the fields read, still relative to the origin, thinned
// evenly (the reader's maxPoints rule) to the page's write limit
function editedColumns() {
	var c = cloud, cols = { count: c.count, x: c.x, y: c.y, z: c.z, classification: c.classification, intensity: c.intensity, returnNumber: c.returnNumber, numberOfReturns: c.numberOfReturns };
	if (c.red) { cols.red = c.red; cols.green = c.green; cols.blue = c.blue; }
	return c.count > WRITE_CAP ? keepPoints(cols, thinSelection(c.count, WRITE_CAP)) : cols;
}

async function save() {
	var h = info.header, F = POINT_FORMATS[h.pointFormat].fields;
	var wf = Number($("writeFormat").value), compress = $("writeCompress").checked;
	var limit = Math.min(Number($("maxPoints").value) || h.pointCount, WRITE_CAP);
	var fromEdit = edited;
	$("writeResult").textContent = fromEdit ? "Writing the edited cloud…" : "Reading every field…";
	$("writeResult").className = "muted small";
	try {
		var cols, where;
		if (fromEdit) {
			cols = editedColumns();
			// at the header's scale; with no offset, writeLas chooses one from the bounds
			where = { scale: h.scale, localOrigin: origin };
		} else {
			cols = await call("readPoints", Object.assign({
				fields: ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scanAngle", "userData", "pointSourceId"]
					.concat(F.gpsTime ? ["gpsTime"] : []).concat(F.red ? ["red", "green", "blue"] : []).concat(F.nir ? ["nir"] : []),
				classes: list($("classes").value), returns: list($("returns").value), bounds: boundsFilter(), maxPoints: limit
			}, readCrop || {})).promise;
			where = { scale: h.scale, offset: h.offset };
		}
		// Formats 6-10 carry the CRS as WKT only (LAS 1.4); an EPSG code alone cannot go there
		var crs, note = "";
		if (info.crs.wkt || (info.crs.epsg && wf < 6)) crs = { wkt: info.crs.wkt, epsg: info.crs.epsg };
		else if (info.crs.epsg) note = " The source has only an EPSG code, which point formats 6–10 cannot carry (they need WKT), so no coordinate system was written.";
		var t0 = performance.now();
		var blob = await writeLas(cols, Object.assign({ version: $("writeVersion").value, pointFormat: wf, crs: crs, compress: compress, software: "las-laz-js demo", as: "blob" }, where));
		var ms = since(t0);
		var check = await (await openLas(blob)).readPoints({ fields: ["x"] });
		var ok = check.count === cols.count;
		var name = file.name.replace(/\.[^.]*$/, "") + "-las-laz-js" + (compress ? ".laz" : ".las");
		var a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = name;
		a.click();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
		var capped = " (thinned to the page's " + fmt(WRITE_CAP) + "-point limit)";
		var what = fromEdit ? ", the edited cloud: x y z, class, intensity, returns" + (cols.red ? ", colour" : "") + (cols.count < cloud.count ? capped : "")
			: (cols.count < h.pointCount && limit === WRITE_CAP ? capped : "");
		$("writeResult").textContent = "Saved " + name + " (" + fmt(blob.size) + " bytes, " + fmt(cols.count) + " points" + what + ", written in " + ms + " ms). Round trip: " + (ok ? "OK, same count read back." : "MISMATCH (" + fmt(check.count) + " read back)") + note;
		$("writeResult").className = ok ? "muted small" : "error small";
	} catch (err) {
		$("writeResult").textContent = err.message;
		$("writeResult").className = "error small";
	}
}

// --- hover -------------------------------------------------------------------
var hoverQueued = false, lastMove = null;
$("viewer").addEventListener("mousemove", function (e) {
	lastMove = e;
	if (hoverQueued || !cloud) return;
	hoverQueued = true;
	requestAnimationFrame(function () {
		hoverQueued = false;
		if (drawing && poly.length) {   // the outline follows the cursor to the next vertex
			var p = viewer.planePoint(lastMove.clientX, lastMove.clientY, polyZ);
			if (p) viewer.setOutline(poly.concat([p.x, p.y]), polyZ, false);
		}
		if (!cloud.count) return;
		var hit = viewer.pick(lastMove.clientX, lastMove.clientY, 8);
		if (!hit) { $("hud").textContent = ""; return; }
		var c = cloud, i = drawnIdx ? drawnIdx[hit.index] : hit.index;
		$("hud").textContent = "X " + (c.x[i] + origin.x).toFixed(3) + "  Y " + (c.y[i] + origin.y).toFixed(3) + "  Z " + (c.z[i] + origin.z).toFixed(3) +
			"  · class " + c.classification[i] + "  · intensity " + c.intensity[i] + "  · return " + c.returnNumber[i] +
			(c.index ? "  · record " + c.index[i] : "");
	});
});

// --- UI wiring ----------------------------------------------------------------
document.querySelectorAll(".tab").forEach(function (tab) {
	tab.addEventListener("click", function () {
		document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t === tab); });
		document.querySelectorAll(".tab-body").forEach(function (b) { b.classList.toggle("hidden", b.id !== "tab-" + tab.dataset.tab); });
	});
});
$("togglePanel").addEventListener("click", function () { $("panel").classList.toggle("hidden"); });
$("fileInput").addEventListener("change", function (e) { if (e.target.files[0]) openFile(e.target.files[0]); });
$("readButton").addEventListener("click", function () { read(); });
$("abortButton").addEventListener("click", stop);
$("writeButton").addEventListener("click", save);
$("writeFormat").addEventListener("change", writeChoice);
$("writeCompress").addEventListener("change", writeChoice);
$("colourBy").addEventListener("change", recolour);
$("ramp").addEventListener("change", recolour);
$("rangeMin").addEventListener("change", recolour);
$("rangeMax").addEventListener("change", recolour);
// Edit tab
$("drawButton").addEventListener("click", toggleDraw);
$("finishButton").addEventListener("click", finishPolygon);
$("clearPolyButton").addEventListener("click", clearPolygon);
$("topViewButton").addEventListener("click", function () { viewer.topView(); });
$("selPolygonButton").addEventListener("click", function () { select("Inside polygon", selectInsidePolygon); });
$("selBoxButton").addEventListener("click", function () { select("In box", selectInBox); });
$("selClassesButton").addEventListener("click", function () { select("Classes", selectInClasses); });
$("selSparseButton").addEventListener("click", function () {
	select("Sparse points", function () { return selectSparse(cloud, { radius: Number($("sparseRadius").value), minNeighbours: Number($("sparseMin").value) }); });
});
$("selOutliersButton").addEventListener("click", function () {
	select("Outliers", function () { return selectOutliers(cloud, { k: Number($("outlierK").value), multiplier: Number($("outlierMult").value) }); });
});
$("measureNoiseButton").addEventListener("click", measureNoise);
$("smoothButton").addEventListener("click", smooth);
$("undoSmoothButton").addEventListener("click", undoSmooth);
["smoothK", "smoothMaxDist"].forEach(function (id) { $(id).addEventListener("change", function () { roughness = null; if ($("colourBy").value === "roughness") recolour(); }); });
$("clearSelButton").addEventListener("click", clearSelection);
$("keepButton").addEventListener("click", keepSelected);
$("deleteButton").addEventListener("click", deleteSelected);
$("splitButton").addEventListener("click", split);
$("transformButton").addEventListener("click", transform);
$("cropReadButton").addEventListener("click", cropRead);
$("resetButton").addEventListener("click", reset);
// The read filters need a new read: say so rather than re-reading on every keystroke
["classes", "returns", "maxPoints", "boundsMin", "boundsMax", "dedupe", "windowMb"].forEach(function (id) {
	$(id).addEventListener("input", function () { if (cloud) $("readHint").classList.remove("hidden"); });
});
$("pointSize").addEventListener("input", function () { viewer.setPointSize(Number($("pointSize").value) || 2); });
$("version").textContent = "v" + VERSION;
$("drawCapText").textContent = fmt(DRAW_CAP);
$("writeCapText").textContent = fmt(WRITE_CAP);
window.addEventListener("dragover", function (e) { e.preventDefault(); $("dropOverlay").classList.remove("hidden"); });
window.addEventListener("dragleave", function (e) { if (!e.relatedTarget) $("dropOverlay").classList.add("hidden"); });
window.addEventListener("drop", function (e) {
	e.preventDefault();
	$("dropOverlay").classList.add("hidden");
	if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});
window.lasDemo = { openFile: openFile, read: read, save: save };
