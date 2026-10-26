// examples/browser/demo.js
//==========================================================
// las-laz-js demo: drop a LAS or LAZ file, read it in the library's Worker
// (las-laz-js/worker; LAZ chunks decode on every core) with a progress
// bar, then show it once in a Three.js viewer. Colour changes recolour the
// points kept in memory — only the read filters read the file again.
// The Edit tab selects and edits those points (src/ops), classifies them
// (existing classes kept unless Overwrite) and can crop the file on read
// with the polygon drawn on the viewer. The Register tab (register.js)
// moves the cloud onto a reference cloud or the grid. The Tiles tab
// (tiles.js) builds a tile store and flies it within a point budget.
// Imports the library from ../../src so it always runs current code.
//==========================================================

import {
	VERSION, createLasWriter, chooseScaleOffset, openLas, colourize, POINT_FORMATS,
	selectPolygon, selectBox, selectClasses, selectSparse, selectOutliers, unionSelections,
	estimateNoise, denoisePoints, pointNormals,
	keepPoints, removePoints, splitPoints, mergePoints, interleavePositions, thinSelection,
	makeTransform, transformPoints, classifyPoints, ASPRS_CLASSES
} from "../../src/index.js";
import { createViewer } from "./viewer.js";
import { initRegister } from "./register.js";
import { createPartsSink } from "./fileParts.js";
import { initFacets } from "./facets.js";
import { initFragments } from "./fragments.js";
import { initTiles } from "./tiles.js";

// ?drawCap=N lowers the cap, to try a cloud bigger than what is drawn with a small file
var DRAW_CAP = Math.floor(Number(new URLSearchParams(location.search).get("drawCap"))) || 20000000;
var $ = function (id) { return document.getElementById(id); };
var viewer = createViewer($("viewer"));
var worker = new Worker(new URL("../../src/workers/lasWorker.js", import.meta.url), { type: "module" });
var nextId = 1, pending = new Map();
var file = null, info = null, origin = null, readJob = null;
var fileOrigin = null;   // the open file's own origin (its bounds' centre): every read is about it, though a Register Apply moves origin

// --- worker calls -----------------------------------------------------------
worker.onmessage = function (event) {
	var m = event.data, job = pending.get(m.id);
	if (!job) return;
	if (m.type === "progress" || m.type === "chunk" || m.type === "tile") { job.onEvent(m); return; }
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
	origin = fileOrigin = { x: (h.bounds.minX + h.bounds.maxX) / 2, y: (h.bounds.minY + h.bounds.maxY) / 2, z: (h.bounds.minZ + h.bounds.maxZ) / 2 };
	register.onOpen();
	tiles.fileOpened();
	showHeader();
	classNames = Object.assign({}, info.classNames || {});
	refreshClassSelect();
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
	showExtraBytes();
	var sel = $("writeFormat");
	sel.innerHTML = "";
	for (var f = 0; f <= 10; f++) { var o = document.createElement("option"); o.value = f; o.textContent = f; sel.appendChild(o); }
	sel.value = h.pointFormat;
	$("writeVersion").value = h.pointFormat >= 6 ? "1.4" : "1.2";
	$("writeCompress").checked = !!info.compressed;
	writeChoice();
}

