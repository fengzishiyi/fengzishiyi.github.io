#!/usr/bin/env node
/**
 * serve.mjs — zero-dependency static server for local preview.
 *
 *   npm run serve          → http://127.0.0.1:4321
 *   npm run dev            → same, plus watch + live reload
 *
 * Serves the STAGING tree (.build/), not the repo root. Two reasons:
 *   · the stage is always a complete, coherent build, so a request during a
 *     rebuild can never read a half-mirrored directory
 *   · it is byte-identical to what publish() mirrors to the published root,
 *     so nothing can pass here and then differ in production
 *
 * Live reload is an in-memory revision counter plus long-polling, because the
 * sandbox blocks piped stdio and standing up a second port for SSE would be
 * more surface than the job needs. `npm run dev` bumps the revision after every
 * successful build; the injected script reloads when it changes.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = path.join(ROOT, ".build");
const PORT = Number(process.argv[2] || process.env.PORT || 4321);
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
const waiters = new Set();

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

  /* --- live-reload plumbing ------------------------------------------- */
  if (urlPath === "/_rev") {
    return send(res, 200, String(revision), "text/plain; charset=utf-8");
  }
  if (urlPath === "/_bump") {
    revision += 1;
    for (const w of waiters) { try { w(); } catch { /* ignore */ } }
    waiters.clear();
    return send(res, 200, `rev ${revision}`, "text/plain; charset=utf-8");
  }

  if (!fs.existsSync(STAGE) || !fs.existsSync(path.join(STAGE, "index.html"))) {
    return send(res, 503,
      "还没有构建产物。先运行：npm run build", "text/plain; charset=utf-8");
  }

  // never let a traversal escape the staging tree
  const rel = path.normalize(urlPath).replace(/^([/\\])+/, "");
  let file = path.join(STAGE, rel);
  if (!file.startsWith(STAGE)) return send(res, 403, "forbidden");

  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;

  if (!fs.existsSync(file)) {
    const fallback = path.join(STAGE, "404.html");
    if (!fs.existsSync(fallback)) return send(res, 404, "404");
    res.writeHead(404, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(fallback));
  }

  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || "application/octet-stream";

  // inject the reload client into HTML on the way out; the stage stays clean
  if (ext === ".html") {
    const html = fs.readFileSync(file, "utf8")
      .replace("</body>", `${LIVE_RELOAD}</body>`);
    return send(res, 200, html, type);
  }

  const size = fs.statSync(file).size;
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Cache-Control": "no-store" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  const staged = fs.existsSync(path.join(STAGE, "index.html"));
  console.log(`serving   ${STAGE}`);
  console.log(`staged    ${staged ? "yes" : "NO — run npm run build first"}`);
  console.log(`  →  http://${HOST}:${PORT}/`);
});

process.on("SIGINT", () => { server.close(() => process.exit(0)); });
