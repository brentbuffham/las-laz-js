// examples/browser/fragments.js
//==========================================================
// The demo's Fragments tab: findFragments on the selection (a polygon
// round the muckpile) or the whole cloud, the camera's position as the
// viewpoint. Colours by fragment (the Colour tab's list), outlines on
// the cloud, a hover line, Select fragment (the one last hovered) and
// Select oversize (the points of fragments above a size: the selection,
// to delete, Classify or crop), a warning when one fragment covers a
// quarter of the surface (the floor or a wall in the run), the size curve
// (sizeDistribution: model, weight, fit from, fines; sizeChart.js) with
// its P-values, Fragments and Curve CSV, and a DXF of the outlines. Results are in the cloud's local frame;
// CSV centroids are world coordinates.
//==========================================================

import { findFragments, sizeDistribution } from "../../src/index.js";
import { writeDxf } from "./facets.js";
import { drawSizeChart } from "./sizeChart.js";

var NONE_RGB = [90, 90, 90], FLOOR_SHARE = 0.25;

// A fragment's colour: hues spread by the golden angle, offset from the facet colours
function fragmentRgb(id) {
	var h = (id * 137.508 + 200) % 360, s = 0.7, l = 0.55, a = s * Math.min(l, 1 - l);
	function f(k) { var t = (k + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1)))); }
	return [f(0), f(8), f(4)];
}

/**
 * @param {object} ctx - $, viewer, setStatus, fmt, since, setSelection(sel, name), clearSelection(), recolour(), keepPoints,
 *   onResult(), and getters cloud, origin, selection.
 */
