// examples/browser/ghost.js
//==========================================================
// The demo's Ghosting tab. At the top is a static top-down picture of
// what is loaded (the open file's points, or a coarse pick of the tile
// store: selectTiles on a straight-down camera, read in the Worker),
// drawn once on a 2D canvas, not in WebGL. A box is dragged on it, as
// in a crop tool: drag outside the box to draw one, inside to move it,
// on an edge or corner to resize it. The 3D view then shows only what
// is inside the box (viewer.setClip), selectTiles skips the tiles
// outside it (clipBox), and Find searches only inside it. The box is
// kept in file coordinates, so it survives a switch between the open
// file and the tile store, whose local frames differ.
//==========================================================

import { selectTiles } from "../../src/index.js";

var SIDES = ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"];
var HANDLE = 9;          // css px: how near an edge or corner counts as on it
var MIN_SIZE = 0.5;      // metres: the smallest box a drag leaves
var RAMP = [[0, 38, 70, 140], [0.25, 42, 157, 143], [0.5, 138, 177, 125], [0.75, 233, 196, 106], [1, 244, 241, 222]];

function ramp(t) {
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	for (var i = 1; i < RAMP.length; i++) {
		if (t <= RAMP[i][0]) {
			var a = RAMP[i - 1], b = RAMP[i], u = (t - a[0]) / (b[0] - a[0]);
			return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
		}
	}
	return [RAMP[RAMP.length - 1][1], RAMP[RAMP.length - 1][2], RAMP[RAMP.length - 1][3]];
}

