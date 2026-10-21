// examples/browser/demo.js
//==========================================================
// las-laz-js demo: drop a LAS or LAZ file, read it in the library's Worker
// (las-laz-js/worker) a window at a time, stream the points into a
// Three.js viewer, and drive the public API from the side panel.
// Imports the library from ../../src so it always runs current code.
//==========================================================

import { writeLas, openLas, POINT_FORMATS } from "../../src/index.js";
import { createViewer } from "./viewer.js";

var DRAW_CAP = 20000000;
var $ = function (id) { return document.getElementById(id); };
var viewer = createViewer($("viewer"));
var worker = new Worker(new URL("../../src/workers/lasWorker.js", import.meta.url), { type: "module" });
var nextId = 1, pending = new Map();
var file = null, info = null, origin = null, chunks = [], readJob = null, stats = null;

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

var t0 = 0, fitted = false;

// One set of columns (a chunk, or the whole deduplicated read) into the viewer and the stats
function take(c) {
	var n = c.count;
	if (!n) return;
	var pos = new Float32Array(n * 3);
	for (var i = 0; i < n; i++) { pos[i * 3] = c.x[i]; pos[i * 3 + 1] = c.y[i]; pos[i * 3 + 2] = c.z[i]; }
	// Only chunks the viewer draws are kept, so hover indexes match and nothing past the cap is held
	if (viewer.addChunk(pos, c.colours, DRAW_CAP) > 0) chunks.push(c);
	for (var j = 0; j < n; j++) {
		stats.classes[c.classification[j]] = (stats.classes[c.classification[j]] || 0) + 1;
		stats.returns[c.returnNumber[j]] = (stats.returns[c.returnNumber[j]] || 0) + 1;
		stats.intensity[c.intensity[j]]++;
		if (c.z[j] < stats.minZ) stats.minZ = c.z[j];
		if (c.z[j] > stats.maxZ) stats.maxZ = c.z[j];
	}
	stats.count += n;
	if (!fitted) { viewer.fit(); fitted = true; }
	var secs = (performance.now() - t0) / 1000;
	$("stats").textContent = fmt(stats.count) + " / " + fmt(info.header.pointCount) + " points · " + secs.toFixed(1) + " s · " + fmt(Math.round(stats.count / Math.max(secs, 0.001))) + " pts/s";
	setStatus("Reading…");
}

