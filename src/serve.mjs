#!/usr/bin/env node
/**
 * serve.mjs — zero-dependency static server for local preview.
 *
 *   npm run serve            → http://127.0.0.1:4321
 *   npm run serve -- 8080    → http://127.0.0.1:8080
 *
 * Serves the PUBLISHED tree (the repo root), not `.build/`, so what you look at
 * is exactly what GitHub Pages will serve. Directory URLs resolve to
 * index.html, and unknown paths fall back to 404.html the way Pages does.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

const send = (res, code, body, type) => {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    return send(res, 400, "bad request");
  }

  // never let a traversal escape the published tree
  const rel = path.normalize(urlPath).replace(/^([/\\])+/, "");
  let file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, "forbidden");

  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;

  if (!fs.existsSync(file)) {
    const fallback = path.join(ROOT, "404.html");
    if (!fs.existsSync(fallback)) return send(res, 404, "404");
    res.writeHead(404, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(fallback));
  }

  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || "application/octet-stream";
  const size = fs.statSync(file).size;
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Cache-Control": "no-store" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  → http://${HOST}:${PORT}/`);
});

process.on("SIGINT", () => { server.close(() => process.exit(0)); });