// The file's extra-bytes fields: name (column when it differs), type, scale / offset, no-data, description
function showExtraBytes() {
	var list = info.extraBytes || [], t = $("extraTable");
	$("extraEmpty").classList.toggle("hidden", list.length > 0);
	$("extraProblem").classList.toggle("hidden", !info.extraBytesProblem);
	$("extraProblem").textContent = info.extraBytesProblem ? "The Extra Bytes VLR is not used: " + info.extraBytesProblem + ". Its bytes are read raw." : "";
	t.innerHTML = list.length ? "<tr><th>Name</th><th>Type</th><th>Scale / offset</th><th>No-data</th><th>Description</th></tr>" : "";
	list.forEach(function (e) {
		var tr = t.insertRow();
		var so = e.scale === null && e.offset === null ? "—" : [e.scale === null ? 1 : e.scale, e.offset === null ? 0 : e.offset].join(" / ");
		[(e.name || "(undocumented)") + (e.column !== e.name ? " [" + e.column + "]" : ""), e.type === "raw" ? "raw × " + e.size : e.k > 1 ? e.type + " × " + e.k : e.type,
			so, e.noData === null ? "—" : String(e.noData), e.description || ""].forEach(function (c) { tr.insertCell().textContent = c; });
	});
}
// Extra fields the writer can write (types 1-10 and raw), and the array ones it drops
function writableExtra() { return (info.extraBytes || []).filter(function (e) { return e.type === "raw" || e.k === 1; }); }
function droppedExtra() { return (info.extraBytes || []).filter(function (e) { return e.type !== "raw" && e.k > 1; }).map(function (e) { return e.name; }); }
// Point i's extra values as text, "name value"
function extraText(c, i) {
	return (info.extraBytes || []).filter(function (e) { return c[e.column]; }).map(function (e) {
		var vals = [];
		for (var j = 0; j < e.k; j++) { var v = c[e.column][i * e.k + j]; vals.push(typeof v === "bigint" ? String(v) : v !== v ? "no data" : String(Math.round(v * 1e6) / 1e6)); }
		return "  · " + (e.name || e.column) + " " + vals.join(" ");
	}).join("");
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
var readOrigin = null; // the origin they were read about (a Register Apply moves origin)
var edited = false;    // cloud is an edit of lastRead, so Save writes it rather than re-reading
var transformed = false;   // cloud has been through Transform since the last read or Reset
var readCrop = null;   // { polygon, boundary, tolerance } of the last read (world), or null
var readThinned = false;   // the last read kept fewer points than passed its filters (Max points)
var ext = null;        // the cloud's local extent { minX … maxZ, midZ }
// Over the draw cap the viewer draws an even spread of the cloud: drawnIdx holds the cloud
// indices drawn (null: every point), drawn the columns colourize needs for just those points.
// Selections and edits always act on the whole cloud in memory.
var drawnIdx = null, drawn = null;
var roughness = null;      // the drawn points' residuals for the Roughness colour, made on demand
var beforeSmooth = null;   // the cloud before the last Smooth, for Undo smooth
var beforeClassify = null; // the cloud before the last Classify, for Undo classify
var classNames = {};       // user / file class names, { code: name }: the file's lookup VLR plus Add class
var classCounts = {};      // points per class in the cloud (showStats), for the legend

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
		fields: ["x", "y", "z", "classification", "intensity", "returnNumber", "numberOfReturns", "index"].concat(hasRgb ? ["red", "green", "blue"] : []).concat(info.extraBytes && info.extraBytes.length ? ["extra"] : []),
		classes: list($("classes").value), returns: list($("returns").value), bounds: boundsFilter(),
		maxPoints: Number($("maxPoints").value) || 0, dedupe: tol > 0 ? tol : undefined,
		localOrigin: fileOrigin, float32: true
	}, crop || {}), function (m) {
		if (m.type !== "progress") return;
		$("progress").value = m.fraction;
		setStatus("Decoding " + Math.round(m.fraction * 100) + "% · " + ((performance.now() - t0) / 1000).toFixed(1) + " s");
	});
	try {
		cloud = lastRead = await readJob.promise;
		origin = readOrigin = fileOrigin;   // the read is about the file's own origin, whatever an Apply moved
		beforeSmooth = null; beforeClassify = null;
		readCrop = crop || null;
		var maxPts = Number($("maxPoints").value) || 0;
		readThinned = maxPts > 0 && cloud.count >= maxPts && maxPts < info.header.pointCount;
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
		register.onRead();
		facets.onRead();
		fragments.onRead();
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
	var by = $("colourBy").value;
	var c = by === "roughness" ? roughColours() : by === "facet" || by === "set" ? facets.colours(drawn, drawnIdx, by) : by === "fragment" || by === "fragmentSize" ? fragments.colours(drawn, drawnIdx, by) : colourize(drawn, colourOpts());
	if (by !== "fragmentSize") $("fraLegend").classList.add("hidden");
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
	showLegend();
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
	table("classTable", ["Class", "Name", "Points", "Share"], keys(classes).map(function (k) { return [k, className(k), fmt(classes[k]), share(classes[k])]; }));
	classCounts = classes;
	showLegend();
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
	if (!cloud && !tiles.active()) return;   // the Tiles tab's store, with no cloud read
	if (drawing) { setDrawing(false); polyInfo(poly.length / 2 + " vertices (open) — Draw to add more, Finish to close"); return; }
	if (polyClosed || !poly.length) {          // start a new polygon, looking straight down
		poly = []; polyClosed = false; lastClick = null;
		polyZ = tiles.active() ? tiles.midZ() : ext ? ext.midZ : 0;
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
	if (typeof facets !== "undefined" && facets) facets.onSelection();
	if (typeof fragments !== "undefined" && fragments) fragments.onSelection();
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
	beforeClassify = null; $("undoClassifyButton").disabled = true;
	register.onEdit(name);
	facets.onEdit(name, cloud.count !== before);
	fragments.onEdit(name);
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

// --- edit: categorise --------------------------------------------------------
// A code's name: the file's / the user's, else the ASPRS one, else reserved (23-63) or user (64-255)
function className(k) { return classNames[k] || ASPRS_CLASSES[k] || (k >= 64 ? "user " + k : "reserved"); }
// The colour colourize gives a code (the table, or the stable colour of a code without one)
function classRgb(k) { return colourize({ count: 1, classification: Uint8Array.of(k) }, { by: "classification" }); }

// The class picker: the ASPRS classes, then the file's and the user's names; keeps the choice
function refreshClassSelect(pick) {
	var sel = $("classSelect"), keep = pick !== undefined ? String(pick) : sel.value;
	sel.innerHTML = "";
	var codes = Object.keys(ASPRS_CLASSES).map(Number);
	Object.keys(classNames).map(Number).forEach(function (k) { if (codes.indexOf(k) < 0) codes.push(k); });
	codes.sort(function (a, b) { return a - b; }).forEach(function (k) {
		var o = document.createElement("option");
		o.value = String(k);
		o.textContent = k + " — " + className(k);
		sel.appendChild(o);
	});
	sel.value = keep && sel.querySelector('option[value="' + keep + '"]') ? keep : "2";
	$("newClassCode").value = String(nextFreeCode());
}
function nextFreeCode() {
	for (var k = 64; k <= 255; k++) if (!classNames[k]) return k;
	return 255;
}
function addClass() {
	var code = Number($("newClassCode").value), name = $("newClassName").value;
	if (!Number.isInteger(code) || code < 64 || code > 255) { setStatus("Add class: the code must be a whole number 64-255 (user classes)", true); return; }
	if (classNames[code]) { setStatus("Add class: " + code + " is already \"" + classNames[code] + "\"", true); return; }
	if (!/^[\x20-\x7E]{1,15}$/.test(name) || !name.trim()) { setStatus("Add class: the name must be 1 to 15 plain characters (LAS stores 15, ASCII)", true); return; }
	classNames[code] = name;
	$("newClassName").value = "";
	refreshClassSelect(code);
	if (cloud) showStats();
	setStatus("Added class " + code + " — " + name + "; it is saved by name when you write the file");
}
function classify() {
	var prior = cloud, code = Number($("classSelect").value), overwrite = $("overwriteClasses").checked;
	var colourWas = $("colourBy").value;
	$("colourBy").value = "classification";   // edit() redraws in it, so the message below stays on screen
	edit("Classify", function () {
		var sel = needSelection(), r = classifyPoints(cloud, sel, code, { overwrite: overwrite });
		var already = 0;
		for (var j = 0; j < sel.length; j++) if (cloud.classification[sel[j]] === code) already++;
		var kept = sel.length - r.changed - already;
		return { cloud: r.columns, keep: true, note: " · " + fmt(r.changed) + " points → " + code + " " + className(code) + (kept ? ", " + fmt(kept) + " kept their class (tick Overwrite to change them)" : "") + (already ? ", " + fmt(already) + " were already " + code : "") };
	});
	if (cloud !== prior) { beforeClassify = prior; $("undoClassifyButton").disabled = false; }
	else $("colourBy").value = colourWas;   // refused: nothing changed
}
function undoClassify() {
	if (!beforeClassify) return;
	var prior = beforeClassify;
	edit("Undo classify", function () { return { cloud: prior, keep: true }; });
	beforeClassify = null;
	$("undoClassifyButton").disabled = true;
}
// The classes present, with colour, name and count, while colouring by classification
function showLegend() {
	var el = $("classLegend");
	if (!cloud || $("colourBy").value !== "classification") { el.classList.add("hidden"); return; }
	el.innerHTML = "";
	Object.keys(classCounts).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) {
		var c = classRgb(k), line = document.createElement("div"), sw = document.createElement("span"), label = document.createElement("span"), n = document.createElement("span");
		sw.className = "swatch"; sw.style.background = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
		label.textContent = k + " " + className(k);
		n.className = "count"; n.textContent = fmt(classCounts[k]);
		line.append(sw, label, n);
		el.appendChild(line);
	});
	el.classList.remove("hidden");
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
	origin = readOrigin;
	clearPolygon();   // drawn in the frame the cloud was in
	edited = false; transformed = false; selection = null; splitAt = -1; beforeSmooth = null; beforeClassify = null;
	$("undoSmoothButton").disabled = true;
	$("undoClassifyButton").disabled = true;
	display(false);
	showStats();
	showSelection();
	register.onRead();
	facets.onRead();
	fragments.onRead();
	setStatus("Reset: " + fmt(before) + " → " + fmt(cloud.count) + " points in " + since(t0) + " ms (the last read)");
}

