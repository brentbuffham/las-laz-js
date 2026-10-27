// examples/browser/fragments.js
//==========================================================
// The demo's Fragments tab: findFragmentsParallel on the selection (a polygon
// round the muckpile) or the whole cloud, by method: facets (any
// orientation; the camera's position is the viewpoint only when asked,
// as a camera below the pile would turn every face inside out), the
// watershed (a muckpile seen from above) or the hybrid (the watershed,
// then facets on what it left). What the cloud can resolve (spacing,
// floor, resolution) and every warning show on a line under the run;
// a thinned read (Max points) is read again in full for the run. Colours by fragment or
// by size range (bins from the lower to the upper limit, sheets grey as
// fines), outlines on the cloud, a hover line, Select fragment (the one
// last hovered) and Select oversize. The size curve (sizeDistribution on
// the result: model, weight, fit from, lower and upper limits, fines
// size and the unseen fines %; sizeChart.js) with its P-values ("fines"
// under the lower limit, "> upper" over the upper), Fragments and Curve
// CSV, and a DXF of the outlines. Results are in the cloud's local frame;
// CSV centroids are world coordinates.
//==========================================================

import { findFragmentsParallel, sizeDistribution } from "../../src/index.js";

// labels of a full read (by file record index) onto the points shown (their indices); both reads keep the
// file's order, so one walk matches them
function byIndex(fullIndex, labels, shownIndex) {
	var out = new Uint32Array(shownIndex.length), j = 0, n = fullIndex.length;
	for (var i = 0; i < shownIndex.length; i++) {
		var want = shownIndex[i];
		if (j < n && fullIndex[j] > want) j = 0;   // out of order (never in a plain read): start the walk again
		while (j < n && fullIndex[j] < want) j++;
		if (j < n && fullIndex[j] === want) out[i] = labels[j];
	}
	return out;
}
import { writeDxf } from "./facets.js";
import { drawSizeChart } from "./sizeChart.js";

var NONE_RGB = [90, 90, 90], FINES_RGB = [150, 130, 105], OUTSIDE_RGB = [38, 40, 44], OVER_RGB = [255, 255, 255];   // unresolved (in no fragment); fines (flat patches, under the lower limit); outside the run, not counted; over the upper limit

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
 *   onResult(), and getters cloud, origin, selection, thinned ({ total, loaded } when Max points thinned the read, else null).
 */
