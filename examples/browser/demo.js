// examples/browser/demo.js
//==========================================================
// las-laz-js demo: drop a LAS file, read it in the library's Worker
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
	$("readButton").disabled = info.compressed;
	$("writeButton").disabled = true;
	if (info.compressed) { setStatus("This is a LAZ (compressed) file. Reading LAZ points arrives in las-laz-js 0.2.0.", true); return; }
	read();
}

function showHeader() {
	var h = info.header, t = $("headerTable");
	$("headerEmpty").classList.add("hidden");
	t.innerHTML = "";
	row(t, "Version", h.versionMajor + "." + h.versionMinor);
	row(t, "Point format", h.pointFormat + (info.compressed ? " (LAZ)" : "") + ", " + h.recordLength + " bytes");
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
		[r.userId, r.recordId, r.bytes.length, r.description].forEach(function (c) { tr.insertCell().textContent = c; });
	});
	var sel = $("writeFormat");
	sel.innerHTML = "";
	for (var f = 0; f <= 10; f++) { var o = document.createElement("option"); o.value = f; o.textContent = f; sel.appendChild(o); }
	sel.value = h.pointFormat;
	$("writeVersion").value = h.pointFormat >= 6 ? "1.4" : "1.2";
}

// --- read --------------------------------------------------------------------
async function read() {
	if (!info || info.compressed) return;
	if (readJob) await stop();
	viewer.clear();
	chunks = [];
	stats = { count: 0, classes: {}, minZ: Infinity, maxZ: -Infinity, first: 0 };
	$("viewerEmpty").classList.add("hidden");
	$("readButton").disabled = true; $("abortButton").disabled = false;
	await call("open", { blob: file, windowSize: Number($("windowMb").value) * 1048576 }).promise;
	var t0 = performance.now(), fitted = false;
	readJob = call("chunks", {
		fields: ["x", "y", "z", "classification", "intensity", "returnNumber"],
		classes: list($("classes").value), returns: list($("returns").value),
		maxPoints: Number($("maxPoints").value) || 0,
		localOrigin: origin, float32: true,
		colour: { by: $("colourBy").value, ramp: $("ramp").value }
	}, function (m) {
		if (m.type === "progress") { $("progress").value = m.fraction; return; }
		var c = m.chunk, n = c.count, pos = new Float32Array(n * 3);
		for (var i = 0; i < n; i++) { pos[i * 3] = c.x[i]; pos[i * 3 + 1] = c.y[i]; pos[i * 3 + 2] = c.z[i]; }
		viewer.addChunk(pos, c.colours, DRAW_CAP);
		chunks.push(c);
		for (var j = 0; j < n; j++) {
			stats.classes[c.classification[j]] = (stats.classes[c.classification[j]] || 0) + 1;
			if (c.z[j] < stats.minZ) stats.minZ = c.z[j];
			if (c.z[j] > stats.maxZ) stats.maxZ = c.z[j];
			if (c.returnNumber[j] === 1) stats.first++;
		}
		stats.count += n;
		if (!fitted) { viewer.fit(); fitted = true; }
		var secs = (performance.now() - t0) / 1000;
		$("stats").textContent = fmt(stats.count) + " / " + fmt(info.header.pointCount) + " points · " + secs.toFixed(1) + " s · " + fmt(Math.round(stats.count / Math.max(secs, 0.001))) + " pts/s";
		setStatus("Reading…");
	});
	try {
		await readJob.promise;
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

function showStats() {
	var t = $("statsTable");
	$("statsEmpty").classList.add("hidden");
	t.innerHTML = "";
	row(t, "Points read", fmt(stats.count));
	row(t, "First returns", fmt(stats.first));
	row(t, "Z range", (stats.minZ + origin.z).toFixed(3) + " … " + (stats.maxZ + origin.z).toFixed(3));
	var c = $("classTable");
	c.innerHTML = "<tr><th>Class</th><th>Points</th><th>Share</th></tr>";
	Object.keys(stats.classes).sort(function (a, b) { return a - b; }).forEach(function (k) {
		var tr = c.insertRow();
		[k, fmt(stats.classes[k]), (100 * stats.classes[k] / stats.count).toFixed(1) + " %"].forEach(function (v) { tr.insertCell().textContent = v; });
	});
}

// --- write -------------------------------------------------------------------
async function save() {
	$("writeResult").textContent = "Reading every field…";
	try {
		var cols = await call("readPoints", {
			fields: ["x", "y", "z", "intensity", "returnNumber", "numberOfReturns", "scanDirection", "edgeOfFlightLine", "classification", "classificationFlags", "scanAngle", "userData", "pointSourceId"]
				.concat(POINT_FORMATS[info.header.pointFormat].fields.gpsTime ? ["gpsTime"] : [])
				.concat(POINT_FORMATS[info.header.pointFormat].fields.red ? ["red", "green", "blue"] : [])
				.concat(POINT_FORMATS[info.header.pointFormat].fields.nir ? ["nir"] : []),
			classes: list($("classes").value), returns: list($("returns").value), maxPoints: Number($("maxPoints").value) || 0
		}).promise;
		var crs = info.crs.epsg ? { epsg: info.crs.epsg } : (info.crs.wkt ? { wkt: info.crs.wkt } : undefined);
		var bytes = await writeLas(cols, { version: $("writeVersion").value, pointFormat: Number($("writeFormat").value), scale: info.header.scale, offset: info.header.offset, crs: crs, software: "las-laz-js demo" });
		var check = await (await openLas(bytes)).readPoints({ fields: ["x"] });
		var ok = check.count === cols.count;
		var name = file.name.replace(/\.[^.]*$/, "") + "-las-laz-js.las";
		var a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
		a.download = name;
		a.click();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
		$("writeResult").textContent = "Saved " + name + " (" + fmt(bytes.length) + " bytes, " + fmt(cols.count) + " points). Round trip: " + (ok ? "OK, same count read back." : "MISMATCH (" + fmt(check.count) + " read back)");
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
window.addEventListener("dragover", function (e) { e.preventDefault(); $("dropOverlay").classList.remove("hidden"); });
window.addEventListener("dragleave", function (e) { if (!e.relatedTarget) $("dropOverlay").classList.add("hidden"); });
window.addEventListener("drop", function (e) {
	e.preventDefault();
	$("dropOverlay").classList.add("hidden");
	if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
});
window.lasDemo = { openFile: openFile, read: read, save: save };