function editEnabled(on) {
	document.querySelectorAll("#tab-edit button").forEach(function (b) { b.disabled = !on; });
	$("undoSmoothButton").disabled = !on || !beforeSmooth;
	$("undoClassifyButton").disabled = !on || !beforeClassify;
	if (!on && drawing) setDrawing(false);
}

// --- write -------------------------------------------------------------------
// Every point is written: the file streams through createLasWriter in batches, onto disk through
// the browser's Save dialog (File System Access, Chrome / Edge), so page memory stays flat at any
// size. Without that API the file is assembled in memory and downloaded.
var WRITE_BATCH = 1000000;   // points per writePoints call for the edited cloud
var NO_LAZ = [4, 5, 9, 10];   // point formats the LAZ writer does not support

// LAZ for the formats that allow it; the button says what Save will write
function writeChoice() {
	var noLaz = NO_LAZ.indexOf(Number($("writeFormat").value)) >= 0;
	$("writeCompress").disabled = noLaz;
	if (noLaz) $("writeCompress").checked = false;
	$("writeButton").textContent = $("writeCompress").checked ? "Save as LAZ" : "Save as LAS";
}

// The edited cloud's own columns (the fields read, relative to the origin, and the writable extra
// columns, k values a point), points a to b; with facet columns, those too
function editedBatch(a, b, facetCols) {
	var c = cloud, out = { count: b - a };
	["x", "y", "z", "classification", "intensity", "returnNumber", "numberOfReturns", "red", "green", "blue"].forEach(function (k) {
		if (c[k]) out[k] = c[k].subarray(a, b);
	});
	writableExtra().forEach(function (e) {
		var k = e.type === "raw" ? e.size : 1;
		if (c[e.column]) out[e.column] = c[e.column].subarray(a * k, b * k);
	});
	if (facetCols) Object.keys(facetCols).forEach(function (k) { if (facetCols[k]) out[k] = facetCols[k].subarray(a, b); });
	return out;
}

