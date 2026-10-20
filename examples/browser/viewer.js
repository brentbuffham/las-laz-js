// examples/browser/viewer.js
//==========================================================
// Three.js point-cloud viewer for the demo. Positions arrive as
// Float32 RELATIVE to a local origin (the library's localOrigin
// option), so UTM-scale coordinates never jitter on the GPU.
// Each streamed chunk becomes one THREE.Points; hover picks the
// nearest point under the cursor in screen space.
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
	}
	window.addEventListener("resize", resize);
	resize();

	(function loop() {
		requestAnimationFrame(loop);
		controls.update();
		renderer.render(scene, camera);
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
		/** Frame the whole cloud. */
		fit: function () {
			if (box.isEmpty()) return;
			var centre = box.getCenter(new THREE.Vector3());
			var size = box.getSize(new THREE.Vector3()).length() || 1;
			controls.target.copy(centre);
			camera.position.set(centre.x - size * 0.6, centre.y - size * 0.8, centre.z + size * 0.6);
			camera.near = size / 10000; camera.far = size * 20;
			camera.updateProjectionMatrix();
		},
		setPointSize: function (px) { material.size = px; },
		drawnCount: function () { return drawn; },
		/** Nearest drawn point to a screen position, within maxPx: { chunk, index } or null. */
		pick: function (clientX, clientY, maxPx) {
			var rect = renderer.domElement.getBoundingClientRect();
			var mx = clientX - rect.left, my = clientY - rect.top;
			var v = new THREE.Vector3(), best = null, bestD = maxPx * maxPx;
			for (var c = 0; c < chunks.length; c++) {
				var pos = chunks[c].positions;
				// sample at most ~200k points per pick so hover stays smooth on big clouds
				var step = Math.max(1, Math.floor(chunks[c].count / 200000));
				for (var i = 0; i < chunks[c].count; i += step) {
					v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).project(camera);
					if (v.z > 1) continue;
					var sx = (v.x * 0.5 + 0.5) * rect.width - mx, sy = (-v.y * 0.5 + 0.5) * rect.height - my;
					var d = sx * sx + sy * sy;
					if (d < bestD) { bestD = d; best = { chunk: c, index: i }; }
				}
			}
			return best;
		}
	};
}
