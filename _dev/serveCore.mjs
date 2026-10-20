// _dev/serveCore.mjs
//==========================================================
// Pure request resolution for the zero-dependency demo server.
// Maps URL paths onto files under the repo root, redirects "/"
// to the demo, and refuses anything that escapes the root.
//==========================================================

import fs from "node:fs";
import path from "node:path";

var TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".md": "text/markdown; charset=utf-8"
};

/**
 * @param {string} filePath
 * @returns {string} Content-Type header value
 */
export function contentType(filePath) {
	return TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Resolve a request path to a file.
 * @param {string} rootDir - Absolute repo root.
 * @param {string} urlPath - Raw request path (may include a query string).
 * @returns {{status:number, file?:string, location?:string}}
 */
export function resolveRequest(rootDir, urlPath) {
	var pathname = urlPath.split("?")[0].split("#")[0];
	if (pathname === "/") return { status: 302, location: "/examples/browser/" };
	var decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch (err) {
		return { status: 400 };
	}
	var root = path.resolve(rootDir);
	var target = path.resolve(root, "." + path.sep + decoded);
	if (target !== root && !target.startsWith(root + path.sep)) return { status: 403 };
	var stat = fs.existsSync(target) ? fs.statSync(target) : null;
	if (stat && stat.isDirectory()) {
		target = path.join(target, "index.html");
		stat = fs.existsSync(target) ? fs.statSync(target) : null;
	}
	if (!stat || !stat.isFile()) return { status: 404 };
	return { status: 200, file: target };
}
