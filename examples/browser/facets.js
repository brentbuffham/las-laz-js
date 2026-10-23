// examples/browser/facets.js
//==========================================================
// The demo's Facets tab: findFacets on the selection (a polygon round
// the wall) or the whole cloud, then jointSets (automatic, a count, or
// typed windows). Colours by facet or joint set (the Colour tab's list),
// outlines on the cloud, the sets table with Select set (the set's
// points become the selection, to Classify, delete or crop), a hover
// line, a stereonet (stereonet.js), CSV downloads and a DXF of the facet
// outlines as closed 3D polylines, a layer per set (the facets as surfaces
// for CAD or Kirra, which triangulate them). Results are in the cloud's local frame; CSV
// centroids are world coordinates.
//==========================================================

import { findFacets, jointSets } from "../../src/index.js";
import { drawStereonet } from "./stereonet.js";

// Set colours, then grey for points in no set
// (18 colours chosen to be told apart; later sets take a golden-angle hue)
var SET_RGB = [[230, 25, 75], [60, 180, 75], [67, 99, 216], [245, 130, 49], [145, 30, 180], [66, 212, 244], [240, 50, 230], [191, 239, 69],
	[255, 225, 25], [250, 190, 190], [0, 128, 128], [230, 190, 255], [154, 99, 36], [255, 250, 200], [128, 0, 0], [170, 255, 195], [128, 128, 0], [255, 216, 177]];
var NONE_RGB = [90, 90, 90];

// A facet's colour: hues spread by the golden angle (as the library's class colours)
function facetRgb(id) {
	var h = (id * 137.508) % 360, s = 0.65, l = 0.55, a = s * Math.min(l, 1 - l);
	function f(k) { var t = (k + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1)))); }
	return [f(0), f(8), f(4)];
}
// Sets 1-18 the palette, later ones their own hue (golden angle, offset from the facet colours)
export function setRgb(id) {
	if (!id) return NONE_RGB;
	if (id <= SET_RGB.length) return SET_RGB[id - 1];
	var h = (id * 137.508 + 60) % 360, s = 0.8, l = 0.5, a = s * Math.min(l, 1 - l);
	function f(k) { var t = (k + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1)))); }
	return [f(0), f(8), f(4)];
}
export function setCss(id) { var c = setRgb(id); return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }

/**
 * @param {object} ctx - $, viewer, setStatus, fmt, since, setSelection(sel, name), clearSelection(), recolour(), keepPoints,
 *   and getters cloud, origin, selection.
 */
