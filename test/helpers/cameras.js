// test/helpers/cameras.js
//==========================================================
// View-projection matrices as Three.js builds them (column-major,
// OpenGL clip space z in [-w, w]): perspective, orthographic, lookAt,
// and their product. Written from the Three.js formulas, not the
// library's code. Test-only.
//==========================================================

export function perspective(fovDeg, aspect, near, far) {
	var f = 1 / Math.tan(fovDeg * Math.PI / 360), nf = 1 / (near - far);
	return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

export function orthographic(left, right, top, bottom, near, far) {
	var w = 1 / (right - left), h = 1 / (top - bottom), p = 1 / (far - near);
	return [2 * w, 0, 0, 0, 0, 2 * h, 0, 0, 0, 0, -2 * p, 0, -(right + left) * w, -(top + bottom) * h, -(far + near) * p, 1];
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { var l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** The view matrix (world -> camera) of a camera at eye looking at target. */
export function lookAt(eye, target, up) {
	var z = norm(sub(eye, target)), x = norm(cross(up || [0, 0, 1], z)), y = cross(z, x);
	return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

/** a × b, both column-major 4 × 4. */
export function multiply(a, b) {
	var out = new Array(16);
	for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
		var s = 0;
		for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
		out[c * 4 + r] = s;
	}
	return out;
}
