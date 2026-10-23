// examples/browser/register.js
//==========================================================
// The demo's Register tab, two modes.
// Align to a cloud: drop a reference cloud, pick the same features on
// both (each click snaps to the nearest drawn point of the layer being
// picked), Fit (fitTransform on the picks, then optional ICP,
// previewed), Apply, Undo.
// GCP: drop the surveyor's control file (grid), then the scan's target
// file, or pick targets on the cloud and name them; names are matched
// (matchControlPoints) and fitTransform moves the scan onto the grid.
// Both: a table of each pair's residuals (leave-one-out shows a bad
// pick), Copy transform ({ m, t } as JSON).
// Coordinates: picks are kept in world Float64. The reference is read
// about its own centre (so a reference on the grid keeps its mm while
// the scan sits near 0,0) and drawn relative to the main cloud's
// origin; more than FAR away it is drawn shifted to sit over the cloud,
// so both can be picked (display only: picks keep its true coordinates). Apply
// re-bases the main cloud: Float64 world, transformed, a new origin
// at the transformed centre, Float32 local again, so a scan moved far
// (a GCP fit onto the grid) keeps its millimetres on the GPU.
//==========================================================

import { alignCloud, fitTransform, transformPoints, interleavePositions, openLas, parseControlPoints, matchControlPoints } from "../../src/index.js";

var REF_RGB = [63, 182, 201];   // the reference cloud, one flat colour
var MIN = { rigid: 3, level: 2, scale: 3 };
var FAR = 10000;   // m: a reference further than this from the cloud is drawn shifted over it

/**
 * @param {object} ctx - the demo's state and helpers: $, viewer, setStatus, fmt, since, colours(),
 *   display(refit), edit(name, make), clearPolygon(), DRAW_CAP, maxPoints(), isDrawing(), and
 *   getters cloud, origin, drawn, drawnIdx; setOrigin(o).
 */
