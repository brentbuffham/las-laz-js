// examples/browser/viewer.js
//==========================================================
// Three.js point-cloud viewer for the demo. Positions arrive as
// Float32 RELATIVE to a local origin (the library's localOrigin
// option), so UTM-scale coordinates never jitter on the GPU.
// Each streamed chunk becomes one THREE.Points; hover picks the
// nearest point under the cursor in screen space. The Edit tab draws
// a polygon on a horizontal plane (planePoint, setOutline) and looks
// straight down to do it (topView). The Register tab adds a second,
// reference cloud (setReference), numbered pick markers on either
// cloud (setMarkers, with HTML labels kept on their points) and
// picking on one layer (pick(..., layer)). The Tiles tab draws a tile
// store's tiles as a layer of their own (setTile / removeTile), and
// reads the camera's view-projection for selectTiles (viewState).
//==========================================================

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function createViewer(container) {
	var renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(window.devicePixelRatio || 1);
	container.appendChild(renderer.domElement);
	var scene = new THREE.Scene();
	var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1e7);
	camera.up.set(0, 0, 1);
	var controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	var group = new THREE.Group();
	scene.add(group);
	var material = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true });
	var chunks = [];  // { points, positions, count }
	var drawn = 0;
	var box = new THREE.Box3();
	var raycaster = new THREE.Raycaster();
	var outline = null;   // the polygon being drawn: a Group of its line and vertex dots
	// drawn over the points (no depth test) so the outline never hides behind them
	var lineMaterial = new THREE.LineBasicMaterial({ color: 0xff2d95, depthTest: false });
	var dotMaterial = new THREE.PointsMaterial({ color: 0xff2d95, size: 7, sizeAttenuation: false, depthTest: false });
	// the reference cloud (Register tab): one THREE.Points of its own, picked separately
	var ref = null;   // { points, positions, count }
	var refBox = new THREE.Box3();
	// pick markers: dots on both clouds (moving magenta, reference orange) and their HTML labels
	var markerGroup = new THREE.Group();
	scene.add(markerGroup);
	var markerMaterials = {
		moving: new THREE.PointsMaterial({ color: 0xff2d95, size: 9, sizeAttenuation: false, depthTest: false }),
		reference: new THREE.PointsMaterial({ color: 0xff9f1a, size: 9, sizeAttenuation: false, depthTest: false })
	};
	var markers = [];   // { x, y, z, el }
	// facet outlines (Facets tab): line loops drawn over the points
	var outlineGroup = new THREE.Group();
	scene.add(outlineGroup);
	var facetLineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.8 });
	// tiles (Tiles tab): one THREE.Points per tile key, and listeners told when the camera moves
	var tileGroup = new THREE.Group();
	scene.add(tileGroup);
	var tileMap = new Map(), tileBox = new THREE.Box3(), cameraListeners = [];
	controls.addEventListener("change", function () { cameraListeners.forEach(function (fn) { fn(); }); });
	var labelLayer = document.createElement("div");
	labelLayer.className = "pick-labels";
	container.appendChild(labelLayer);

	function background() {
		var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
		scene.background = new THREE.Color(dark ? 0x111418 : 0xf4f5f7);
	}
	background();

	function resize() {
		var w = container.clientWidth || 1, h = container.clientHeight || 1;
		renderer.setSize(w, h);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		cameraListeners.forEach(function (fn) { fn(); });
	}
	window.addEventListener("resize", resize);
	resize();

	// keep each marker's label on its point
	function placeLabels() {
		if (!markers.length) return;
		var w = container.clientWidth, h = container.clientHeight, v = new THREE.Vector3();
		markers.forEach(function (mk) {
			v.set(mk.x, mk.y, mk.z).project(camera);
			var off = v.z > 1;
			mk.el.style.display = off ? "none" : "";
			if (!off) mk.el.style.transform = "translate(" + Math.round((v.x * 0.5 + 0.5) * w + 6) + "px, " + Math.round((-v.y * 0.5 + 0.5) * h - 18) + "px)";
		});
	}

	(function loop() {
		requestAnimationFrame(loop);
		controls.update();
		renderer.render(scene, camera);
		placeLabels();
	})();

	return {
		/** Remove every point. */
		clear: function () {
			chunks.forEach(function (c) { group.remove(c.points); c.points.geometry.dispose(); });
			chunks = [];
			drawn = 0;
			box.makeEmpty();
		},
		/** Add one chunk: positions Float32Array (x,y,z), colours Uint8Array (r,g,b). */
		addChunk: function (positions, colours, cap) {
			var count = positions.length / 3;
			if (drawn + count > cap) count = Math.max(0, cap - drawn);
			if (!count) return 0;
			var geom = new THREE.BufferGeometry();
			geom.setAttribute("position", new THREE.BufferAttribute(positions.subarray(0, count * 3), 3));
			geom.setAttribute("color", new THREE.BufferAttribute(colours.subarray(0, count * 3), 3, true));
			geom.computeBoundingBox();
			box.union(geom.boundingBox);
			var points = new THREE.Points(geom, material);
			group.add(points);
			chunks.push({ points: points, positions: positions, count: count });
			drawn += count;
			return count;
		},
		/** Frame the whole cloud (and the reference cloud, when there is one). */
		fit: function () {
			var all = box.clone().union(refBox).union(tileBox);
			if (all.isEmpty()) return;
			var centre = all.getCenter(new THREE.Vector3());
			var size = all.getSize(new THREE.Vector3()).length() || 1;
			controls.target.copy(centre);
			camera.position.set(centre.x - size * 0.6, centre.y - size * 0.8, centre.z + size * 0.6);
			camera.near = size / 10000; camera.far = size * 20;
			camera.updateProjectionMatrix();
		},
		/** Look straight down over the cloud's box, north (+Y) up. */
		topView: function () {
			var b = box.isEmpty() ? tileBox : box;
			if (b.isEmpty()) return;
			var centre = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
			var size = s.length() || 1;
			// the height at which the box's X and Y extents fill the view, with a margin
			var h = Math.max(s.y, s.x / camera.aspect, size * 0.01) / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
			controls.target.copy(centre);
			// a hair south of overhead: straight down, camera.up (+Z) would leave the heading undefined
			camera.position.set(centre.x, centre.y - h * 1e-4, b.max.z + h);
			camera.near = size / 10000; camera.far = Math.max(size, h) * 20;
			camera.updateProjectionMatrix();
			controls.update();
		},
		/** Where the cursor's ray meets the horizontal plane at local z: { x, y }, or null when it misses. */
		planePoint: function (clientX, clientY, z) {
			var rect = renderer.domElement.getBoundingClientRect();
			var ndc = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
			raycaster.setFromCamera(ndc, camera);
			var hit = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
			return hit ? { x: hit.x, y: hit.y } : null;
		},
		/** Draw the polygon [x0, y0, x1, y1, ...] at local z, closed or open; setOutline([]) removes it. */
		setOutline: function (xy, z, closed) {
			if (outline) {
				scene.remove(outline);
				outline.children[0].geometry.dispose();
				outline = null;
			}
			var n = xy ? Math.floor(xy.length / 2) : 0;
			if (!n) return;
			var pos = new Float32Array(n * 3);
			for (var i = 0; i < n; i++) { pos[i * 3] = xy[i * 2]; pos[i * 3 + 1] = xy[i * 2 + 1]; pos[i * 3 + 2] = z; }
			var geom = new THREE.BufferGeometry();
			geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
			outline = new THREE.Group();
			outline.add(new THREE.Points(geom, dotMaterial));
			if (n >= 2) outline.add(closed ? new THREE.LineLoop(geom, lineMaterial) : new THREE.Line(geom, lineMaterial));
			outline.children.forEach(function (o) { o.renderOrder = 1; });
			scene.add(outline);
		},
		setPointSize: function (px) { material.size = px; },
		/** New colours (r,g,b bytes per point, in the order the points were added), in place. */
		setColours: function (colours) {
			var o = 0;
			chunks.forEach(function (c) {
				var attr = c.points.geometry.getAttribute("color");
				attr.array.set(colours.subarray(o * 3, (o + c.count) * 3));
				attr.needsUpdate = true;
				o += c.count;
			});
		},
		drawnCount: function () { return drawn; },
		/** One tile: positions Float32Array (x,y,z, local), colours Uint8Array (r,g,b); replaces the key's tile. */
		setTile: function (key, positions, colours) {
			this.removeTile(key);
			var geom = new THREE.BufferGeometry();
			geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
			geom.setAttribute("color", new THREE.BufferAttribute(colours, 3, true));
			geom.computeBoundingBox();
			if (positions.length) tileBox.union(geom.boundingBox);
			var points = new THREE.Points(geom, material);
			tileGroup.add(points);
			tileMap.set(key, { points: points, count: positions.length / 3 });
		},
		/** Remove one tile. */
		removeTile: function (key) {
			var t = tileMap.get(key);
			if (!t) return;
			tileGroup.remove(t.points);
			t.points.geometry.dispose();
			tileMap.delete(key);
		},
		/** Remove every tile. */
		clearTiles: function () {
			tileMap.forEach(function (t) { tileGroup.remove(t.points); t.points.geometry.dispose(); });
			tileMap.clear();
			tileBox.makeEmpty();
		},
		/** The tile keys drawn, and their points. */
		tileKeys: function () { return Array.from(tileMap.keys()); },
		tilePoints: function () { var n = 0; tileMap.forEach(function (t) { n += t.count; }); return n; },
		/** Frame a box given in the local frame: { min: [x, y, z], max: [x, y, z] }. */
		fitBox: function (b) {
			tileBox.set(new THREE.Vector3(b.min[0], b.min[1], b.min[2]), new THREE.Vector3(b.max[0], b.max[1], b.max[2]));
			this.fit();
		},
		/** For selectTiles: the camera's view-projection (column-major) and the canvas size in pixels. */
		viewState: function () {
			camera.updateMatrixWorld();
			var m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
			return { viewProjection: m.elements.slice(), width: container.clientWidth || 1, height: container.clientHeight || 1 };
		},
		/** Call fn whenever the camera moves or the view resizes. */
		onCameraChange: function (fn) { cameraListeners.push(fn); },
		/** The reference cloud: positions Float32Array (x,y,z, local like the main cloud), colours Uint8Array (r,g,b); replaces any before. */
		setReference: function (positions, colours) {
			this.clearReference();
			var geom = new THREE.BufferGeometry();
			geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
			geom.setAttribute("color", new THREE.BufferAttribute(colours, 3, true));
			geom.computeBoundingBox();
			refBox.copy(geom.boundingBox);
			ref = { points: new THREE.Points(geom, material), positions: positions, count: positions.length / 3 };
			scene.add(ref.points);
		},
		/** Remove the reference cloud. */
		clearReference: function () {
			if (!ref) return;
			scene.remove(ref.points);
			ref.points.geometry.dispose();
			ref = null;
			refBox.makeEmpty();
		},
		/** Facet outlines: closed loops, each a Float32Array x, y, z, … (local, like the cloud). */
		setOutlines: function (loops, visible) {
			this.clearOutlines();
			loops.forEach(function (pos) {
				if (pos.length < 9) return;
				var geom = new THREE.BufferGeometry();
				geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
				var line = new THREE.LineLoop(geom, facetLineMaterial);
				line.renderOrder = 1;
				outlineGroup.add(line);
			});
			outlineGroup.visible = visible !== false;
		},
		/** Remove the facet outlines. */
		clearOutlines: function () {
			while (outlineGroup.children.length) { var o = outlineGroup.children.pop(); o.geometry.dispose(); }
		},
		/** Show or hide a layer: "moving" (the main cloud) or "reference". */
		setVisible: function (layer, on) {
			if (layer === "reference") { if (ref) ref.points.visible = on; }
			else group.visible = on;
		},
		/** Pick markers: [{ x, y, z (local), label, layer: "moving" | "reference" }]; setMarkers([]) removes them. */
		setMarkers: function (list) {
			while (markerGroup.children.length) { var o = markerGroup.children.pop(); o.geometry.dispose(); }
			labelLayer.innerHTML = "";
			markers = [];
			["moving", "reference"].forEach(function (layer) {
				var mine = (list || []).filter(function (m) { return (m.layer || "moving") === layer; });
				if (!mine.length) return;
				var pos = new Float32Array(mine.length * 3);
				mine.forEach(function (m, i) {
					pos[i * 3] = m.x; pos[i * 3 + 1] = m.y; pos[i * 3 + 2] = m.z;
					var el = document.createElement("span");
					el.className = "pick-label " + layer;
					el.textContent = m.label;
					labelLayer.appendChild(el);
					markers.push({ x: m.x, y: m.y, z: m.z, el: el });
				});
				var geom = new THREE.BufferGeometry();
				geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
				var dots = new THREE.Points(geom, markerMaterials[layer]);
				dots.renderOrder = 2;
				markerGroup.add(dots);
			});
			placeLabels();
		},
		/**
		 * Nearest drawn point to a screen position, within maxPx. layer "moving" (default): the main
		 * cloud, { chunk, index } or null; "reference": the reference cloud, { index } or null.
		 * exact (a click that picks a point for registration): every point is tried, not a sample,
		 * and the screen-nearest point gives way to one within 2 px of it that lies on a surface in
		 * front (nearer the camera by more than 10 pixel footprints), so a click takes the surface
		 * the user sees, not one behind it, and stays on the point under the cursor otherwise.
		 * Without exact (hover), at most ~200k points are tried, so it stays smooth on big clouds.
		 */
		pick: function (clientX, clientY, maxPx, layer, exact) {
			var rect = renderer.domElement.getBoundingClientRect();
			var mx = clientX - rect.left, my = clientY - rect.top;
			var v = new THREE.Vector3(), w = new THREE.Vector3(), lim = maxPx * maxPx, hits = [];   // [layer, index, screen d, distance from the camera]
			var layers = layer === "reference" ? (ref ? [ref] : []) : chunks;
			for (var c = 0; c < layers.length; c++) {
				var pos = layers[c].positions;
				var step = exact ? 1 : Math.max(1, Math.floor(layers[c].count / 200000));
				for (var i = 0; i < layers[c].count; i += step) {
					v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).project(camera);
					if (v.z > 1) continue;
					var sx = (v.x * 0.5 + 0.5) * rect.width - mx, sy = (-v.y * 0.5 + 0.5) * rect.height - my;
					var d = sx * sx + sy * sy;
					if (d < lim) hits.push([c, i, Math.sqrt(d), w.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).distanceTo(camera.position)]);
				}
			}
			if (!hits.length) return null;
			var nearest = hits[0];
			hits.forEach(function (h) { if (h[2] < nearest[2]) nearest = h; });
			var best = nearest;
			if (exact) {
				// one pixel's footprint at the nearest point's distance; a surface in front is 10 of them nearer
				var gap = 10 * nearest[3] * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / rect.height;
				hits.forEach(function (h) { if (h[2] <= nearest[2] + 2 && h[3] < nearest[3] - gap && h[3] < best[3]) best = h; });
			}
			return layer === "reference" ? { index: best[1] } : { chunk: best[0], index: best[1] };
		}
	};
}