export function initFacets(ctx) {
	var $ = ctx.$, fmt = ctx.fmt;
	var res = null;   // { f (findFacets on the run's points), idx (run point -> cloud point, or null), facet (per cloud point), sets, pointSet }
	var picked = null;   // after Select: { id, sel (the set's points), before (the selection it replaced, or null) }

	function status(t, err) { ctx.setStatus("Facets: " + t, err); }
	// Fisher K: huge for near-perfect planes, so capped in the table
	function kText(k) { return k === k ? (k > 10000 ? "> 10,000" : k.toFixed(0)) : "—"; }
	function num(id, def) { var v = $(id).value.trim(); return v === "" ? def : Number(v); }

	// --- run ------------------------------------------------------------------
	function run() {
		var cloud = ctx.cloud;
		if (!cloud) return;
		var sel = ctx.selection, cols = { count: cloud.count, x: cloud.x, y: cloud.y, z: cloud.z }, idx = null;
		if (sel && sel.length) { cols = ctx.keepPoints(cols, sel); idx = sel; }
		var opts = { maxDistance: num("facMaxDist", 0.3), maxAngle: num("facMaxAngle", 10), minArea: num("facMinArea", 1) };
		var pd = num("facPlaneDist", undefined);
		if (pd !== undefined) opts.planeDistance = pd;
		status("finding facets in " + fmt(cols.count) + " points" + (idx ? " (the selection)" : "") + "…");
		$("progress").value = 0;
		opts.onProgress = function (d, t) { $("progress").value = t ? d / t : 1; };
		requestAnimationFrame(function () { setTimeout(function () {
			var t0 = performance.now(), f;
			try { f = findFacets(cols, opts); } catch (err) { status(err.message, true); return; }
			var facet = new Uint32Array(cloud.count), inFacets = 0;
			for (var i = 0; i < f.facet.length; i++) { var c = idx ? idx[i] : i; facet[c] = f.facet[i]; if (f.facet[i]) inFacets++; }
			res = { f: f, idx: idx, facet: facet, sets: null, pointSet: null };
			sets();
			showOutlines();
			$("colourBy").value = "set";
			ctx.recolour();   // first: it writes its own status line
			status(f.facets.length + " facets holding " + fmt(inFacets) + " of " + fmt(cols.count) + " points, plane distance " + (f.planeDistance * 1000).toFixed(1) + " mm, in " + ctx.since(t0) + " ms");
		}, 0); });
	}

	// --- joint sets -------------------------------------------------------------
	function setOptions() {
		var mode = $("facSetMode").value;
		if (mode === "count") return { count: num("facSetCount", 3) };
		if (mode === "windows") {
			var text = $("facWindows").value.trim();
			if (!text) throw new Error("type windows as dip/dipdir/angle; … (e.g. 72/135/12; 40/300/10)");
			return { windows: text.split(";").map(function (part, i) {
				var v = part.trim().split("/").map(Number);
				if (v.length !== 3 || v.some(function (x) { return !isFinite(x); })) throw new Error("window " + (i + 1) + " \"" + part.trim() + "\" is not dip/dipdir/angle");
				return { dip: v[0], dipDirection: v[1], angle: v[2] };
			}) };
		}
		return { maxAngle: num("facSetAngle", 15) };
	}
	function sets() {
		if (!res) return;
		try { res.sets = jointSets(res.f.facets, setOptions()); } catch (err) { status(err.message, true); return; }
		res.pointSet = res.sets.pointFamily(res.facet);
		showSets();
		drawStereonet($("stereonet"), res.f.facets, res.sets.families, res.sets.family, setCss);
	}
	function showSets() {
		var t = $("facSetTable"), s = res && res.sets;
		t.innerHTML = "<tr><th></th><th>Set</th><th>Dip</th><th>Dip dir</th><th>K</th><th>Cone95</th><th>Facets</th><th>Area</th><th></th></tr>";
		if (!s) return;
		s.families.forEach(function (fam) {
			var tr = t.insertRow(), sw = document.createElement("span");
			sw.className = "swatch"; sw.style.background = setCss(fam.id);
			tr.insertCell().appendChild(sw);
			[fam.id, fam.dip.toFixed(1), fam.dipDirection.toFixed(1), kText(fam.fisherK), fam.cone95 === fam.cone95 ? fam.cone95.toFixed(1) : "—", fam.facets, fam.area.toFixed(1)].forEach(function (v) { tr.insertCell().textContent = v; });
			var b = document.createElement("button"), on = isPicked(fam.id);
			b.className = "button small"; b.textContent = on ? "Unselect" : "Select";
			b.title = on ? "Put back the selection from before" : "Make set " + fam.id + "'s points the selection";
			b.addEventListener("click", function () { if (isPicked(fam.id)) unselect(); else selectSet(fam.id); });
			tr.insertCell().appendChild(b);
		});
		var none = 0;
		for (var i = 0; i < s.family.length; i++) if (!s.family[i]) none++;
		$("facSetInfo").textContent = s.families.length + " sets · " + none + " of " + s.family.length + " facets in no set";
	}
	// Select a set: its points REPLACE the selection (the one replaced is kept, so Clear facets can
	// put it back: the wall region drawn before, or nothing)
	function selectSet(id) {
		var out = [], ps = res.pointSet;
		for (var i = 0; i < ps.length; i++) if (ps[i] === id) out.push(i);
		var before = picked && ctx.selection === picked.sel ? picked.before : ctx.selection;
		var sel = Uint32Array.from(out);
		picked = { id: id, sel: sel, before: before };
		ctx.setSelection(sel, "Set " + id + ": " + fmt(sel.length) + " points selected");
		showScope();
		showSets();
		ctx.setStatus($("status").textContent + " · Find facets now runs on this selection (Clear selection for the whole cloud)");
	}
	// Is set id the current selection (made by its Select, not changed since)?
	function isPicked(id) { return !!(picked && picked.id === id && ctx.selection === picked.sel); }
	// Unselect: back to the selection Select replaced
	function unselect() {
		if (!picked) return;
		var before = picked.before;
		picked = null;
		ctx.setSelection(before, before && before.length ? "Selection restored: " + fmt(before.length) + " points" : "Selection cleared");
		showScope();
		showSets();
	}
	// What Find facets will run on: the selection, or the whole cloud
	function showScope() {
		var sel = ctx.selection;
		$("facScope").textContent = sel && sel.length ? "Runs on the selection: " + fmt(sel.length) + " points" : "Runs on the whole cloud";
		$("facClearSel").classList.toggle("hidden", !(sel && sel.length));
	}

	// --- outlines and colours -----------------------------------------------------
	function showOutlines() {
		if (!res || !$("facOutlines").checked) { ctx.viewer.clearOutlines(); return; }
		ctx.viewer.setOutlines(res.f.facets.map(function (f) { return Float32Array.from(f.outline); }), true);
	}
	/** Colours for the drawn points by facet or set (mode "facet" | "set"). */
	function colours(drawn, drawnIdx, mode) {
		var n = drawn.count, out = new Uint8Array(n * 3);
		for (var j = 0; j < n; j++) {
			var i = drawnIdx ? drawnIdx[j] : j, c = NONE_RGB;
			if (res) c = mode === "set" ? setRgb(res.pointSet ? res.pointSet[i] : 0) : (res.facet[i] ? facetRgb(res.facet[i]) : NONE_RGB);
			out[j * 3] = c[0]; out[j * 3 + 1] = c[1]; out[j * 3 + 2] = c[2];
		}
		return out;
	}

	// --- CSV ----------------------------------------------------------------------
	function download(name, text) {
		var a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([text], { type: /\.dxf$/.test(name) ? "application/dxf" : "text/csv" }));
		a.download = name;
		a.click();
		setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
	}
	function facetsCsv() {
		var o = ctx.origin, fam = res.sets ? res.sets.family : null;
		return "id,x,y,z,dip,dipDirection,area,rms,set,points\n" + res.f.facets.map(function (f, i) {
			return [f.id, (f.centroid[0] + o.x).toFixed(3), (f.centroid[1] + o.y).toFixed(3), (f.centroid[2] + o.z).toFixed(3), f.dip.toFixed(2), f.dipDirection.toFixed(2), f.area.toFixed(3), f.rms.toFixed(4), fam ? fam[i] : 0, f.count].join(",");
		}).join("\n") + "\n";
	}
	function setsCsv() {
		return "id,dip,dipDirection,fisherK,cone95,facets,area\n" + res.sets.families.map(function (s) {
			return [s.id, s.dip.toFixed(2), s.dipDirection.toFixed(2), s.fisherK === s.fisherK ? s.fisherK.toFixed(1) : "", s.cone95 === s.cone95 ? s.cone95.toFixed(2) : "", s.facets, s.area.toFixed(3)].join(",");
		}).join("\n") + "\n";
	}

	// The facet outlines as an R12 DXF: a closed 3D POLYLINE each (the spec's dummy point, VERTEX
	// flag 32), a layer per joint set (SET_1 …, NO_SET), world coordinates, $EXTMIN / $EXTMAX set
	function facetsDxf() {
		var o = ctx.origin, fam = res.sets ? res.sets.family : null, out = [], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		function g(code, value) { out.push(String(code), String(value)); }
		var layers = {}, ents = [];
		res.f.facets.forEach(function (f, i) {
			var set = fam ? fam[i] : 0, layer = set ? "SET_" + set : "NO_SET", colour = set ? ((set - 1) % 6) + 1 : 8;
			layers[layer] = colour;
			var v = [];
			for (var k = 0; k < f.outline.length; k += 3) {
				var p = [f.outline[k] + o.x, f.outline[k + 1] + o.y, f.outline[k + 2] + o.z];
				for (var d = 0; d < 3; d++) { if (p[d] < lo[d]) lo[d] = p[d]; if (p[d] > hi[d]) hi[d] = p[d]; }
				v.push(p);
			}
			if (v.length >= 3) ents.push({ layer: layer, colour: colour, v: v });
		});
		if (!ents.length) { lo = [0, 0, 0]; hi = [0, 0, 0]; }
		g(0, "SECTION"); g(2, "HEADER");
		g(9, "$ACADVER"); g(1, "AC1009");
		g(9, "$EXTMIN"); g(10, lo[0].toFixed(3)); g(20, lo[1].toFixed(3)); g(30, lo[2].toFixed(3));
		g(9, "$EXTMAX"); g(10, hi[0].toFixed(3)); g(20, hi[1].toFixed(3)); g(30, hi[2].toFixed(3));
		g(0, "ENDSEC");
		g(0, "SECTION"); g(2, "TABLES"); g(0, "TABLE"); g(2, "LAYER"); g(70, Object.keys(layers).length);
		Object.keys(layers).forEach(function (name) { g(0, "LAYER"); g(2, name); g(70, 0); g(62, layers[name]); g(6, "CONTINUOUS"); });
		g(0, "ENDTAB"); g(0, "ENDSEC");
		g(0, "SECTION"); g(2, "ENTITIES");
		ents.forEach(function (e) {
			g(0, "POLYLINE"); g(8, e.layer); g(62, e.colour); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, 9);   // 8 = 3D, 1 = closed
			e.v.forEach(function (p) { g(0, "VERTEX"); g(8, e.layer); g(10, p[0].toFixed(3)); g(20, p[1].toFixed(3)); g(30, p[2].toFixed(3)); g(70, 32); });
			g(0, "SEQEND"); g(8, e.layer);
		});
		g(0, "ENDSEC"); g(0, "EOF");
		return out.join("\r\n") + "\r\n";
	}

	// --- wiring -------------------------------------------------------------------
	function clear(why) {
		if (!res) return;
		res = null;
		ctx.viewer.clearOutlines();
		showSets();
		$("facSetInfo").textContent = "";
		drawStereonet($("stereonet"), null, null, null, setCss);
		if (why) status(why);
	}
	drawStereonet($("stereonet"), null, null, null, setCss);
	$("facRun").addEventListener("click", function () { showScope(); run(); });
	$("facClear").addEventListener("click", function () {
		// a selection made by Select goes too: back to the one it replaced
		if (picked && ctx.selection === picked.sel) ctx.setSelection(picked.before, "Selection restored");
		picked = null;
		showScope();
		if (!res) return;
		clear("cleared");
		if ($("colourBy").value === "facet" || $("colourBy").value === "set") $("colourBy").value = "elevation";
		ctx.recolour();
		status("cleared");
	});
	$("facClearSel").addEventListener("click", function () { ctx.clearSelection(); showScope(); });
	document.querySelector('.tab[data-tab="facets"]').addEventListener("click", showScope);
	$("facSets").addEventListener("click", function () { if (res) { sets(); ctx.recolour(); } });
	$("facSetMode").addEventListener("change", function () {
		var m = $("facSetMode").value;
		$("facSetAngleRow").classList.toggle("hidden", m !== "auto");
		$("facSetCountRow").classList.toggle("hidden", m !== "count");
		$("facWindowsRow").classList.toggle("hidden", m !== "windows");
	});
	$("facOutlines").addEventListener("change", showOutlines);
	$("facCsvFacets").addEventListener("click", function () { if (res) download("facets.csv", facetsCsv()); });
	$("facCsvSets").addEventListener("click", function () { if (res && res.sets) download("joint-sets.csv", setsCsv()); });
	$("facDxf").addEventListener("click", function () { if (res) download("facets.dxf", facetsDxf()); });

	return {
		colours: colours,
		/** The facet and set of cloud point i, or null. */
		facetOf: function (i) {
			if (!res || !res.facet[i]) return null;
			var f = res.f.facets[res.facet[i] - 1];
			return { id: f.id, dip: f.dip, dipDirection: f.dipDirection, set: res.pointSet ? res.pointSet[i] : 0 };
		},
		/** A new read or Reset: the facets belonged to the last points. */
		onRead: function () { clear(); picked = null; showScope(); },
		/** The selection changed (another tab): keep the scope line and the Select / Unselect buttons true. */
		onSelection: function () { showScope(); if (res && res.sets) showSets(); },
		/** Any edit but Classify clears the facets: the others move, reorder (Split) or drop points. */
		onEdit: function (name, countChanged) {
			void countChanged;
			if (!/^(Classify|Undo classify)$/.test(name)) { picked = null; clear(res ? "cleared: the points changed (" + name + "); find facets again" : ""); }
		},
		result: function () { return res; }
	};
}
