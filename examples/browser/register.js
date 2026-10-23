// examples/browser/register.js
//==========================================================
// The demo's Register tab. Align to a cloud: drop a reference cloud,
// pick the same features on both (each click snaps to the nearest
// drawn point of the layer being picked), see each pair's residuals
// (leave-one-out shows a bad pick), Fit (fitTransform on the picks,
// then optional ICP, previewed), Apply, Undo.
// Coordinates: picks are kept in world Float64. The reference keeps
// its own origin (refOrigin, the main cloud's origin when it was read)
// and is drawn relative to the main cloud's current origin. Apply
// re-bases the main cloud: Float64 world, transformed, a new origin
// at the transformed centre, Float32 local again, so a scan moved far
// (a GCP fit onto the grid) keeps its millimetres on the GPU.
//==========================================================

import { alignCloud, fitTransform, transformPoints, interleavePositions, openLas } from "../../src/index.js";

var REF_RGB = [63, 182, 201];   // the reference cloud, one flat colour
var MIN = { rigid: 3, level: 2, scale: 3 };

/**
 * @param {object} ctx - the demo's state and helpers: $, viewer, setStatus, fmt, since, colours(),
 *   display(refit), edit(name, make), clearPolygon(), DRAW_CAP, maxPoints(), isDrawing(), and
 *   getters cloud, origin, drawn, drawnIdx; setOrigin(o).
 */
