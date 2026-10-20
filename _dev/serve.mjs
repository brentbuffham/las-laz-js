// _dev/serve.mjs
//==========================================================
// Zero-dependency static server for the demo.
// Usage: npm run demo   (PORT env overrides 8080)
// localhost is a secure context, so OPFS and module Workers work.
//==========================================================

import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { contentType, resolveRequest } from "./serveCore.mjs";

var ROOT = fileURLToPath(new URL("../", import.meta.url));
var PORT = Number(process.env.PORT) || 8080;

var server = http.createServer(function (req, res) {
	var result = resolveRequest(ROOT, req.url);
	if (result.status === 302) {
		res.writeHead(302, { Location: result.location });
		res.end();
		return;
	}
	if (result.status !== 200) {
		res.writeHead(result.status, { "Content-Type": "text/plain; charset=utf-8" });
		res.end(String(result.status));
		return;
	}
	res.writeHead(200, { "Content-Type": contentType(result.file), "Cache-Control": "no-store" });
	fs.createReadStream(result.file).pipe(res);
});

server.listen(PORT, "127.0.0.1", function () {
	console.log("las-laz-js demo: http://localhost:" + PORT + "/");
});
