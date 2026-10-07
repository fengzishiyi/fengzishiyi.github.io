#!/usr/bin/env node
/**
 * serve.mjs — zero-dependency static server for local preview.
 *
 *   npm run serve   → http://127.0.0.1:4321
 *   npm run dev     → astro dev, which serves and rebuilds on its own
 *
 * It serves `dist/` and nothing else, which is the point: `dist/` is byte for
 * byte what the deploy workflow uploads. There is no separate staging tree to
 * serve, because Astro writes the output atomically itself, and there is no
 * path here that could hand out a source file — the tree contains only output.
 *
 * Live reload is an in-memory revision counter plus polling, because piped stdio
 * is restricted here and a second port would be more surface than the job needs.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVE_ROOT = path.join(ROOT, "dist");
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || 4321);
const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2"
};

/** Bumped by /_bump after each successful rebuild; the client polls /_rev. */
let revision = 1;

const LIVE_RELOAD = `<script>
(function () {
  var rev = null;
  function poll() {
    fetch("/_rev", { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .then(function (v) {
        if (rev === null) rev = v;
        else if (v !== rev) location.reload();
        setTimeout(poll, 400);
      })
      .catch(function () { setTimeout(poll, 1500); });
  }
  if (location.protocol === "http:") poll();
})();
</script>`;

const send = (res, code, body, type) => {
  res.writeHead(code, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    return send(res, 400, "bad request");
  }

  if (urlPath === "/_rev") return send(res, 200, String(revision));
  if (urlPath === "/_bump") {
    revision += 1;
    return send(res, 200, `rev ${revision}`);
  }

  const rel = path.normalize(urlPath).replace(/^([/\\])+/, "").split(path.sep).join("/");

  if (!fs.existsSync(SERVE_ROOT) || !fs.existsSync(path.join(SERVE_ROOT, "index.html"))) {
    return send(res, 503, "还没有构建产物。先运行：npm run build");
  }

  let file = path.join(SERVE_ROOT, rel);
  if (!file.startsWith(SERVE_ROOT)) return send(res, 403, "forbidden");

  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;

  if (!fs.existsSync(file)) {
    const fallback = path.join(SERVE_ROOT, "404.html");
    if (!fs.existsSync(fallback)) return send(res, 404, "404");
    res.writeHead(404, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(fallback));
  }

  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || "application/octet-stream";

  // inject the reload client into HTML on the way out; the tree stays pristine
  if (ext === ".html") {
    const html = fs.readFileSync(file, "utf8").replace("</body>", `${LIVE_RELOAD}</body>`);
    return send(res, 200, html, type);
  }

  const size = fs.statSync(file).size;
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Cache-Control": "no-store" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  const ready = fs.existsSync(path.join(SERVE_ROOT, "index.html"));
  console.log(`serving   ${SERVE_ROOT}`);
  console.log(`mode      built output（与部署产物一致）`);
  console.log(`built     ${ready ? "yes" : "NO — 先运行 npm run build"}`);
  console.log(`  →  http://${HOST}:${PORT}/`);
});

process.on("SIGINT", () => { server.close(() => process.exit(0)); });