export function initFragments(ctx) {
	var $ = ctx.$, fmt = ctx.fmt;
	var res = null;   // { fr (findFragments on the run's points), idx (run point -> cloud point, or null), fragment (per cloud point), psd }
	var hovered = 0;   // the fragment under the pointer last (Select fragment)

	function status(t, err) { ctx.setStatus("Fragments: " + t, err); }
	function num(id, def) { var v = $(id).value.trim(); return v === "" ? def : Number(v); }
	function m(v) { return v.toFixed(v < 1 ? 3 : 2); }

	// --- run ------------------------------------------------------------------
	function run() {
		var cloud = ctx.cloud;
		if (!cloud) return;
		var sel = ctx.selection, cols = { count: cloud.count, x: cloud.x, y: cloud.y, z: cloud.z }, idx = null;
		if (sel && sel.length) { cols = ctx.keepPoints(cols, sel); idx = sel; }
		var opts = { maxDistance: num("fraMaxDist", 0.15), concaveAngle: num("fraConcave", 10), minPoints: num("fraMinPoints", 50), fill: $("fraFill").checked, viewpoint: ctx.viewer.cameraPosition() };
		var pd = num("fraPlaneDist", undefined);
		if (pd !== undefined) opts.facetOptions = { planeDistance: pd };
		status("finding fragments in " + fmt(cols.count) + " points" + (idx ? " (the selection)" : "") + "…");
		$("progress").value = 0;
		opts.onProgress = function (d, t) { $("progress").value = t ? d / t : 1; };
		requestAnimationFrame(function () { setTimeout(function () {
			var t0 = performance.now(), fr;
			try { fr = findFragments(cols, opts); } catch (err) { status(err.message, true); return; }
			var fragment = new Uint32Array(cloud.count), inFragments = 0;
			for (var i = 0; i < fr.fragment.length; i++) { var c = idx ? idx[i] : i; fragment[c] = fr.fragment[i]; if (fr.fragment[i]) inFragments++; }
			res = { fr: fr, idx: idx, fragment: fragment };
			hovered = 0;
			showOutlines();
			$("colourBy").value = "fragment";
			ctx.recolour();   // first: it writes its own status line
			var share = fr.surfaceArea ? fr.unassignedArea / fr.surfaceArea : 0;
			var text = fr.fragments.length + " fragments holding " + fmt(inFragments) + " of " + fmt(cols.count) + " points; " +
				fr.unassignedArea.toFixed(1) + " m² of " + fr.surfaceArea.toFixed(1) + " m² in none (" + (100 * share).toFixed(0) + " %), in " + ctx.since(t0) + " ms";
			var big = floorWarning();
			$("fraInfo").textContent = big;
			$("fraInfo").classList.toggle("error", !!big);
			$("fraFinesHint").textContent = "Area in no fragment: " + (100 * share).toFixed(0) + " % of the surface — a start for Fines, if those parts are fines (it is not applied by itself: a scan cannot see their depth).";
			curve();
			status(text + (big ? " · " + big : ""));
			if (ctx.onResult) ctx.onResult();
		}, 0); });
	}
	// One fragment over a quarter of the surface: the bench floor or a wall, not a rock
	function floorWarning() {
		var fr = res && res.fr, big = null;
		if (!fr || !fr.surfaceArea) return "";
		fr.fragments.forEach(function (f) { if (!big || f.area > big.area) big = f; });
		if (!big || big.area <= FLOOR_SHARE * fr.surfaceArea) return "";
		return "Fragment " + big.id + " covers " + (100 * big.area / fr.surfaceArea).toFixed(0) + " % of the surface — the floor or a wall? Hover it, Select fragment and delete it, then find fragments again.";
	}

	// --- the size curve ---------------------------------------------------------------
	function curve() {
		if (!res) { drawSizeChart($("sizeChart"), null); $("fraPTable").innerHTML = ""; $("fraFitInfo").textContent = ""; return; }
		try {
			res.psd = sizeDistribution(res.fr.fragments, { model: $("fraModel").value, weight: $("fraWeight").value, fitFrom: num("fraFitFrom", 60), fines: num("fraFines", 0) / 100 });
		} catch (err) { status(err.message, true); return; }
		var psd = res.psd, fit = psd.fit;
		drawSizeChart($("sizeChart"), psd);
		var t = $("fraPTable");
		t.innerHTML = "<tr><th></th><th>P10</th><th>P20</th><th>P50</th><th>P80</th><th>P90</th></tr>";
		var tr = t.insertRow();
		tr.insertCell().textContent = "size (m)";
		[10, 20, 50, 80, 90].forEach(function (P) {
			var q = psd.p[P], c = tr.insertCell();
			c.textContent = q.size > 0 ? m(q.size) + (q.extrapolated ? " *" : "") : "—";
			if (q.extrapolated) c.title = "From the fit, below the measured curve";
		});
		$("fraFitInfo").textContent = fit ? (fit.model === "swebrec" ? "Swebrec: x50 " + m(fit.x50) + " m, xmax " + m(fit.xmax) + " m, b " + fit.b.toFixed(2) : "Rosin–Rammler: x50 " + m(fit.x50) + " m, n " + fit.n.toFixed(2)) +
			", RMSE " + fit.rmse.toFixed(2) + " % over " + m(fit.range[0]) + "–" + m(fit.range[1]) + " m · * extrapolated" : "No fit: fewer than 3 measured points from Fit from up.";
	}
	function curveCsv() {
		var psd = res.psd, fit = psd.fit, rows = [];
		for (var i = 0; i < psd.size.length; i++) rows.push([psd.size[i].toPrecision(6), psd.passing[i].toFixed(3), fit ? fit.passing(psd.size[i]).toFixed(3) : ""].join(","));
		return "size,measured,fitted\n" + rows.join("\n") + "\n";
	}

	// --- select -------------------------------------------------------------------
	function selectWhere(test, name) {
		var out = [], fg = res.fragment;
		for (var i = 0; i < fg.length; i++) if (fg[i] && test(fg[i])) out.push(i);
		var sel = Uint32Array.from(out);
		ctx.setSelection(sel, name + ": " + fmt(sel.length) + " points selected");
		showScope();
	}
	function selectHovered() {
		if (!res) return;
		if (!hovered) { status("hover a fragment first (its id shows on the line under the view)", true); return; }
		var id = hovered;
		selectWhere(function (f) { return f === id; }, "Fragment " + id);
	}
	function selectOversize() {
		if (!res) return;
		var lim = num("fraOversize", 1), fs = res.fr.fragments;
		selectWhere(function (f) { return fs[f - 1].size > lim; }, "Fragments over " + lim + " m");
	}
	function showScope() {
		var sel = ctx.selection;
		$("fraScope").textContent = sel && sel.length ? "Runs on the selection: " + fmt(sel.length) + " points" : "Runs on the whole cloud";
		$("fraClearSel").classList.toggle("hidden", !(sel && sel.length));
	}

	// --- outlines and colours -----------------------------------------------------
	function showOutlines() {
		if (!res || !$("fraOutlines").checked) { ctx.viewer.clearOutlines(); return; }
		ctx.viewer.setOutlines(res.fr.fragments.map(function (f) { return Float32Array.from(f.outline); }), true);
	}
	/** Colours for the drawn points by fragment. */
	function colours(drawn, drawnIdx) {
		var n = drawn.count, out = new Uint8Array(n * 3);
		for (var j = 0; j < n; j++) {
			var i = drawnIdx ? drawnIdx[j] : j, c = res && res.fragment[i] ? fragmentRgb(res.fragment[i]) : NONE_RGB;
			out[j * 3] = c[0]; out[j * 3 + 1] = c[1]; out[j * 3 + 2] = c[2];
		}
		return out;
	}

	// --- CSV and DXF ----------------------------------------------------------------
	function download(name, text) {
		var a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([text], { type: /\.dxf$/.test(name) ? "application/dxf" : "text/csv" }));
		a.download = name;
		a.click();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
	}
	function fragmentsCsv() {
		var o = ctx.origin;
		return "id,x,y,z,a,b,c,size,area,points\n" + res.fr.fragments.map(function (f) {
			return [f.id, (f.centroid[0] + o.x).toFixed(3), (f.centroid[1] + o.y).toFixed(3), (f.centroid[2] + o.z).toFixed(3), f.axes[0].toFixed(3), f.axes[1].toFixed(3), f.axes[2].toFixed(3), f.size.toFixed(3), f.area.toFixed(3), f.count].join(",");
		}).join("\n") + "\n";
	}
	// each fragment's outline a closed 3D polyline on layer FRAGMENTS, world coordinates
	function fragmentsDxf() {
		var o = ctx.origin, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], ents = [];
		res.fr.fragments.forEach(function (f) {
			var v = [];
			for (var k = 0; k < f.outline.length; k += 3) {
				var p = [f.outline[k] + o.x, f.outline[k + 1] + o.y, f.outline[k + 2] + o.z];
				for (var d = 0; d < 3; d++) { if (p[d] < lo[d]) lo[d] = p[d]; if (p[d] > hi[d]) hi[d] = p[d]; }
				v.push(p);
			}
			if (v.length >= 3) ents.push({ layer: "FRAGMENTS", v: v });
		});
		return writeDxf(ents, { FRAGMENTS: 3 }, lo, hi);
	}

	// --- wiring -------------------------------------------------------------------
	function clear(why) {
		if (!res) return;
		res = null; hovered = 0;
		ctx.viewer.clearOutlines();
		$("fraInfo").textContent = "";
		$("fraFinesHint").textContent = "";
		curve();
		if (why) status(why);
		if (ctx.onResult) ctx.onResult();
	}
	$("fraRun").addEventListener("click", function () { showScope(); run(); });
	$("fraClear").addEventListener("click", function () {
		if (!res) return;
		clear();
		if ($("colourBy").value === "fragment") $("colourBy").value = "elevation";
		ctx.recolour();
		status("cleared");
	});
	$("fraClearSel").addEventListener("click", function () { ctx.clearSelection(); showScope(); });
	document.querySelector('.tab[data-tab="fragments"]').addEventListener("click", showScope);
	$("fraOutlines").addEventListener("change", showOutlines);
	$("fraSelectOne").addEventListener("click", selectHovered);
	$("fraSelectBig").addEventListener("click", selectOversize);
	$("fraCsv").addEventListener("click", function () { if (res) download("fragments.csv", fragmentsCsv()); });
	$("fraDxf").addEventListener("click", function () { if (res) download("fragments.dxf", fragmentsDxf()); });
	$("fraCurveCsv").addEventListener("click", function () { if (res && res.psd) download("size-curve.csv", curveCsv()); });
	$("fraCurve").addEventListener("click", curve);
	drawSizeChart($("sizeChart"), null);

	return {
		colours: colours,
		/** The fragment of cloud point i, or null; remembered as the one Select fragment takes. */
		fragmentOf: function (i) {
			if (!res || !res.fragment[i]) return null;
			var f = res.fr.fragments[res.fragment[i] - 1];
			hovered = f.id;
			return { id: f.id, size: f.size, axes: f.axes };
		},
		/** A new read or Reset: the fragments belonged to the last points. */
		onRead: function () { clear(); showScope(); },
		/** The selection changed (another tab). */
		onSelection: showScope,
		/** Any edit but Classify clears the fragments: the others move, reorder (Split) or drop points. */
		onEdit: function (name) {
			if (!/^(Classify|Undo classify)$/.test(name)) clear(res ? "cleared: the points changed (" + name + "); find fragments again" : "");
		},
		result: function () { return res; },
		/** Per cloud point its fragment (0 none), for Save; null with no fragments. */
		columns: function () { return res ? { fragment: res.fragment } : null; }
	};
}