// Where the file goes: { sink: { write(bytes, position) }, finish() -> Promise<File|Blob>, abort(), onDisk }.
// The Save dialog writes straight to disk; without it the bytes are kept as ordered parts (held
// once: fileParts.js) and downloaded.
async function openTarget(name) {
	if (window.showSaveFilePicker) {
		var handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "LAS / LAZ point cloud", accept: { "application/octet-stream": [name.slice(name.lastIndexOf("."))] } }] });
		var writable = await handle.createWritable();
		return {
			onDisk: true, name: handle.name,
			sink: { write: function (bytes, position) { return writable.write({ type: "write", position: position, data: bytes }); } },
			finish: async function () { await writable.close(); return handle.getFile(); },
			abort: function () { return writable.abort(); }
		};
	}
	var mem = createPartsSink();
	return {
		onDisk: false, name: name,
		sink: mem.sink,
		finish: async function () {
			var blob = new Blob(mem.parts(), { type: "application/octet-stream" });
			var a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = name;
			a.click();
			setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
			return blob;
		},
		abort: function () {}
	};
}

async function save() {
	var h = info.header, F = POINT_FORMATS[h.pointFormat].fields;
	var wf = Number($("writeFormat").value), compress = $("writeCompress").checked;
	// Save with facet / set / fragment: the cloud as read, the fields of whichever has run
	var fc = $("writeFacets").checked ? Object.assign({}, facets.columns() || {}, fragments.columns() || {}) : null;
	var fromEdit = edited || !!fc, target = null;
	var extra = writableExtra(), dropped = droppedExtra();
	if (fc) {
		// replace only the fields this save writes; a facet field already in the file stays when only fragments ran
		var ours = Object.keys(fc).filter(function (k) { return fc[k]; });
		extra = extra.filter(function (e) { return ours.indexOf(e.name) < 0 && ours.indexOf(e.column) < 0; });
		if (fc.facet) extra.push({ name: "facet", type: "u32", description: "las-laz-js findFacets" });
		if (fc.joint_set) extra.push({ name: "joint_set", type: "u16", description: "las-laz-js jointSets" });
		else delete fc.joint_set;
		if (fc.fragment) extra.push({ name: "fragment", type: "u32", description: "las-laz-js findFragments" });
	}
	var name = file.name.replace(/\.[^.]*$/, "") + "-las-laz-js" + (compress ? ".laz" : ".las");
	$("writeResult").className = "muted small";
	try {
		try { target = await openTarget(name); } catch (err) {
			if (err.name === "AbortError") { $("writeResult").textContent = "Save cancelled."; return; }
			throw err;
		}
		// Formats 6-10 carry the CRS as WKT only (LAS 1.4); an EPSG code alone cannot go there
		var crs, note = "";
		if (info.crs.wkt || (info.crs.epsg && wf < 6)) crs = { wkt: info.crs.wkt, epsg: info.crs.epsg };
		else if (info.crs.epsg) note = " The source has only an EPSG code, which point formats 6–10 cannot carry (they need WKT), so no coordinate system was written.";
		var names = Object.keys(classNames).length ? classNames : undefined;   // the lookup VLR: the file's names and the classes added
		var opts = { version: $("writeVersion").value, pointFormat: wf, crs: crs, classNames: names, compress: compress, software: "las-laz-js demo", extraBytes: extra };
		var t0 = performance.now(), total, done = 0, w;
		var tick = function (n) { done += n; $("progress").value = total ? done / total : 0; $("writeResult").textContent = "Writing " + fmt(done) + " of " + fmt(total) + " points…"; };
		if (fromEdit) {
			// at the header's scale; the offset from the edited cloud's world bounds (the stream needs both up front)
			total = cloud.count;
			var b = extent(cloud), wb = { minX: b.minX + origin.x, maxX: b.maxX + origin.x, minY: b.minY + origin.y, maxY: b.maxY + origin.y, minZ: b.minZ + origin.z, maxZ: b.maxZ + origin.z };
			w = await createLasWriter(target.sink, Object.assign(opts, { scale: h.scale, offset: chooseScaleOffset(wb).offset, localOrigin: origin }));
			for (var a = 0; a < total; a += WRITE_BATCH) {
				var batch = editedBatch(a, Math.min(total, a + WRITE_BATCH), fc);
				await w.writePoints(batch);
				tick(batch.count);
			}
		} else {
			// the whole file: every record that passes the Read tab's filters (Max points is a viewing
			// limit, so no thinning), every field, window by window straight into the writer; each window
			// waits for the one before to be written, so memory holds a window, never the file (LAZ
			// decodes on the library's worker pool)
			total = h.pointCount;
			w = await createLasWriter(target.sink, Object.assign(opts, { scale: h.scale, offset: h.offset }));
			var src = await openLas(file, { windowSize: Number($("windowMb").value) * 1048576 });
			for await (var chunk of src.chunks(Object.assign({
				fields: ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scanAngle", "userData", "pointSourceId"]
					.concat(F.gpsTime ? ["gpsTime"] : []).concat(F.red ? ["red", "green", "blue"] : []).concat(F.nir ? ["nir"] : []).concat(extra.length ? ["extra"] : []),
				classes: list($("classes").value), returns: list($("returns").value), bounds: boundsFilter()
			}, readCrop || {}))) {
				await w.writePoints(chunk);
				tick(chunk.count);
			}
		}
		var closed = await w.close();
		var out = await target.finish();
		var ms = since(t0);
		var back = (await openLas(out)).header.pointCount;
		var ok = back === closed.count;
		var kept = extra.length ? "; extra bytes: " + extra.length + " field" + (extra.length === 1 ? "" : "s") + " (" + extra.map(function (e) { return e.name || "undocumented"; }).join(", ") + ")" : "";
		if (dropped.length) kept += " (not written: " + dropped.join(", ") + " — array types are read, not written)";
		var what = fromEdit ? (edited ? ", the edited cloud" : ", the cloud as read") + ": x y z, class, intensity, returns" + (cloud.red ? ", colour" : "") +
			(readThinned ? "; the read was thinned to Max points, so set Max points to 0 and read again to edit and save every point" : "") : "";
		$("writeResult").textContent = "Saved " + target.name + (target.onDisk ? "" : " (downloaded)") + " (" + fmt(out.size) + " bytes, " + fmt(closed.count) + " points" + what + kept + ", written in " + ms + " ms). Round trip: " + (ok ? "OK, the header holds the same count." : "MISMATCH (" + fmt(back) + " in the header)") + note;
		$("writeResult").className = ok ? "muted small" : "error small";
	} catch (err) {
		if (target) try { await target.abort(); } catch (e) { /* already closed */ }
		var hint = /point formats 0-5 hold classes 0-31/.test(err.message) ? " Choose LAS 1.4 and point format 6 (or 7 / 8 to keep RGB)." : "";
		$("writeResult").textContent = err.message + hint;
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
			(c.index ? "  · record " + c.index[i] : "") + extraText(c, i) +
			(function () { var f = facets.facetOf(i); return f ? "  · facet " + f.id + " " + f.dip.toFixed(0) + "/" + ("00" + f.dipDirection.toFixed(0)).slice(-3) + (f.set ? " set " + f.set : "") : ""; })() +
			(function () { var g = fragments.fragmentOf(i); return g ? "  · fragment " + g.id + " size " + g.size.toFixed(2) + " · " + g.axes.map(function (v) { return v.toFixed(2); }).join(" / ") : ""; })();
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
// the side panel's width: drag its left edge (kept for next time, where storage allows); double-click for the default
(function () {
	var bar = $("panelResizer"), layout = document.querySelector(".layout"), KEY = "lasDemo.panelWidth";
	function setWidth(px) {
		if (px) layout.style.setProperty("--panel-width", Math.round(Math.max(280, Math.min(window.innerWidth - 300, px))) + "px");
		else layout.style.removeProperty("--panel-width");
	}
	try { setWidth(Number(localStorage.getItem(KEY)) || 0); } catch (e) { /* no storage: the default width */ }
	bar.addEventListener("pointerdown", function (e) {
		e.preventDefault();
		bar.setPointerCapture(e.pointerId);
		bar.classList.add("dragging");
		function move(ev) { setWidth(layout.getBoundingClientRect().right - ev.clientX); }
		function up() {
			bar.classList.remove("dragging");
			bar.removeEventListener("pointermove", move);
			bar.removeEventListener("pointerup", up);
			try { localStorage.setItem(KEY, String($("panel").getBoundingClientRect().width)); } catch (e2) { /* not kept */ }
		}
		bar.addEventListener("pointermove", move);
		bar.addEventListener("pointerup", up);
	});
	bar.addEventListener("dblclick", function () {
		setWidth(0);
		try { localStorage.removeItem(KEY); } catch (e) { /* nothing kept */ }
	});
})();
$("fileInput").addEventListener("change", function (e) { if (e.target.files[0]) openFile(e.target.files[0]); });
$("readButton").addEventListener("click", function () { read(); });
$("abortButton").addEventListener("click", stop);
$("writeButton").addEventListener("click", save);
$("writeFormat").addEventListener("change", writeChoice);
$("writeCompress").addEventListener("change", writeChoice);
// Save with facet / set / fragment: only while there are facets or fragments (checked each time the Write tab is shown)
document.querySelector('.tab[data-tab="write"]').addEventListener("click", function () {
	var has = !!(facets.columns() || fragments.columns());
	$("writeFacets").disabled = !has;
	if (!has) $("writeFacets").checked = false;
});
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
$("classifyButton").addEventListener("click", classify);
$("undoClassifyButton").addEventListener("click", undoClassify);
$("addClassButton").addEventListener("click", addClass);
$("cropReadButton").addEventListener("click", cropRead);
$("resetButton").addEventListener("click", reset);
// The read filters need a new read: say so rather than re-reading on every keystroke
["classes", "returns", "maxPoints", "boundsMin", "boundsMax", "dedupe", "windowMb"].forEach(function (id) {
	$(id).addEventListener("input", function () { if (cloud) $("readHint").classList.remove("hidden"); });
});
$("pointSize").addEventListener("input", function () { viewer.setPointSize(Number($("pointSize").value) || 2); });
$("version").textContent = "v" + VERSION;
refreshClassSelect();
$("drawCapText").textContent = fmt(DRAW_CAP);
window.addEventListener("dragover", function (e) { e.preventDefault(); $("dropOverlay").classList.remove("hidden"); });
window.addEventListener("dragleave", function (e) { if (!e.relatedTarget) $("dropOverlay").classList.add("hidden"); });
window.addEventListener("drop", function (e) {
	e.preventDefault();
	$("dropOverlay").classList.add("hidden");
	if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});
// The Register tab: the demo's state through getters, so it always sees the current cloud and frame
var register = initRegister({
	$: $, viewer: viewer, setStatus: setStatus, fmt: fmt, since: since, DRAW_CAP: DRAW_CAP,
	colours: colours, display: display, edit: edit, clearPolygon: clearPolygon,
	maxPoints: function () { return Number($("maxPoints").value) || 0; },
	isDrawing: function () { return drawing; },
	setOrigin: function (o) { origin = o; },
	get cloud() { return cloud; }, get origin() { return origin; }, get drawn() { return drawn; }, get drawnIdx() { return drawnIdx; }
});
// The Facets tab, the same way
var facets = initFacets({
	$: $, viewer: viewer, setStatus: setStatus, fmt: fmt, since: since, clearSelection: clearSelection, recolour: recolour, keepPoints: keepPoints,
	// replace the selection (not add to it), redraw and say so
	setSelection: function (s, name) {
		selection = s && s.length ? s : null;
		if (cloud) viewer.setColours(colours());
		showSelection();
		setStatus(name);
	},
	get cloud() { return cloud; }, get origin() { return origin; }, get selection() { return selection; }
});
// The Fragments tab, the same way
var fragments = initFragments({
	$: $, viewer: viewer, setStatus: setStatus, fmt: fmt, since: since, clearSelection: clearSelection, recolour: recolour, keepPoints: keepPoints,
	setSelection: function (s, name) {
		selection = s && s.length ? s : null;
		if (cloud) viewer.setColours(colours());
		showSelection();
		setStatus(name);
	},
	get cloud() { return cloud; }, get origin() { return origin; }, get selection() { return selection; }
});
// The Tiles tab: builds and edits go through the Worker; selectTiles runs here
var tiles = initTiles({
	$: $, viewer: viewer, call: call, setStatus: setStatus, fmt: fmt, since: since,
	file: function () { return file; }, origin: function () { return origin; },
	polygon: function () { return polyClosed && poly.length >= 6 ? poly.slice() : null; },
	setMainVisible: function (on) { viewer.setVisible("moving", on); },
	// the Edit tab's polygon tools work on the tiles too, with no cloud read
	polygonTools: function (on) { ["drawButton", "finishButton", "clearPolyButton", "topViewButton"].forEach(function (id) { $(id).disabled = !on && !cloud; }); }
});
window.lasDemo = { openFile: openFile, read: read, save: save, viewer: viewer, register: register, tiles: tiles, get cloud() { return cloud; }, get origin() { return origin; }, facets: facets, fragments: fragments };   // for checks from the console