export function initFragments(ctx) {
	var $ = ctx.$, fmt = ctx.fmt;
	var res = null;   // { fr (findFragments on the run's points), idx (run point -> cloud point, or null), fragment (per cloud point), inRun, psd, bins, note }
	var hovered = 0;   // the fragment under the pointer last (Select fragment)

	function status(t, err) { ctx.setStatus("Fragments: " + t, err); }
	function num(id, def) { var v = $(id).value.trim(); return v === "" ? def : Number(v); }
	function m(v) { return v.toFixed(v < 1 ? 3 : 2); }
	function sp(v) { return String(Number(v.toPrecision(3))); }

	// --- run ------------------------------------------------------------------
	function run() {
		var cloud = ctx.cloud;
		if (!cloud) return;
		var sel = ctx.selection, cols = { count: cloud.count, x: cloud.x, y: cloud.y, z: cloud.z }, idx = null;
		if (sel && sel.length) { cols = ctx.keepPoints(cols, sel); idx = sel; }
		var method = $("fraMethod").value, opts = { method: method, minPoints: num("fraMinPoints", 50) };
		if (method !== "watershed") {
			var md = num("fraMaxDist", undefined), pd = num("fraPlaneDist", undefined);
			if (md !== undefined) opts.maxDistance = md;
			opts.concaveAngle = num("fraConcave", 10);
			opts.fill = $("fraFill").checked;
			if ($("fraCamera").checked) opts.viewpoint = ctx.viewer.cameraPosition();
			if (pd !== undefined) opts.facetOptions = { planeDistance: pd };
		}
		if (method !== "facets") {
			var cell = num("fraWsCell", undefined);
			if (cell !== undefined) opts.cell = cell;
			opts.reliefRadius = num("fraWsRadius", 1); opts.seedHeight = num("fraWsSeed", 0.005); opts.clipBelow = num("fraWsClip", 0);
		}
		status("finding fragments (" + $("fraMethod").selectedOptions[0].textContent + ") in " + fmt(cols.count) + " points" + (idx ? " (the selection)" : "") + "…");
		$("progress").value = 0;
		opts.onProgress = function (d, t) { $("progress").value = t ? d / t : 1; };
		requestAnimationFrame(function () { setTimeout(async function () {
			var t0 = performance.now(), fr, full = null, i;
			// a thinned read: the run reads every point (inside the polygon) itself, and its labels go back onto the points shown
			if (ctx.thinned && ctx.readEvery) {
				status("reading every point" + (idx ? " inside the polygon" : "") + " for the run (the view is thinned to Max points)…");
				try { full = await ctx.readEvery(function (f) { $("progress").value = f; }); } catch (err) { status(err.message, true); return; }
				if (full) { cols = { count: full.count, x: full.x, y: full.y, z: full.z }; status("finding fragments in every point: " + fmt(full.count) + " on every core…"); $("progress").value = 0; }
			}
			try { fr = await findFragmentsParallel(cols, opts); } catch (err) { status(err.message, true); return; }
			if (fr.spacing > 0) {
				if (method !== "watershed") $("fraMaxDist").placeholder = "auto (" + sp(4 * fr.spacing) + ")";
				if (method !== "facets") $("fraWsCell").placeholder = "auto (" + sp(fr.cell) + ")";
			}
			var fragment = new Uint32Array(cloud.count), inFragments = 0, inRun = null;
			for (i = 0; i < fr.fragment.length; i++) if (fr.fragment[i]) inFragments++;
			if (full) fragment = byIndex(full.index, fr.fragment, cloud.index);
			else for (i = 0; i < fr.fragment.length; i++) fragment[idx ? idx[i] : i] = fr.fragment[i];
			if (idx) { inRun = new Uint8Array(cloud.count); for (i = 0; i < idx.length; i++) inRun[idx[i]] = 1; }
			res = { fr: fr, idx: idx, fragment: fragment, inRun: inRun, note: full ? null : thinnedNote(fr), every: !!full };
			hovered = 0;
			showOutlines();
			$("colourBy").value = $("fraColour").value;
			curve();   // before the colours: the bins follow the curve's limits
			ctx.recolour();   // it writes its own status line
			var share = fr.surfaceArea ? fr.unassignedArea / fr.surfaceArea : 0;
			var text = fr.fragments.length + " fragments holding " + fmt(inFragments) + " of " + fmt(cols.count) + " points" + (full ? " (every point read for the run)" : "") +
				(fr.threads > 1 ? ", " + fr.tiles + " tiles on " + fr.threads + " threads" : "") + "; " +
				fr.unassignedArea.toFixed(1) + " m² of " + fr.surfaceArea.toFixed(1) + " m² in none (" + (100 * share).toFixed(0) + " %), in " + ctx.since(t0) + " ms" +
				(fr.spacing > 0 ? "; point spacing " + sp(fr.spacing) + " m, floor " + fr.floor.toFixed(2) + " m, resolution " + fr.resolution : "") +
				(method === "hybrid" ? "; " + fmt(fr.fromWatershed) + " from the watershed, " + fmt(fr.fromFacets) + " from facets on the rest" : "");
			showWarnings();
			status(text);
			if (ctx.onResult) ctx.onResult();
		}, 0); });
	}
	// Max points thinned the read: fragments are density-bound, so say what the spacing would be with every point
	function thinnedNote(fr) {
		var t = ctx.thinned;
		if (!t || !(t.loaded > 0) || !(fr.spacing > 0)) return "";
		var every = t.total / t.loaded, nth = Math.round(every);
		return "The read was thinned to Max points (about every " + (nth === 2 ? "2nd" : nth === 3 ? "3rd" : nth + "th") + " point): spacing " + sp(fr.spacing) + " instead of about " + sp(fr.spacing / Math.sqrt(every)) + ". Set Max points to 0 and read again for every point.";
	}
	// the run's warnings, the curve's, and a thinned read, on one line under the run
	function showWarnings() {
		var lines = [];
		if (res) {
			if (res.note) lines.push(res.note);
			res.fr.warnings.forEach(function (w) { lines.push(w.message); });
			if (res.psd) res.psd.warnings.forEach(function (w) { lines.push(w.message); });
		}
		$("fraInfo").textContent = lines.join(" · ");
		$("fraInfo").classList.toggle("error", lines.length > 0);
	}

	// --- the size curve ---------------------------------------------------------------
	function curve() {
		if (!res) { drawSizeChart($("sizeChart"), null); $("fraPTable").innerHTML = ""; $("fraFitInfo").textContent = ""; $("fraFinesHint").textContent = ""; $("fraLowerHint").textContent = ""; return; }
		var fr = res.fr, lower = num("fraLower", 0), o = { model: $("fraModel").value, weight: $("fraWeight").value, fitFrom: num("fraFitFrom", 60), fines: num("fraFines", 0) / 100, upper: num("fraUpper", 0) };
		if (lower > 0) o.lower = lower;
		var fsz = num("fraFinesSize", undefined);
		if (fsz !== undefined) o.finesSize = fsz;
		try { res.psd = sizeDistribution(fr, o); } catch (err) { status(err.message, true); return; }
		var psd = res.psd, fit = psd.fit;
		res.bins = null;
		$("fraLowerHint").textContent = "0 = none" + (fr.floor > 0 ? "; this cloud's floor is " + fr.floor.toFixed(2) + " m (rocks under it are measured, but small ones may merge)" : "");
		drawSizeChart($("sizeChart"), psd);
		var t = $("fraPTable");
		t.innerHTML = "<tr><th></th><th>P10</th><th>P20</th><th>P50</th><th>P80</th><th>P90</th></tr>";
		var tr = t.insertRow();
		tr.insertCell().textContent = "size (m)";
		[10, 20, 50, 80, 90].forEach(function (P) {
			var q = psd.p[P], c = tr.insertCell();
			if (q.below) { c.textContent = "fines"; c.title = "In the fines: under " + m(q.size) + " m, not a rock"; return; }
			if (q.above) { c.textContent = "> " + m(q.size); c.title = "Over the upper limit"; return; }
			c.textContent = q.size > 0 ? m(q.size) + (q.extrapolated ? " *" : "") : "—";
			if (q.extrapolated) c.title = "From the fit, below the measured curve";
		});
		$("fraFitInfo").textContent = fit ? (fit.model === "swebrec" ? "Swebrec: x50 " + m(fit.x50) + " m, xmax " + m(fit.xmax) + " m, b " + fit.b.toFixed(2) : "Rosin–Rammler: x50 " + m(fit.x50) + " m, n " + fit.n.toFixed(2)) +
			", RMSE " + fit.rmse.toFixed(2) + " % over " + m(fit.range[0]) + "–" + m(fit.range[1]) + " m · * extrapolated" : "No fit: fewer than 3 measured points from Fit from up.";
		$("fraFinesHint").textContent = "Fines: " + psd.finesShare.toFixed(0) + " % of the rock surface (flat patches" + (psd.lower > 0 ? " and rocks under " + m(psd.lower) + " m" : "") + "). Unresolved: " + psd.unresolved.toFixed(0) + " % of the " + (res.idx ? "selection's " : "") +
			"surface is in no fragment (gaps, the toe, flat ground): reported on its own, not as fines; anything outside the selection is not counted." + (psd.over > 0 ? " Over " + m(psd.upper) + " m: " + psd.over.toFixed(0) + " %." : "") + " Fines % adds fines the scan cannot see on top (0 by default).";
		showWarnings();
		if ($("colourBy").value === "fragmentSize") ctx.recolour();
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
	/** Colours for the drawn points by fragment, or (by "fragmentSize") by the fragment's size range; sheets grey as fines. */
	function colours(drawn, drawnIdx, by) {
		var n = drawn.count, out = new Uint8Array(n * 3), bins = by === "fragmentSize" && res ? sizeBins() : null, fs = res ? res.fr.fragments : null;
		for (var j = 0; j < n; j++) {
			var i = drawnIdx ? drawnIdx[j] : j, f = res ? res.fragment[i] : 0;
			var c = res && res.inRun && !res.inRun[i] ? OUTSIDE_RGB : !f ? NONE_RGB : fs[f - 1].sheet ? FINES_RGB : bins ? bins.rgbOf(f) : fragmentRgb(f);
			out[j * 3] = c[0]; out[j * 3 + 1] = c[1]; out[j * 3 + 2] = c[2];
		}
		showSizeLegend(bins);
		return out;
	}
	// Bins log-spaced from the lower limit (or the smallest rock) to the upper limit (or the largest), edges to 2
	// significant figures, one colour each; fragments under the lower limit are fines (grey), over the upper one
	// "over" (white); shares are of the rock surface (the fragments), by area; the unresolved is of the whole surface
	function sizeBins() {
		var nb = Math.max(2, Math.min(64, Math.round(num("fraBins", 10)))), fs = res.fr.fragments, psd = res.psd;
		if (res.bins && res.bins.n === nb) return res.bins;
		var lowerLim = psd ? psd.lower : 0, upperLim = psd ? psd.upper : 0, lo = Infinity, hi = 0, total = 0;
		fs.forEach(function (f) { total += f.area; if (f.sheet || !(f.size > 0) || f.size < lowerLim || (upperLim > 0 && f.size > upperLim)) return; lo = Math.min(lo, f.size); hi = Math.max(hi, f.size); });
		if (lowerLim > 0) lo = lowerLim;
		if (upperLim > 0) hi = upperLim;
		var edges = [];
		for (var k = 0; k <= nb; k++) edges.push(lo < hi ? Number((lo * Math.pow(hi / lo, k / nb)).toPrecision(2)) : lo);
		var of = new Int16Array(fs.length + 1), count = new Array(nb).fill(0), area = new Array(nb).fill(0), overCount = 0, overArea = 0;
		fs.forEach(function (f) {
			if (f.sheet || !(f.size > 0) || f.size < lowerLim) { of[f.id] = -1; return; }
			if (upperLim > 0 && f.size > upperLim) { of[f.id] = -2; overCount++; overArea += f.area; return; }
			for (var b = 0; b < nb - 1 && f.size >= edges[b + 1]; b++);
			of[f.id] = b; count[b]++; area[b] += f.area;
		});
		var rgb = [];
		for (k = 0; k < nb; k++) rgb.push(rampRgb(nb > 1 ? k / (nb - 1) : 0));
		res.bins = { n: nb, edges: edges, rgb: rgb, count: count, area: area, total: total, overCount: overCount, overArea: overArea, upper: upperLim,
			fines: psd ? psd.finesShare / 100 : 0, unresolved: psd ? psd.unresolved / 100 : (res.fr.surfaceArea ? res.fr.unassignedArea / res.fr.surfaceArea : 0),
			rgbOf: function (id) { var b = of[id]; return b === -1 ? FINES_RGB : b === -2 ? OVER_RGB : rgb[b]; } };
		return res.bins;
	}
	function showSizeLegend(bins) {
		var el = $("fraLegend");
		if (!bins) { el.classList.add("hidden"); return; }
		el.innerHTML = "";
		function row(c, text, count, share, title) {
			var line = document.createElement("div"), sw = document.createElement("span"), label = document.createElement("span"), cnt = document.createElement("span");
			sw.className = "swatch"; sw.style.background = "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
			label.textContent = text;
			cnt.className = "count"; cnt.textContent = (count === null ? "" : fmt(count) + " · ") + (share === null ? "" : (100 * share).toFixed(0) + " %");
			cnt.title = title;
			line.append(sw, label, cnt);
			el.appendChild(line);
		}
		if (bins.overCount) row(OVER_RGB, "over " + bins.upper + " m", bins.overCount, bins.total ? bins.overArea / bins.total : 0, "Fragments over the upper limit, and their share of the rock surface");
		for (var b = bins.n - 1; b >= 0; b--) row(bins.rgb[b], bins.edges[b] + "–" + bins.edges[b + 1] + " m", bins.count[b], bins.total ? bins.area[b] / bins.total : 0, "Fragments in this range, and their share of the rock surface");
		row(FINES_RGB, "Fines", null, bins.fines, "Flat patches and rocks under the lower limit: their share of the rock surface");
		row(NONE_RGB, "Unresolved (no fragment)", null, bins.unresolved, "Gaps, the toe, flat ground: the share of the whole surface in no fragment, not counted as fines");
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
		return "id,x,y,z,a,b,c,size,area,points,sheet\n" + res.fr.fragments.map(function (f) {
			return [f.id, (f.centroid[0] + o.x).toFixed(3), (f.centroid[1] + o.y).toFixed(3), (f.centroid[2] + o.z).toFixed(3), f.axes[0].toFixed(3), f.axes[1].toFixed(3), f.axes[2].toFixed(3), f.size.toFixed(3), f.area.toFixed(3), f.count, f.sheet ? 1 : 0].join(",");
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
		showWarnings();
		curve();
		if (why) status(why);
		if (ctx.onResult) ctx.onResult();
	}
	$("fraRun").addEventListener("click", function () { showScope(); run(); });
	$("fraMethod").addEventListener("change", function () {
		var mt = $("fraMethod").value;
		$("fraFacetOpts").classList.toggle("hidden", mt === "watershed");
		$("fraWatershedOpts").classList.toggle("hidden", mt === "facets");
	});
	$("fraClear").addEventListener("click", function () {
		if (!res) return;
		clear();
		if (/^fragment/.test($("colourBy").value)) $("colourBy").value = "elevation";
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
			return { id: f.id, size: f.size, axes: f.axes, sheet: !!f.sheet };
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