export function initRegister(ctx) {
	var $ = ctx.$, viewer = ctx.viewer, fmt = ctx.fmt;
	var mode = "align";
	// Align
	var ref = null;          // { cols (local Float32 x/y/z about refOrigin), origin, name }
	var pairs = [];          // [{ from: [x, y, z] world on the moving cloud, to: [x, y, z] world on the reference }]
	var half = null;         // a moving pick waiting for its reference pick
	// GCP
	var grid = null;         // parseControlPoints of the grid file
	var scanFile = null;     // parseControlPoints of the scan's target file, or null
	var scanPicks = [];      // [{ name, xyz: [x, y, z] world }] picked on the cloud
	// both
	var picking = false;
	var result = null;       // the last Fit: { transform, fit, icp? }
	var previewing = false;
	var before = null;       // { cloud, origin } before the last Apply, for Undo register

	function status(text, isError) { ctx.setStatus("Register: " + text, isError); }
	function model() { return $("regModel").value; }
	// The display shift of the reference: none when near; when far, onto the cloud's origin
	function refShift() {
		if (!ref || !ctx.origin) return { x: 0, y: 0, z: 0 };
		var dx = ref.origin.x - ctx.origin.x, dy = ref.origin.y - ctx.origin.y, dz = ref.origin.z - ctx.origin.z;
		return Math.hypot(dx, dy, dz) > FAR ? { x: -dx, y: -dy, z: -dz } : { x: 0, y: 0, z: 0 };
	}
	function worldOf(i) { var c = ctx.cloud, o = ctx.origin; return [c.x[i] + o.x, c.y[i] + o.y, c.z[i] + o.z]; }

	// The pairs to fit, in either mode: { names, from, to, unmatchedScan?, unmatchedGrid? }
	function current() {
		if (mode === "align") {
			var from = [], to = [];
			pairs.forEach(function (p) { from.push(p.from[0], p.from[1], p.from[2]); to.push(p.to[0], p.to[1], p.to[2]); });
			return { names: pairs.map(function (p, i) { return String(i + 1); }), from: from, to: to };
		}
		if (!grid) return { names: [], from: [], to: [], unmatchedScan: [], unmatchedGrid: [] };
		var m = matchControlPoints(scanList(), grid);
		return m;
	}
	// The scan's targets: the file's rows, then the picks
	function scanList() {
		var names = [], xyz = [];
		if (scanFile) { names = scanFile.names.slice(); xyz = Array.from(scanFile.xyz); }
		scanPicks.forEach(function (p) { names.push(p.name); xyz.push(p.xyz[0], p.xyz[1], p.xyz[2]); });
		return { names: names, xyz: xyz };
	}

	// --- drawing ----------------------------------------------------------------
	function drawReference() {
		if (!ref || !ctx.origin) { viewer.clearReference(); return; }
		var c = ref.cols, n = c.count, o = ctx.origin, sh = refShift();
		var dx = ref.origin.x - o.x + sh.x, dy = ref.origin.y - o.y + sh.y, dz = ref.origin.z - o.z + sh.z;
		var pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
		for (var i = 0; i < n; i++) {
			pos[i * 3] = c.x[i] + dx; pos[i * 3 + 1] = c.y[i] + dy; pos[i * 3 + 2] = c.z[i] + dz;
			col[i * 3] = REF_RGB[0]; col[i * 3 + 1] = REF_RGB[1]; col[i * 3 + 2] = REF_RGB[2];
		}
		viewer.setReference(pos, col);
		var far = sh.x || sh.y || sh.z;
		$("refInfo").textContent = ref.name + " · " + fmt(c.count) + " points" + (far ? " · drawn shifted " + fmt(Math.round(Math.hypot(sh.x, sh.y, sh.z) / 1000)) + " km to sit over your cloud (picks keep its true coordinates)" : "");
	}
	function drawMarkers() {
		var o = ctx.origin, list = [], sh = refShift();
		if (!o) { viewer.setMarkers([]); return; }
		function add(p, label, layer) {
			var s = layer === "reference" ? sh : { x: 0, y: 0, z: 0 };
			list.push({ x: p[0] - o.x + s.x, y: p[1] - o.y + s.y, z: p[2] - o.z + s.z, label: label, layer: layer });
		}
		if (mode === "align") {
			pairs.forEach(function (p, i) { add(p.from, String(i + 1), "moving"); add(p.to, String(i + 1), "reference"); });
			if (half) add(half, String(pairs.length + 1), "moving");
		} else {
			scanPicks.forEach(function (p) { add(p.xyz, p.name, "moving"); });
			if (scanFile) for (var i = 0; i < scanFile.names.length; i++) add([scanFile.xyz[3 * i], scanFile.xyz[3 * i + 1], scanFile.xyz[3 * i + 2]], scanFile.names[i], "moving");
		}
		viewer.setMarkers(list);
	}
	function endPreview() {
		if (!previewing) return;
		previewing = false;
		ctx.display(false);
	}

	// --- the pairs table ----------------------------------------------------------
	function mm(v) { return v === v ? (v * 1000).toFixed(1) : "—"; }
	function showPairs() {
		var t = $("pairTable"), f = null, c = current(), n = c.names.length;
		if (n >= MIN[model()]) { try { f = fitTransform(c.from, c.to, { model: model() }); } catch (e) { f = null; } }
		t.innerHTML = "<tr><th>" + (mode === "align" ? "#" : "Name") + "</th><th>dH mm</th><th>dZ mm</th><th>3D mm</th><th>Left out mm</th><th></th></tr>";
		c.names.forEach(function (name, i) {
			var tr = t.insertRow();
			if (f && f.worst === i && n > MIN[model()]) tr.className = "worst";
			[name, f ? mm(f.dH[i]) : "—", f ? mm(f.dZ[i]) : "—", f ? mm(f.residuals[i]) : "—", f ? mm(f.looResiduals[i]) : "—"].forEach(function (v) { tr.insertCell().textContent = v; });
			var cell = tr.insertCell(), pick = mode === "align" ? i : scanPicks.findIndex(function (p) { return p.name === name; });
			if (pick < 0) return;   // a row from the scan file: remove it there
			var del = document.createElement("button");
			del.className = "icon-button small"; del.textContent = "×"; del.title = "Delete " + name;
			del.addEventListener("click", function () { if (mode === "align") pairs.splice(pick, 1); else scanPicks.splice(pick, 1); changed(); });
			cell.appendChild(del);
		});
		var info = n + " pairs" + (f ? " · RMS " + mm(f.rms) + " mm (" + model() + ")" : n ? " · " + model() + " needs " + MIN[model()] : "");
		if (mode === "align") info += half ? " · pick the same point on the reference (orange)" : picking ? " · pick a point on your cloud" : "";
		else {
			if (c.unmatchedScan.length) info += " · scan only: " + c.unmatchedScan.join(", ");
			if (c.unmatchedGrid.length) info += " · grid only: " + c.unmatchedGrid.join(", ");
			if (picking) info += " · click a target on your cloud";
		}
		$("pairInfo").textContent = info;
		$("regFit").disabled = !ctx.cloud || n < MIN[model()] || (mode === "align" && !ref);
		$("regIcp").disabled = mode !== "align";
		showPicks();
	}
	// GCP: the picked targets with editable names
	function showPicks() {
		var t = $("gcpPickTable");
		t.innerHTML = scanPicks.length ? "<tr><th>Picked target</th><th>E</th><th>N</th><th>RL</th></tr>" : "";
		scanPicks.forEach(function (p) {
			var tr = t.insertRow(), input = document.createElement("input");
			input.type = "text"; input.value = p.name; input.size = 8;
			input.addEventListener("change", function () {
				var name = input.value.trim();
				if (!name || (name !== p.name && taken(name))) { status(name ? "the name " + name + " is used already" : "a target needs a name", true); input.value = p.name; return; }
				p.name = name; changed();
			});
			tr.insertCell().appendChild(input);
			p.xyz.forEach(function (v) { tr.insertCell().textContent = v.toFixed(3); });
		});
	}
	function taken(name) {
		return scanPicks.some(function (p) { return p.name === name; }) || !!(scanFile && scanFile.names.indexOf(name) >= 0);
	}
	function nextName() {
		if (grid) for (var i = 0; i < grid.names.length; i++) if (!taken(grid.names[i])) return grid.names[i];
		for (var k = 1; ; k++) if (!taken("T" + k)) return "T" + k;
	}
	function changed() {
		endPreview();
		result = null;
		$("regApply").disabled = true; $("regCopy").disabled = true;
		drawMarkers();
		showPairs();
	}

	// --- picking ------------------------------------------------------------------
	function setPicking(on) {
		picking = on && !!ctx.cloud && (mode === "gcp" || !!ref);
		if (!picking) half = null;
		["regPick", "gcpPick"].forEach(function (id) {
			$(id).classList.toggle("active", picking);
		});
		$("regPick").textContent = picking && mode === "align" ? "Picking…" : "Pick pairs";
		$("gcpPick").textContent = picking && mode === "gcp" ? "Picking…" : "Pick targets";
		changed();
	}
	function pickAt(clientX, clientY) {
		if (mode === "gcp" || !half) {
			var hit = viewer.pick(clientX, clientY, 8, "moving");
			if (!hit) { status("no point of your cloud under the cursor", true); return; }
			var w = worldOf(ctx.drawnIdx ? ctx.drawnIdx[hit.index] : hit.index);
			if (mode === "gcp") scanPicks.push({ name: nextName(), xyz: w });
			else half = w;
		} else {
			var h2 = viewer.pick(clientX, clientY, 8, "reference");
			if (!h2) { status("no reference point under the cursor (orange marker: pick its twin on the cyan cloud)", true); return; }
			var r = ref.cols, j = h2.index;
			pairs.push({ from: half, to: [r.x[j] + ref.origin.x, r.y[j] + ref.origin.y, r.z[j] + ref.origin.z] });
			half = null;
		}
		changed();
	}
	var downAt = null;
	$("viewer").addEventListener("pointerdown", function (e) { downAt = { x: e.clientX, y: e.clientY }; });
	$("viewer").addEventListener("pointerup", function (e) {
		var d = downAt;
		downAt = null;
		if (!picking || ctx.isDrawing() || !d || e.button !== 0) return;
		var dx = e.clientX - d.x, dy = e.clientY - d.y;
		if (dx * dx + dy * dy < 16) pickAt(e.clientX, e.clientY);
	});
	window.addEventListener("keydown", function (e) { if (e.key === "Escape" && half) { half = null; changed(); } });

	// --- files ----------------------------------------------------------------------
	async function loadReference(file) {
		if (!ctx.cloud) { status("read your cloud first, then drop the reference", true); return; }
		var t0 = performance.now();
		status("reading the reference " + file.name + "…");
		try {
			// about its own centre: a reference on the grid keeps its mm though the scan is near 0,0
			var las = await openLas(file), hb = las.header.bounds;
			var ro = { x: (hb.minX + hb.maxX) / 2, y: (hb.minY + hb.maxY) / 2, z: (hb.minZ + hb.maxZ) / 2 };
			var pts = await las.readPoints({ fields: ["x", "y", "z"], localOrigin: ro, float32: true, maxPoints: ctx.maxPoints() || undefined });
			ref = { cols: { count: pts.count, x: pts.x, y: pts.y, z: pts.z }, origin: ro, name: file.name };
		} catch (err) { status(err.message, true); return; }
		drawReference();
		viewer.fit();
		pairs = []; half = null;
		setPicking(true);
		status("reference " + file.name + ": " + fmt(ref.cols.count) + " points in " + ctx.since(t0) + " ms — pick a point on your cloud, then the same point on the reference");
	}
	async function loadControl(file, which) {
		try {
			var list = parseControlPoints(await file.text());
			if (which === "grid") { grid = list; $("gcpGridInfo").textContent = file.name + " · " + list.names.length + " points"; }
			else {
				var clash = list.names.filter(function (n) { return scanPicks.some(function (p) { return p.name === n; }); });
				if (clash.length) { status("the scan file repeats picked names: " + clash.join(", "), true); return; }
				scanFile = list; $("gcpScanInfo").textContent = file.name + " · " + list.names.length + " targets";
			}
			status(file.name + ": " + list.names.length + " points");
		} catch (err) { status(file.name + ": " + err.message, true); return; }
		changed();
	}

	// --- fit, preview, apply, undo, copy -----------------------------------------
	function fit() {
		var c = current(), o = ctx.origin, t0 = performance.now();
		var icp = mode === "align" && $("regIcp").checked ? { maxDistance: Number($("regMaxDist").value) } : false;
		status("fitting" + (icp ? " and ICP…" : "…"));
		requestAnimationFrame(function () { setTimeout(function () {
			try {
				if (mode === "align") result = alignCloud(ctx.cloud, ref.cols, { pairs: { from: c.from, to: c.to }, model: model(), movingOrigin: [o.x, o.y, o.z], fixedOrigin: [ref.origin.x, ref.origin.y, ref.origin.z], icp: icp });
				else { var f = fitTransform(c.from, c.to, { model: model() }); result = { transform: f.transform, fit: f }; }
			} catch (err) { result = null; status(err.message, true); return; }
			preview(result.transform);
			$("regApply").disabled = false; $("regCopy").disabled = false;
			var r = result, note = "RMS " + mm(r.fit.rms) + " mm on the " + (mode === "align" ? "picks" : "control points") + " (" + model() + ")";
			if (r.icp) note += " · ICP " + mm(r.icp.rmsBefore) + " → " + mm(r.icp.rmsAfter) + " mm point-to-plane, " + r.icp.iterations + " iterations" + (r.icp.converged ? "" : " (not converged)") + ", overlap " + fmt(r.icp.used) + " of " + fmt(r.icp.sampled);
			status(note + " in " + ctx.since(t0) + " ms — previewed; Apply to keep it");
		}, 0); });
	}
	// The drawn points moved by T (world): over the reference as it is drawn (Align), or about
	// their own new centre (GCP: onto the grid, likely far from where they were)
	function preview(T) {
		var d = ctx.drawn, o0 = ctx.origin, n = d.count, sh = refShift(), o = o0;
		if (mode === "align") o = { x: o0.x - sh.x, y: o0.y - sh.y, z: o0.z - sh.z };
		else {
			var m = T.m, t = T.t;
			o = { x: m[0] * o0.x + m[1] * o0.y + m[2] * o0.z + t[0], y: m[3] * o0.x + m[4] * o0.y + m[5] * o0.z + t[1], z: m[6] * o0.x + m[7] * o0.y + m[8] * o0.z + t[2] };
		}
		var w = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) }, i;
		for (i = 0; i < n; i++) { w.x[i] = d.x[i] + o0.x; w.y[i] = d.y[i] + o0.y; w.z[i] = d.z[i] + o0.z; }
		var moved = transformPoints(w, T, { inPlace: true });
		viewer.clear();
		viewer.addChunk(interleavePositions(moved, { origin: o, float32: true }), ctx.colours(), ctx.DRAW_CAP);
		if (mode === "gcp") viewer.fit();   // onto the grid: likely far from where it was
		previewing = true;
	}
	// Move the cloud by T (world) and re-base it: Float64 world, a new origin at the transformed
	// centre, Float32 local again (so a far move keeps its millimetres)
	function applyWorld(T, name) {
		var c = ctx.cloud, o = ctx.origin, n = c.count;
		var w = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
		for (var i = 0; i < n; i++) { w.x[i] = c.x[i] + o.x; w.y[i] = c.y[i] + o.y; w.z[i] = c.z[i] + o.z; }
		var m = transformPoints(w, T, { inPlace: true });
		var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		for (i = 0; i < n; i++) {
			var p = [m.x[i], m.y[i], m.z[i]];
			for (var k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
		}
		var no = n ? { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 } : o;
		var x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
		for (i = 0; i < n; i++) { x[i] = m.x[i] - no.x; y[i] = m.y[i] - no.y; z[i] = m.z[i] - no.z; }
		var prior = { cloud: c, origin: o };
		previewing = false;
		ctx.clearPolygon();   // it was drawn in the old frame
		ctx.edit(name, function () {
			ctx.setOrigin(no);
			return { cloud: Object.assign({}, c, { x: x, y: y, z: z }), keep: true, transformed: true };
		});
		before = prior;
		$("regUndo").disabled = false;
		drawReference();
		drawMarkers();
		viewer.fit();
	}
	function apply() {
		if (!result) return;
		applyWorld(result.transform, "Register");
		// the pairs and targets were in the old frame
		pairs = []; half = null; scanPicks = []; scanFile = null; $("gcpScanInfo").textContent = "none";
		result = null;
		$("regApply").disabled = true;
		setPicking(false);
	}
	function undo() {
		if (!before) return;
		var prior = before;
		previewing = false;
		ctx.clearPolygon();
		ctx.edit("Undo register", function () { ctx.setOrigin(prior.origin); return { cloud: prior.cloud, keep: true }; });
		before = null;
		$("regUndo").disabled = true;
		drawReference();
		drawMarkers();
		viewer.fit();
	}
	async function copy() {
		if (!result) return;
		try {
			await navigator.clipboard.writeText(JSON.stringify(result.transform));
			status("transform copied: { m, t } as JSON, world to world");
		} catch (err) { status("could not copy (" + err.message + ")", true); }
	}
	function setMode(m) {
		mode = m;
		$("regAlign").classList.toggle("hidden", m !== "align");
		$("regGcp").classList.toggle("hidden", m !== "gcp");
		setPicking(false);
	}

	// --- wiring -------------------------------------------------------------------
	$("regMode").addEventListener("change", function () { setMode($("regMode").value); });
	$("refFile").addEventListener("change", function (e) { if (e.target.files[0]) loadReference(e.target.files[0]); });
	$("gcpGrid").addEventListener("change", function (e) { if (e.target.files[0]) loadControl(e.target.files[0], "grid"); });
	$("gcpScan").addEventListener("change", function (e) { if (e.target.files[0]) loadControl(e.target.files[0], "scan"); });
	$("regPick").addEventListener("click", function () { setPicking(!picking); });
	$("gcpPick").addEventListener("click", function () { setPicking(!picking); });
	$("regClear").addEventListener("click", function () { pairs = []; half = null; changed(); });
	$("gcpClear").addEventListener("click", function () { scanPicks = []; changed(); });
	$("regModel").addEventListener("change", changed);
	$("regFit").addEventListener("click", fit);
	$("regApply").addEventListener("click", apply);
	$("regUndo").addEventListener("click", undo);
	$("regCopy").addEventListener("click", copy);
	$("regShowRef").addEventListener("change", function () { viewer.setVisible("reference", $("regShowRef").checked); });
	setMode("align");

	return {
		/** Any other edit ends Undo register; a Register edit keeps it. */
		onEdit: function (name) {
			if (name === "Register" || name === "Undo register") return;
			before = null; $("regUndo").disabled = true;
			previewing = false;
		},
		/** Another file opened: the picks and the scan targets belonged to the last one. */
		onOpen: function () {
			pairs = []; half = null; scanPicks = []; scanFile = null; result = null;
			$("gcpScanInfo").textContent = "none";
			setPicking(false);
		},
		/** A new read or Reset: the frame may have changed; drop the preview and the undo. */
		onRead: function () {
			previewing = false; before = null; result = null; half = null;
			$("regUndo").disabled = true; $("regApply").disabled = true; $("regCopy").disabled = true;
			drawReference(); drawMarkers(); showPairs();
		},
		isPicking: function () { return picking; },
		/** For checks from the console. */
		debug: function () { return { ref: ref, pairs: pairs, scanPicks: scanPicks, scanFile: scanFile, grid: grid, result: result }; }
	};
}