async function read() {
	if (!info) return;
	if (readJob) await stop();
	viewer.clear();
	chunks = [];
	stats = { count: 0, classes: {}, returns: {}, intensity: new Uint32Array(65536), minZ: Infinity, maxZ: -Infinity };
	$("viewerEmpty").classList.add("hidden");
	$("readButton").disabled = true; $("abortButton").disabled = false;
	await call("open", { blob: file, windowSize: Number($("windowMb").value) * 1048576 }).promise;
	t0 = performance.now(); fitted = false;
	var payload = {
		fields: ["x", "y", "z", "classification", "intensity", "returnNumber"],
		classes: list($("classes").value), returns: list($("returns").value), bounds: boundsFilter(),
		maxPoints: Number($("maxPoints").value) || 0,
		localOrigin: origin, float32: true,
		colour: colourOpts()
	};
	var tol = Number($("dedupe").value) || 0;
	var onEvent = function (m) {
		if (m.type === "progress") { $("progress").value = m.fraction; return; }
		take(m.chunk);
	};
	// dedupe needs every point at once, so it reads with readPoints; otherwise stream with chunks
	readJob = tol > 0 ? call("readPoints", Object.assign({ dedupe: tol }, payload), onEvent) : call("chunks", payload, onEvent);
	try {
		var result = await readJob.promise;
		if (tol > 0) take(result);
		viewer.fit();
		var drawn = viewer.drawnCount();
		setStatus("Read " + fmt(stats.count) + " points" + (drawn < stats.count ? " (showing " + fmt(drawn) + " of " + fmt(stats.count) + ")" : ""));
		$("progress").value = 1;
		showStats();
		$("writeButton").disabled = false;
	} catch (err) {
		setStatus(err.code === "ABORTED" ? "Stopped after " + fmt(stats.count) + " points" : err.message, err.code !== "ABORTED");
	} finally {
		readJob = null;
		$("readButton").disabled = false; $("abortButton").disabled = true;
	}
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
function share(n) { return (100 * n / stats.count).toFixed(1) + " %"; }

function showStats() {
	var t = $("statsTable");
	$("statsEmpty").classList.add("hidden");
	t.innerHTML = "";
	row(t, "Points read", fmt(stats.count));
	row(t, "Z range", stats.count ? (stats.minZ + origin.z).toFixed(3) + " … " + (stats.maxZ + origin.z).toFixed(3) : "—");
	var keys = function (o) { return Object.keys(o).sort(function (a, b) { return a - b; }); };
	table("classTable", ["Class", "Points", "Share"], keys(stats.classes).map(function (k) { return [k, fmt(stats.classes[k]), share(stats.classes[k])]; }));
	table("returnTable", ["Return", "Points", "Share"], keys(stats.returns).map(function (k) { return [k, fmt(stats.returns[k]), share(stats.returns[k])]; }));
	// 16 equal bins over the intensities actually present
	var h = stats.intensity, lo = 0, hi = 65535;
	while (lo < 65535 && !h[lo]) lo++;
	while (hi > 0 && !h[hi]) hi--;
	var rows = [];
	if (stats.count && lo <= hi) {
		var width = Math.max(1, Math.ceil((hi - lo + 1) / 16));
		for (var b = lo; b <= hi; b += width) {
			var n = 0, top = Math.min(hi, b + width - 1);
			for (var v = b; v <= top; v++) n += h[v];
			rows.push([b + " … " + top, fmt(n), share(n)]);
		}
	}
	table("intensityTable", ["Intensity", "Points", "Share"], rows);
}

// --- write -------------------------------------------------------------------
var WRITE_CAP = 5000000;   // every field of 5 M points is ~0.5 GB in a page; stream more with createLasWriter

async function save() {
	var h = info.header, F = POINT_FORMATS[h.pointFormat].fields;
	var wf = Number($("writeFormat").value);
	var limit = Math.min(Number($("maxPoints").value) || h.pointCount, WRITE_CAP);
	$("writeResult").textContent = "Reading every field…";
	$("writeResult").className = "muted small";
	try {
		var cols = await call("readPoints", {
			fields: ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scanAngle", "userData", "pointSourceId"]
				.concat(F.gpsTime ? ["gpsTime"] : []).concat(F.red ? ["red", "green", "blue"] : []).concat(F.nir ? ["nir"] : []),
			classes: list($("classes").value), returns: list($("returns").value), bounds: boundsFilter(), maxPoints: limit
		}).promise;
		// Formats 6-10 carry the CRS as WKT only (LAS 1.4); an EPSG code alone cannot go there
		var crs, note = "";
		if (info.crs.wkt || (info.crs.epsg && wf < 6)) crs = { wkt: info.crs.wkt, epsg: info.crs.epsg };
		else if (info.crs.epsg) note = " The source has only an EPSG code, which point formats 6–10 cannot carry (they need WKT), so no coordinate system was written.";
		var blob = await writeLas(cols, { version: $("writeVersion").value, pointFormat: wf, scale: h.scale, offset: h.offset, crs: crs, software: "las-laz-js demo", as: "blob" });
		var check = await (await openLas(blob)).readPoints({ fields: ["x"] });
		var ok = check.count === cols.count;
		var name = file.name.replace(/\.[^.]*$/, "") + "-las-laz-js.las";
		var a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = name;
		a.click();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
		var thinned = cols.count < h.pointCount && limit === WRITE_CAP ? " (thinned to the page's " + fmt(WRITE_CAP) + "-point limit)" : "";
		$("writeResult").textContent = "Saved " + name + " (" + fmt(blob.size) + " bytes, " + fmt(cols.count) + " points" + thinned + "). Round trip: " + (ok ? "OK, same count read back." : "MISMATCH (" + fmt(check.count) + " read back)") + note;
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
	if (hoverQueued || !chunks.length) return;
	hoverQueued = true;
	requestAnimationFrame(function () {
		hoverQueued = false;
		var hit = viewer.pick(lastMove.clientX, lastMove.clientY, 8);
		if (!hit) { $("hud").textContent = ""; return; }
		var c = chunks[hit.chunk], i = hit.index;
		$("hud").textContent = "X " + (c.x[i] + origin.x).toFixed(3) + "  Y " + (c.y[i] + origin.y).toFixed(3) + "  Z " + (c.z[i] + origin.z).toFixed(3) +
			"  · class " + c.classification[i] + "  · intensity " + c.intensity[i] + "  · return " + c.returnNumber[i];
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
$("readButton").addEventListener("click", read);
$("abortButton").addEventListener("click", stop);
$("writeButton").addEventListener("click", save);
$("colourBy").addEventListener("change", read);
$("ramp").addEventListener("change", read);
$("pointSize").addEventListener("input", function () { viewer.setPointSize(Number($("pointSize").value) || 2); });
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
