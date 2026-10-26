// examples/browser/fragments.js
//==========================================================
// The demo's Fragments tab: findFragments (or, experimental, the
// watershed of watershed.js, same result shape) on the selection (a polygon
// round the muckpile) or the whole cloud; the camera's position is the
// viewpoint only when asked (a camera below the pile would turn every
// face inside out). Colours by fragment (the Colour tab's list), outlines on
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
import { watershedFragments, watershedThenFacets } from "./watershed.js";
import { drawSizeChart } from "./sizeChart.js";

var NONE_RGB = [90, 90, 90], OUTSIDE_RGB = [38, 40, 44], FLOOR_SHARE = 0.25;   // outside: points not in the run (a selection's outside), not counted

// HSL (hue in degrees, s and l in [0, 1]) to 0-255 RGB
function hslRgb(h, s, l) {
	var a = s * Math.min(l, 1 - l);
	function f(k) { var t = (k + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1)))); }
	return [f(0), f(8), f(4)];
}

// A size range's colour: t in [0, 1] from violet-blue (small) through cyan, green, yellow and
// orange to red (large), fully saturated so every bin stands out on the dark view
function rampRgb(t) { return hslRgb(250 * (1 - Math.max(0, Math.min(1, t))), 1, 0.5); }

// A fragment's colour: vivid hues spread by the golden angle, offset from the facet colours
function fragmentRgb(id) { return hslRgb((id * 137.508 + 200) % 360, 1, 0.5); }

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
		var method = $("fraMethod").value, watershed = method !== "facets";
		var wsOpts = { cell: num("fraWsCell", undefined), reliefRadius: num("fraWsRadius", 1), seedHeight: num("fraWsSeed", 0.005), clipBelow: num("fraWsClip", 0), minPoints: num("fraMinPoints", 50) };
		var facetOpts = { maxDistance: num("fraMaxDist", 0.15), concaveAngle: num("fraConcave", 10), minPoints: num("fraMinPoints", 50), fill: $("fraFill").checked };
		if ($("fraCamera").checked) facetOpts.viewpoint = ctx.viewer.cameraPosition();
		var pd = num("fraPlaneDist", undefined);
		if (pd !== undefined) facetOpts.facetOptions = { planeDistance: pd };
		var opts = method === "facets" ? facetOpts : wsOpts;
		status("finding fragments" + (method === "watershed" ? " (watershed)" : method === "hybrid" ? " (watershed, then facets on the rest)" : "") + " in " + fmt(cols.count) + " points" + (idx ? " (the selection)" : "") + "…");
		$("progress").value = 0;
		opts.onProgress = function (d, t) { $("progress").value = t ? d / t : 1; };
		requestAnimationFrame(function () { setTimeout(function () {
			var t0 = performance.now(), fr;
			try { fr = method === "hybrid" ? watershedThenFacets(cols, wsOpts, facetOpts) : watershed ? watershedFragments(cols, opts) : findFragments(cols, opts); } catch (err) { status(err.message, true); return; }
			if (watershed) $("fraWsCell").placeholder = "auto (" + fr.cell.toFixed(3) + ")";
			var fragment = new Uint32Array(cloud.count), inFragments = 0;
			for (var i = 0; i < fr.fragment.length; i++) { var c = idx ? idx[i] : i; fragment[c] = fr.fragment[i]; if (fr.fragment[i]) inFragments++; }
			var inRun = null;
			if (idx) { inRun = new Uint8Array(cloud.count); for (i = 0; i < idx.length; i++) inRun[idx[i]] = 1; }
			res = { fr: fr, idx: idx, fragment: fragment, inRun: inRun };
			hovered = 0;
			showOutlines();
			$("colourBy").value = $("fraColour").value;
			ctx.recolour();   // first: it writes its own status line
			var share = fr.surfaceArea ? fr.unassignedArea / fr.surfaceArea : 0;
			var text = fr.fragments.length + " fragments holding " + fmt(inFragments) + " of " + fmt(cols.count) + " points; " +
				fr.unassignedArea.toFixed(1) + " m² of " + fr.surfaceArea.toFixed(1) + " m² in none (" + (100 * share).toFixed(0) + " %), in " + ctx.since(t0) + " ms" +
				(watershed ? "; point spacing " + fr.spacing.toFixed(4) + " m, cell " + fr.cell.toFixed(3) + " m" : "") +
				(method === "hybrid" ? "; " + fmt(fr.fromWatershed) + " from the watershed, " + fmt(fr.fromFacets) + " from facets on the rest" : "");
			var big = floorWarning();
			$("fraInfo").textContent = big;
			$("fraInfo").classList.toggle("error", !!big);
			$("fraFines").value = Math.min(99, Math.round(100 * share));
			$("fraFinesHint").textContent = "Fines (not a rock): " + (100 * share).toFixed(0) + " % of the " + (idx ? "selection's " : "") + "surface (anything outside the selection is not counted), applied as Fines %; type over it to change it. It follows the run's settings (the watershed's Clip below most of all).";
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
			var q = psd.p[P], c = tr.insertCell(), fines = num("fraFines", 0);
			if (fines > 0 && P <= fines) { c.textContent = "fines"; c.title = "Within the fines share (" + fines + " %): not a rock"; return; }
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
	/** Colours for the drawn points by fragment, or (by "fragmentSize") by the fragment's size range. */
	function colours(drawn, drawnIdx, by) {
		var n = drawn.count, out = new Uint8Array(n * 3), bins = by === "fragmentSize" && res ? sizeBins() : null;
		for (var j = 0; j < n; j++) {
			var i = drawnIdx ? drawnIdx[j] : j, f = res ? res.fragment[i] : 0;
			var c = res && res.inRun && !res.inRun[i] ? OUTSIDE_RGB : !f ? NONE_RGB : bins ? bins.rgb[bins.of[f]] : fragmentRgb(f);
			out[j * 3] = c[0]; out[j * 3 + 1] = c[1]; out[j * 3 + 2] = c[2];
		}
		showSizeLegend(bins);
		return out;
	}
	// Bins log-spaced from the smallest fragment's size to the largest (edges to 2 significant
	// figures), each with its colour, fragment count and share of the surface (the fragments share
	// what the fines, the area in no fragment, leave)
	function sizeBins() {
		var nb = Math.max(2, Math.min(64, Math.round(num("fraBins", 10)))), fs = res.fr.fragments;
		if (res.bins && res.bins.n === nb) return res.bins;
		var lo = Infinity, hi = 0, total = 0;
		fs.forEach(function (f) { if (f.size > 0) { lo = Math.min(lo, f.size); hi = Math.max(hi, f.size); } total += f.area; });
		var edges = [];
		for (var k = 0; k <= nb; k++) edges.push(lo < hi ? Number((lo * Math.pow(hi / lo, k / nb)).toPrecision(2)) : lo);
		var of = new Uint8Array(fs.length + 1), count = new Array(nb).fill(0), area = new Array(nb).fill(0);
		fs.forEach(function (f) {
			for (var b = 0; b < nb - 1 && f.size >= edges[b + 1]; b++);
			of[f.id] = b; count[b]++; area[b] += f.area;
		});
		var rgb = [];
		for (k = 0; k < nb; k++) rgb.push(rampRgb(nb > 1 ? k / (nb - 1) : 0));
		var fines = res.fr.surfaceArea ? res.fr.unassignedArea / res.fr.surfaceArea : 0;
		res.bins = { n: nb, edges: edges, of: of, rgb: rgb, count: count, area: area, total: total, fines: fines };
		return res.bins;
	}
	function showSizeLegend(bins) {
		var el = $("fraLegend");
		if (!bins) { el.classList.add("hidden"); return; }
		el.innerHTML = "";
		function row(rgb, text, count, share, title) {
			var line = document.createElement("div"), sw = document.createElement("span"), label = document.createElement("span"), cnt = document.createElement("span");
			sw.className = "swatch"; sw.style.background = "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";
			label.textContent = text;
			cnt.className = "count"; cnt.textContent = (count === null ? "" : fmt(count) + " · ") + (share === null ? "" : (100 * share).toFixed(0) + " %");
			cnt.title = title;
			line.append(sw, label, cnt);
			el.appendChild(line);
		}
		for (var b = bins.n - 1; b >= 0; b--) row(bins.rgb[b], bins.edges[b] + "–" + bins.edges[b + 1] + " m", bins.count[b], bins.total ? (1 - bins.fines) * bins.area[b] / bins.total : 0, "Fragments in this range, and their share of the surface");
		row(NONE_RGB, "Fines (not a rock)", null, bins.fines, "The surface in no fragment, and its share");
		if (res.inRun) row(OUTSIDE_RGB, "Outside the selection", null, null, "Not in the run: not counted");
		el.classList.remove("hidden");
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
	$("fraMethod").addEventListener("change", function () {
		var m = $("fraMethod").value;
		$("fraFacetOpts").classList.toggle("hidden", m === "watershed");
		$("fraWatershedOpts").classList.toggle("hidden", m === "facets");
	});
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
	$("fraColour").addEventListener("change", function () { if (!res) return; $("colourBy").value = $("fraColour").value; ctx.recolour(); });
	$("fraBins").addEventListener("change", function () { if (!res) return; res.bins = null; if ($("colourBy").value === "fragmentSize") ctx.recolour(); });
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