export function initRegister(ctx) {
	var $ = ctx.$, viewer = ctx.viewer, fmt = ctx.fmt;
	var ref = null;          // { cols (local Float32 x/y/z about refOrigin), origin, name }
	var pairs = [];          // [{ from: [x, y, z] world on the moving cloud, to: [x, y, z] world on the reference }]
	var half = null;         // a moving pick waiting for its reference pick
	var picking = false;
	var result = null;       // the last Fit: { transform, fit, icp? }
	var previewing = false;
	var before = null;       // { cloud, origin } before the last Apply, for Undo register

	function status(text, isError) { ctx.setStatus("Register: " + text, isError); }
	function model() { return $("regModel").value; }

	// --- drawing ----------------------------------------------------------------
	function drawReference() {
		if (!ref || !ctx.origin) { viewer.clearReference(); return; }
		var c = ref.cols, n = c.count, o = ctx.origin;
		var dx = ref.origin.x - o.x, dy = ref.origin.y - o.y, dz = ref.origin.z - o.z;
		var pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
		for (var i = 0; i < n; i++) {
			pos[i * 3] = c.x[i] + dx; pos[i * 3 + 1] = c.y[i] + dy; pos[i * 3 + 2] = c.z[i] + dz;
			col[i * 3] = REF_RGB[0]; col[i * 3 + 1] = REF_RGB[1]; col[i * 3 + 2] = REF_RGB[2];
		}
		viewer.setReference(pos, col);
	}
	function drawMarkers() {
		var o = ctx.origin, list = [];
		if (!o) { viewer.setMarkers([]); return; }
		pairs.forEach(function (p, i) {
			list.push({ x: p.from[0] - o.x, y: p.from[1] - o.y, z: p.from[2] - o.z, label: String(i + 1), layer: "moving" });
			list.push({ x: p.to[0] - o.x, y: p.to[1] - o.y, z: p.to[2] - o.z, label: String(i + 1), layer: "reference" });
		});
		if (half) list.push({ x: half[0] - o.x, y: half[1] - o.y, z: half[2] - o.z, label: String(pairs.length + 1), layer: "moving" });
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
		var t = $("pairTable"), f = null;
		var from = [], to = [];
		pairs.forEach(function (p) { from.push(p.from[0], p.from[1], p.from[2]); to.push(p.to[0], p.to[1], p.to[2]); });
		if (pairs.length >= MIN[model()]) { try { f = fitTransform(from, to, { model: model() }); } catch (e) { f = null; } }
		t.innerHTML = "<tr><th>#</th><th>dH mm</th><th>dZ mm</th><th>3D mm</th><th>Left out mm</th><th></th></tr>";
		pairs.forEach(function (p, i) {
			var tr = t.insertRow();
			if (f && f.worst === i && pairs.length > MIN[model()]) tr.className = "worst";
			[String(i + 1), f ? mm(f.dH[i]) : "—", f ? mm(f.dZ[i]) : "—", f ? mm(f.residuals[i]) : "—", f ? mm(f.looResiduals[i]) : "—"].forEach(function (v) { tr.insertCell().textContent = v; });
			var del = document.createElement("button");
			del.className = "icon-button small"; del.textContent = "×"; del.title = "Delete pair " + (i + 1);
			del.addEventListener("click", function () { pairs.splice(i, 1); changed(); });
			tr.insertCell().appendChild(del);
		});
		$("pairInfo").textContent = pairs.length + " pairs" + (f ? " · RMS " + mm(f.rms) + " mm (picks, " + model() + ")" : pairs.length ? " · " + model() + " needs " + MIN[model()] : "") + (half ? " · pick the same point on the reference (orange)" : picking ? " · pick a point on your cloud" : "");
		$("regFit").disabled = !ref || !ctx.cloud || pairs.length < MIN[model()];
	}
	function changed() {
		endPreview();
		result = null;
		$("regApply").disabled = true;
		drawMarkers();
		showPairs();
	}

	// --- picking ------------------------------------------------------------------
	function setPicking(on) {
		picking = on && !!ref && !!ctx.cloud;
		if (!picking) half = null;
		$("regPick").classList.toggle("active", picking);
		$("regPick").textContent = picking ? "Picking…" : "Pick pairs";
		changed();
	}
	function pickAt(clientX, clientY) {
		var o = ctx.origin;
		if (!half) {
			var hit = viewer.pick(clientX, clientY, 8, "moving");
			if (!hit) { status("no point of your cloud under the cursor", true); return; }
			var c = ctx.cloud, i = ctx.drawnIdx ? ctx.drawnIdx[hit.index] : hit.index;
			half = [c.x[i] + o.x, c.y[i] + o.y, c.z[i] + o.z];
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

	// --- the reference cloud ------------------------------------------------------
	async function loadReference(file) {
		if (!ctx.cloud) { status("read your cloud first, then drop the reference", true); return; }
		var t0 = performance.now(), o = ctx.origin;
		status("reading the reference " + file.name + "…");
		try {
			var las = await openLas(file);
			var pts = await las.readPoints({ fields: ["x", "y", "z"], localOrigin: o, float32: true, maxPoints: ctx.maxPoints() || undefined });
			ref = { cols: { count: pts.count, x: pts.x, y: pts.y, z: pts.z }, origin: { x: o.x, y: o.y, z: o.z }, name: file.name };
		} catch (err) { status(err.message, true); return; }
		$("refInfo").textContent = file.name + " · " + fmt(ref.cols.count) + " points";
		drawReference();
		viewer.fit();
		pairs = []; half = null;
		setPicking(true);
		status("reference " + file.name + ": " + fmt(ref.cols.count) + " points in " + ctx.since(t0) + " ms — pick a point on your cloud, then the same point on the reference");
	}

	// --- fit, preview, apply, undo ------------------------------------------------
	function fit() {
		var from = [], to = [];
		pairs.forEach(function (p) { from.push(p.from[0], p.from[1], p.from[2]); to.push(p.to[0], p.to[1], p.to[2]); });
		var icp = $("regIcp").checked ? { maxDistance: Number($("regMaxDist").value) } : false;
		var o = ctx.origin, t0 = performance.now();
		status("fitting" + (icp ? " and ICP…" : "…"));
		requestAnimationFrame(function () { setTimeout(function () {
			try {
				result = alignCloud(ctx.cloud, ref.cols, { pairs: { from: from, to: to }, model: model(), movingOrigin: [o.x, o.y, o.z], fixedOrigin: [ref.origin.x, ref.origin.y, ref.origin.z], icp: icp });
			} catch (err) { result = null; status(err.message, true); return; }
			preview(result.transform);
			$("regApply").disabled = false;
			var r = result, note = "RMS " + mm(r.fit.rms) + " mm on the picks (" + model() + ")";
			if (r.icp) note += " · ICP " + mm(r.icp.rmsBefore) + " → " + mm(r.icp.rmsAfter) + " mm point-to-plane, " + r.icp.iterations + " iterations" + (r.icp.converged ? "" : " (not converged)") + ", overlap " + fmt(r.icp.used) + " of " + fmt(r.icp.sampled);
			status(note + " in " + ctx.since(t0) + " ms — previewed; Apply to keep it");
		}, 0); });
	}
	// The drawn points moved by T (world), in the current local frame
	function preview(T) {
		var d = ctx.drawn, o = ctx.origin, n = d.count;
		var w = { count: n, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
		for (var i = 0; i < n; i++) { w.x[i] = d.x[i] + o.x; w.y[i] = d.y[i] + o.y; w.z[i] = d.z[i] + o.z; }
		var moved = transformPoints(w, T, { inPlace: true });
		viewer.clear();
		viewer.addChunk(interleavePositions(moved, { origin: o, float32: true }), ctx.colours(), ctx.DRAW_CAP);
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
	}
	function apply() {
		if (!result) return;
		applyWorld(result.transform, "Register");
		pairs = []; half = null; result = null;
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
	}

	// --- wiring -------------------------------------------------------------------
	$("refFile").addEventListener("change", function (e) { if (e.target.files[0]) loadReference(e.target.files[0]); });
	$("regPick").addEventListener("click", function () { setPicking(!picking); });
	$("regClear").addEventListener("click", function () { pairs = []; half = null; changed(); });
	$("regModel").addEventListener("change", changed);
	$("regFit").addEventListener("click", fit);
	$("regApply").addEventListener("click", apply);
	$("regUndo").addEventListener("click", undo);
	$("regShowRef").addEventListener("change", function () { viewer.setVisible("reference", $("regShowRef").checked); });
	showPairs();

	return {
		/** Any other edit ends Undo register; a Register edit keeps it. */
		onEdit: function (name) {
			if (name === "Register" || name === "Undo register") return;
			before = null; $("regUndo").disabled = true;
			previewing = false;
		},
		/** A new read or Reset: the frame may have changed; drop the preview and the undo. */
		onRead: function () {
			previewing = false; before = null; result = null; half = null;
			$("regUndo").disabled = true; $("regApply").disabled = true;
			drawReference(); drawMarkers(); showPairs();
		},
		isPicking: function () { return picking; }
	};
}