export function initGhosting(ctx) {
	var $ = ctx.$, viewer = ctx.viewer, tiles = ctx.tiles;
	var canvas = $("gOverview"), g = canvas.getContext("2d"), note = $("gOverviewNote");
	var box = null;           // the box, in file coordinates: { minX, maxX, minY, maxY, minZ, maxZ }
	var extent = null;        // what is loaded, in file coordinates: the same six sides
	var gathered = null;      // the picture's points: [{ positions (x, y, z local), count }] and the origin they are local to
	var map = null;           // the picture's mapping: { minX, maxY, s, ox, oy } in canvas pixels
	var base = document.createElement("canvas");
	var busy = false, again = false, drag = null, dpr = 1;

	function visible() { return !$("tab-ghost").classList.contains("hidden"); }
	function activeOrigin() { return tiles.active() ? tiles.origin() : ctx.origin(); }
	function fmt(v, d) { return isFinite(v) ? v.toFixed(d === undefined ? 3 : d) : "—"; }

	// --- the box ------------------------------------------------------------------------------------------------

	function localBox(withoutSwitch) {
		var o = activeOrigin();
		if (!box || !o || (!withoutSwitch && !$("gClipOn").checked)) return null;
		return { minX: box.minX - o.x, maxX: box.maxX - o.x, minY: box.minY - o.y, maxY: box.maxY - o.y, minZ: box.minZ - o.z, maxZ: box.maxZ - o.z };
	}

	function fillInputs() {
		SIDES.forEach(function (k) { var el = $("g" + k.slice(3) + (k.slice(0, 3) === "min" ? "Min" : "Max")); if (document.activeElement !== el) el.value = box ? fmt(box[k], k.slice(3) === "Z" ? 2 : 3) : ""; });
		if (extent && box) {
			var dz = extent.maxZ - extent.minZ || 1;
			$("gZMinR").value = Math.round(1000 * (box.minZ - extent.minZ) / dz);
			$("gZMaxR").value = Math.round(1000 * (box.maxZ - extent.minZ) / dz);
		}
		if (!box) { $("gBoxInfo").textContent = "No box yet: drag on the overview, or type the corners below."; return; }
		$("gBoxInfo").textContent = "X " + fmt(box.minX, 2) + " … " + fmt(box.maxX, 2) + " (" + fmt(box.maxX - box.minX, 1) + " m)   Y " + fmt(box.minY, 2) + " … " + fmt(box.maxY, 2) + " (" + fmt(box.maxY - box.minY, 1) + " m)   Z " + fmt(box.minZ, 2) + " … " + fmt(box.maxZ, 2) + " (" + fmt(box.maxZ - box.minZ, 1) + " m)";
	}

	// the box changed: the inputs, the 3D crop, the picture; tell the tiles on a finished change
	function apply(commit) {
		fillInputs();
		viewer.setClip(localBox());
		draw();
		if (commit) ctx.clipChanged();
	}

	function setBox(b, commit) {
		if (b === null) box = null;
		else {
			box = Object.assign({}, box || zBounds(), b);
			if (box.minX > box.maxX) { var t = box.minX; box.minX = box.maxX; box.maxX = t; }
			if (box.minY > box.maxY) { var u = box.minY; box.minY = box.maxY; box.maxY = u; }
			if (box.minZ > box.maxZ) { var w = box.minZ; box.minZ = box.maxZ; box.maxZ = w; }
		}
		apply(commit !== false);
	}

	function zBounds() { return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: extent ? extent.minZ : 0, maxZ: extent ? extent.maxZ : 0 }; }

	// --- the picture ----------------------------------------------------------------------------------------------

	function shown() { return canvas.clientWidth > 0 && canvas.clientHeight > 0; }

	function sizeCanvas() {
		dpr = window.devicePixelRatio || 1;
		if (!shown()) return false;   // the tab is hidden: keep the last size (a picture is drawn when it is shown)
		var w = Math.max(10, Math.round(canvas.clientWidth * dpr)), h = Math.max(10, Math.round(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
		return false;
	}

	// a straight-down camera over the extent, in file coordinates: the window the picture shows
	function windowOf(W, H) {
		var dx = extent.maxX - extent.minX || 1, dy = extent.maxY - extent.minY || 1, pad = Math.min(8 * dpr, W / 4, H / 4);
		var s = Math.min((W - 2 * pad) / dx, (H - 2 * pad) / dy);
		return { s: s, ox: (W - dx * s) / 2, oy: (H - dy * s) / 2 };
	}

	// the points of the picture: the open file's drawn points, or a coarse pick of the tile store
	async function gather() {
		if (tiles.active()) {
			var m = tiles.manifest, o = tiles.origin(), b = m.nodes["0-0-0-0"].box;
			if (!b) return null;
			extent = { minX: b[0], minY: b[1], minZ: b[2], maxX: b[3], maxY: b[4], maxZ: b[5] };
			var W = canvas.width, H = canvas.height, win = windowOf(W, H);
			var cx = (extent.minX + extent.maxX) / 2 - o.x, cy = (extent.minY + extent.maxY) / 2 - o.y, hw = W / 2 / win.s, hh = H / 2 / win.s;
			var z0 = extent.minZ - o.z - 1, z1 = extent.maxZ - o.z + 1;
			var vp = [1 / hw, 0, 0, 0, 0, 1 / hh, 0, 0, 0, 0, -2 / (z1 - z0), 0, -cx / hw, -cy / hh, -(z0 + z1) / (z1 - z0), 1];
			var pick = selectTiles(m, { viewProjection: vp, width: W, height: H, localOrigin: o, pointBudget: 1.5e6, minPixels: 24 });
			var keys = pick.filter(function (n) { return n.count > 0; }).map(function (n) { return n.key; }), sets = [];
			if (keys.length) {
				await ctx.call("readTiles", { keys: keys, fields: ["x", "y", "z"], localOrigin: o, float32: true }, function (msg) {
					if (msg.type !== "tile") return;
					var p = msg.points, pos = new Float32Array(p.count * 3);
					for (var i = 0; i < p.count; i++) { pos[3 * i] = p.x[i]; pos[3 * i + 1] = p.y[i]; pos[3 * i + 2] = p.z[i]; }
					sets.push({ positions: pos, count: p.count });
				}).promise;
			}
			return { sets: sets, origin: { x: o.x, y: o.y, z: o.z }, from: "the tile store" };
		}
		var org = ctx.origin(), all = viewer.pointSets();
		if (!org || !all.length) return null;
		var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
		all.forEach(function (st) {
			for (var i = 0; i < st.count; i++) for (var a = 0; a < 3; a++) { var v = st.positions[3 * i + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
		});
		if (!isFinite(lo[0])) return null;
		extent = { minX: lo[0] + org.x, maxX: hi[0] + org.x, minY: lo[1] + org.y, maxY: hi[1] + org.y, minZ: lo[2] + org.z, maxZ: hi[2] + org.z };
		return { sets: all.map(function (st) { return { positions: st.positions, count: st.count }; }), origin: { x: org.x, y: org.y, z: org.z }, from: "the open file" };
	}

	// splat the points on a height buffer (the highest in a pixel wins), colour by height
	function rasterise() {
		var W = canvas.width, H = canvas.height, win = windowOf(W, H), o = gathered.origin;
		map = { minX: extent.minX, maxY: extent.maxY, s: win.s, ox: win.ox, oy: win.oy };
		var zbuf = new Float32Array(W * H).fill(-Infinity), n = 0;
		gathered.sets.forEach(function (st) {
			var pos = st.positions, s = win.s, ox = win.ox + (o.x - extent.minX) * s, oy = win.oy + (extent.maxY - o.y) * s, oz = o.z;
			for (var i = 0; i < st.count; i++) {
				var px = (pos[3 * i] * s + ox) | 0, py = (oy - pos[3 * i + 1] * s) | 0;
				if (px < 0 || py < 0 || px >= W || py >= H) continue;
				var z = pos[3 * i + 2] + oz, k = py * W + px;
				if (z > zbuf[k]) zbuf[k] = z;
				n++;
			}
		});
		// the colour range: 2 to 98 % of the heights drawn (one stray point does not flatten the ramp)
		var sample = [], step = Math.max(1, Math.floor(zbuf.length / 20000));
		for (var q = 0; q < zbuf.length; q += step) if (zbuf[q] > -Infinity) sample.push(zbuf[q]);
		sample.sort(function (a, b) { return a - b; });
		var lo = sample.length ? sample[Math.floor(sample.length * 0.02)] : 0, hi = sample.length ? sample[Math.floor(sample.length * 0.98)] : 1;
		if (!(hi > lo)) hi = lo + 1;
		base.width = W; base.height = H;
		var bg = base.getContext("2d"), img = bg.createImageData(W, H), d = img.data;
		for (var p = 0; p < zbuf.length; p++) {
			var z2 = zbuf[p], j = p * 4;
			if (z2 === -Infinity) { d[j] = 20; d[j + 1] = 23; d[j + 2] = 28; d[j + 3] = 255; continue; }
			// a little shading from the height buffer's slope toward the north-west, so ridges and benches read
			var west = p % W ? zbuf[p - 1] : z2, north = p >= W ? zbuf[p - W] : z2;
			var slope = ((west > -Infinity ? west : z2) - z2 + (north > -Infinity ? north : z2) - z2) * win.s;   // metres of height per metre of ground
			var c = ramp((z2 - lo) / (hi - lo)), shade = 1 + Math.max(-0.35, Math.min(0.35, slope * 0.6));
			d[j] = Math.min(255, c[0] * shade); d[j + 1] = Math.min(255, c[1] * shade); d[j + 2] = Math.min(255, c[2] * shade); d[j + 3] = 255;
		}
		bg.putImageData(img, 0, 0);
		return n;
	}

	// --- drawing the box over the picture --------------------------------------------------------------------------

	function toCanvas(x, y) { return [(x - map.minX) * map.s + map.ox, (map.maxY - y) * map.s + map.oy]; }
	function toWorld(cx, cy) { return [map.minX + (cx - map.ox) / map.s, map.maxY - (cy - map.oy) / map.s]; }

	function draw() {
		sizeCanvas();
		g.clearRect(0, 0, canvas.width, canvas.height);
		if (!map || !gathered) return;
		g.drawImage(base, 0, 0);
		if (!box) return;
		var a = toCanvas(box.minX, box.maxY), b = toCanvas(box.maxX, box.minY);
		g.fillStyle = "rgba(255,45,149,0.16)";
		g.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
		g.strokeStyle = "#ff2d95"; g.lineWidth = 2 * dpr;
		g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
		g.fillStyle = "#ff2d95";
		var h = 3.5 * dpr, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
		[[a[0], a[1]], [b[0], a[1]], [a[0], b[1]], [b[0], b[1]], [mx, a[1]], [mx, b[1]], [a[0], my], [b[0], my]].forEach(function (p) { g.fillRect(p[0] - h, p[1] - h, 2 * h, 2 * h); });
	}

	// the box no longer touches what is loaded (another file, another store): it would hide everything
	function strayBox() {
		return !!box && !!extent && (box.maxX < extent.minX || box.minX > extent.maxX || box.maxY < extent.minY || box.minY > extent.maxY);
	}

	async function refresh() {
		if (busy) { again = true; return; }
		busy = true;
		sizeCanvas();
		note.textContent = "Drawing the overview…";
		try {
			var got = await gather();
			if (!got || !extent) { gathered = null; map = null; extent = null; note.textContent = "Open a file, or open a tile store on the Tiles tab."; draw(); return; }
			gathered = got;
			var n = shown() ? rasterise() : 0;   // hidden: drawn when the tab is shown (the resize observer)
			note.textContent = "";
			if (strayBox()) { box = null; ctx.setStatus("The Ghosting box was outside the new points, so it was removed"); }
			apply(true);
			console.log("[ghost] overview", { from: got.from, points: n, canvas: canvas.width + "x" + canvas.height });
		} catch (err) {
			note.textContent = "The overview could not be drawn: " + err.message;
			console.error("[ghost] overview", err);
		} finally {
			busy = false;
			if (again) { again = false; refresh(); }
		}
	}

	// --- dragging on the picture ---------------------------------------------------------------------------------------

	function pointer(e) {
		var r = canvas.getBoundingClientRect();
		return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
	}

	// what the pointer is on: a corner "nw" … , an edge "n" … , "move" inside, or null outside
	function hit(p) {
		if (!box || !map) return null;
		var a = toCanvas(box.minX, box.maxY), b = toCanvas(box.maxX, box.minY), t = HANDLE * dpr;
		var nearL = Math.abs(p[0] - a[0]) <= t, nearR = Math.abs(p[0] - b[0]) <= t, nearT = Math.abs(p[1] - a[1]) <= t, nearB = Math.abs(p[1] - b[1]) <= t;
		var inX = p[0] >= a[0] - t && p[0] <= b[0] + t, inY = p[1] >= a[1] - t && p[1] <= b[1] + t;
		if (nearT && nearL) return "nw"; if (nearT && nearR) return "ne"; if (nearB && nearL) return "sw"; if (nearB && nearR) return "se";
		if (nearT && inX) return "n"; if (nearB && inX) return "s"; if (nearL && inY) return "w"; if (nearR && inY) return "e";
		if (p[0] > a[0] && p[0] < b[0] && p[1] > a[1] && p[1] < b[1]) return "move";
		return null;
	}

	var CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", move: "move" };

	canvas.addEventListener("pointerdown", function (e) {
		if (!map || e.button !== 0) return;
		var p = pointer(e), w = toWorld(p[0], p[1]), mode = hit(p);
		canvas.setPointerCapture(e.pointerId);
		drag = { mode: mode || "new", start: w, from: box ? Object.assign({}, box) : null, fresh: !mode };
		if (!mode) box = Object.assign({}, box || zBounds(), { minX: w[0], maxX: w[0], minY: w[1], maxY: w[1] });
		e.preventDefault();
	});

	canvas.addEventListener("pointermove", function (e) {
		var p = pointer(e);
		if (!drag) { canvas.style.cursor = CURSORS[hit(p)] || "crosshair"; return; }
		var w = toWorld(p[0], p[1]), f = drag.from, dx = w[0] - drag.start[0], dy = w[1] - drag.start[1], b = box;
		if (drag.mode === "new") {
			b.minX = Math.min(drag.start[0], w[0]); b.maxX = Math.max(drag.start[0], w[0]);
			b.minY = Math.min(drag.start[1], w[1]); b.maxY = Math.max(drag.start[1], w[1]);
		} else if (drag.mode === "move") {
			b.minX = f.minX + dx; b.maxX = f.maxX + dx; b.minY = f.minY + dy; b.maxY = f.maxY + dy;
		} else {
			if (drag.mode.indexOf("w") >= 0) b.minX = Math.min(f.minX + dx, f.maxX - MIN_SIZE);
			if (drag.mode.indexOf("e") >= 0) b.maxX = Math.max(f.maxX + dx, f.minX + MIN_SIZE);
			if (drag.mode.indexOf("s") >= 0) b.minY = Math.min(f.minY + dy, f.maxY - MIN_SIZE);
			if (drag.mode.indexOf("n") >= 0) b.maxY = Math.max(f.maxY + dy, f.minY + MIN_SIZE);
		}
		fillInputs();
		draw();
		viewer.setClip(localBox());   // the 3D view follows the drag; the tiles catch up when it ends
	});

	function endDrag(e) {
		if (!drag) return;
		var d = drag; drag = null;
		try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* the pointer was already released */ }
		if (d.fresh && (box.maxX - box.minX < MIN_SIZE || box.maxY - box.minY < MIN_SIZE)) { box = d.from; apply(false); return; }   // a click, not a box
		apply(true);
		if (d.fresh && $("gClipOn").checked) viewer.lookAtBox("top", localBox());
	}
	canvas.addEventListener("pointerup", endDrag);
	canvas.addEventListener("pointercancel", endDrag);

	// --- the inputs and buttons ---------------------------------------------------------------------------------------------

	SIDES.forEach(function (k) {
		var el = $("g" + k.slice(3) + (k.slice(0, 3) === "min" ? "Min" : "Max"));
		el.addEventListener("change", function () {
			var v = Number(el.value);
			if (el.value === "" || !isFinite(v)) { fillInputs(); return; }
			if (!box && extent) box = { minX: extent.minX, maxX: extent.maxX, minY: extent.minY, maxY: extent.maxY, minZ: extent.minZ, maxZ: extent.maxZ };
			var next = {}; next[k] = v;
			setBox(next, true);
		});
	});
	["gZMinR", "gZMaxR"].forEach(function (id, which) {
		$(id).addEventListener("input", function () {
			if (!extent) return;
			if (!box) box = { minX: extent.minX, maxX: extent.maxX, minY: extent.minY, maxY: extent.maxY, minZ: extent.minZ, maxZ: extent.maxZ };
			var v = extent.minZ + (extent.maxZ - extent.minZ) * Number($(id).value) / 1000;
			if (which === 0) box.minZ = Math.min(v, box.maxZ); else box.maxZ = Math.max(v, box.minZ);
			apply(false);
		});
		$(id).addEventListener("change", function () { apply(true); });
	});
	$("gClipOn").addEventListener("change", function () { apply(true); });
	$("gRefresh").addEventListener("click", refresh);
	$("gReset").addEventListener("click", function () { setBox(null, true); });
	document.querySelectorAll("[data-gview]").forEach(function (b) {
		b.addEventListener("click", function () { var lb = localBox(true); if (lb) viewer.lookAtBox(b.dataset.gview, lb); else ctx.setStatus("Draw a box on the overview first", true); });
	});
	$("gCopy").addEventListener("click", function () {
		if (!box) { ctx.setStatus("No box to copy", true); return; }
		var text = "Ghosting box (file coordinates)\nX " + fmt(box.minX) + " to " + fmt(box.maxX) + "\nY " + fmt(box.minY) + " to " + fmt(box.maxY) + "\nZ " + fmt(box.minZ) + " to " + fmt(box.maxZ) +
			"\nCorners (X, Y): SW " + fmt(box.minX) + ", " + fmt(box.minY) + "  SE " + fmt(box.maxX) + ", " + fmt(box.minY) + "  NE " + fmt(box.maxX) + ", " + fmt(box.maxY) + "  NW " + fmt(box.minX) + ", " + fmt(box.maxY);
		(navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard"))).then(function () { ctx.setStatus("Copied the box's corners"); }, function () { ctx.setStatus(text.replace(/\n/g, " | ")); });
	});

	// the loaded points changed (a file opened, tiles shown or closed, an edit): measure and draw them again, even
	// while the tab is hidden, so a box left from other points is noticed at once
	document.addEventListener("las:source", function () { gathered = null; map = null; refresh(); });
	document.querySelector('.tab[data-tab="ghost"]').addEventListener("click", function () { if (!gathered) refresh(); else draw(); });
	if (typeof ResizeObserver === "function") new ResizeObserver(function () { if (gathered && !busy && shown()) { sizeCanvas(); rasterise(); draw(); } }).observe(canvas);
	refresh();

	return {
		/** The box in file coordinates ({ minX, maxX, minY, maxY, minZ, maxZ }), or null. */
		box: function () { return box ? Object.assign({}, box) : null; },
		/** Set the box (file coordinates; sides left out stay); setBox(null) removes it. */
		setBox: function (b) { setBox(b, true); },
		/** The box in the tile store's local frame (what selectTiles' clipBox takes), or null when there is no box or the crop is off. */
		clipBox: function () { return localBox(); },
		/** The box for Find (file coordinates), or null when "search only inside the box" is off or there is no box. */
		findBox: function () { return box && $("dlLimit").checked ? Object.assign({}, box) : null; },
		refresh: refresh,
		get extent() { return extent; }
	};
}
