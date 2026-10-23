// examples/browser/facets.js
//==========================================================
// The demo's Facets tab: findFacets on the selection (a polygon round
// the wall) or the whole cloud, then jointSets (automatic, a count, or
// typed windows). Colours by facet or joint set (the Colour tab's list),
// outlines on the cloud, the sets table with Select set (the set's
// points become the selection, to Classify, delete or crop), a hover
// line, a stereonet (stereonet.js) and CSV downloads. Results are in the cloud's local frame; CSV
// centroids are world coordinates.
//==========================================================

import { findFacets, jointSets } from "../../src/index.js";
import { drawStereonet } from "./stereonet.js";

// 8 distinct set colours, then grey for points in no set
var SET_RGB = [[230, 25, 75], [60, 180, 75], [67, 99, 216], [245, 130, 49], [145, 30, 180], [66, 212, 244], [240, 50, 230], [191, 239, 69]];
var NONE_RGB = [90, 90, 90];

// A facet's colour: hues spread by the golden angle (as the library's class colours)
function facetRgb(id) {
	var h = (id * 137.508) % 360, s = 0.65, l = 0.55, a = s * Math.min(l, 1 - l);
	function f(k) { var t = (k + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1)))); }
	return [f(0), f(8), f(4)];
}
export function setRgb(id) { return id ? SET_RGB[(id - 1) % SET_RGB.length] : NONE_RGB; }
export function setCss(id) { var c = setRgb(id); return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }

/**
 * @param {object} ctx - $, viewer, setStatus, fmt, since, select(name, make), recolour(), keepPoints,
 *   and getters cloud, origin, selection.
 */
export function initFacets(ctx) {
	var $ = ctx.$, fmt = ctx.fmt;
	var res = null;   // { f (findFacets on the run's points), idx (run point -> cloud point, or null), facet (per cloud point), sets, pointSet }

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
			var b = document.createElement("button");
			b.className = "button small"; b.textContent = "Select"; b.title = "Make set " + fam.id + "'s points the selection";
			b.addEventListener("click", function () { selectSet(fam.id); });
			tr.insertCell().appendChild(b);
		});
		var none = 0;
		for (var i = 0; i < s.family.length; i++) if (!s.family[i]) none++;
		$("facSetInfo").textContent = s.families.length + " sets · " + none + " of " + s.family.length + " facets in no set";
	}
	function selectSet(id) {
		ctx.select("Set " + id, function () {
			var out = [], ps = res.pointSet;
			for (var i = 0; i < ps.length; i++) if (ps[i] === id) out.push(i);
			return Uint32Array.from(out);
		});
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
		a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
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
	$("facRun").addEventListener("click", run);
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

	return {
		colours: colours,
		/** The facet and set of cloud point i, or null. */
		facetOf: function (i) {
			if (!res || !res.facet[i]) return null;
			var f = res.f.facets[res.facet[i] - 1];
			return { id: f.id, dip: f.dip, dipDirection: f.dipDirection, set: res.pointSet ? res.pointSet[i] : 0 };
		},
		/** A new read or Reset: the facets belonged to the last points. */
		onRead: function () { clear(); },
		/** An edit: one that changes the points (count, or coordinates: Register, Transform, Smooth) clears the facets. */
		onEdit: function (name, countChanged) {
			if (countChanged || /^(Register|Undo register|Transform|Smooth|Undo smooth)$/.test(name)) clear(res ? "cleared: the points changed (" + name + "); find facets again" : "");
		},
		result: function () { return res; }
	};
}
