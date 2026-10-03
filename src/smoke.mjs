#!/usr/bin/env node
/**
 * smoke.mjs — serve the published tree and pull it apart like a browser would.
 *
 *   node src/smoke.mjs
 *
 * Checks, against the real HTTP responses:
 *   · every page returns 200 and declares HTML
 *   · every CSS/JS/image/JSON URL referenced anywhere in the HTML returns 200
 *   · a missing path falls back to the 404 page with a 404 status
 *   · no duplicate element ids on a page
 *   · the wall and the viewer are present and wired to each other
 *   · sizes stay inside the budgets the design committed to
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;
const fail = (m) => { console.log("  ✗ " + m); failures++; };
const ok = (m) => { checks++; console.log("  " + m + "  ✓"); };

/* ---- collect what should exist --------------------------------------- */
const articles = fs.readdirSync(path.join(ROOT, "articles"), { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => `/articles/${e.name}/`);

const pages = ["/", "/images/", "/articles/", "/about/", "/404.html", ...articles];
const mustExist = ["/images/manifest.json", "/sitemap.xml", "/robots.txt", "/favicon.svg",
  ...["tokens", "base", "wall", "article", "lightbox"].map((n) => `/assets/${n}.css`),
  "/assets/site.js"];

/* ---- boot the server ------------------------------------------------- */
const child = spawn(process.execPath, [path.join(ROOT, "src/serve.mjs"), String(PORT)], {
  cwd: ROOT, stdio: "inherit"        // 'inherit' — the sandbox forbids piped stdio
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p, method = "GET") => {
  const res = await fetch(BASE + p, { method });
  const body = method === "HEAD" ? "" : await res.text();
  return { status: res.status, type: res.headers.get("content-type") || "", body, len: Number(res.headers.get("content-length") || 0) };
};

let code = 1;
try {
  // wait for the port
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + "/"); break; } catch { await sleep(150); }
  }

  console.log("\npages");
  const html = {};
  for (const p of pages) {
    const r = await get(p);
    if (r.status !== 200) { fail(`${p} → ${r.status}`); continue; }
    if (!r.type.includes("text/html")) { fail(`${p} → content-type ${r.type}`); continue; }
    if (!/<title>[^<]+<\/title>/.test(r.body)) fail(`${p} has no <title>`);
    if (!/<html lang=/i.test(r.body)) fail(`${p} has no lang attribute`);
    html[p] = r.body;
    ok(`${p} 200 · ${(r.body.length / 1024).toFixed(0)}KB`);
  }

  console.log("\nassets");
  for (const p of mustExist) {
    const r = await get(p);
    if (r.status !== 200) fail(`${p} → ${r.status}`);
    else ok(`${p} 200 · ${(Buffer.byteLength(r.body) / 1024).toFixed(1)}KB`);
  }

  console.log("\nreferenced urls resolve");
  const seen = new Set();
  for (const [page, body] of Object.entries(html)) {
    const urls = [...body.matchAll(/(?:href|src|srcset|content)="([^"]+)"/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim().split(" ")[0]))
      .filter((u) => u.startsWith("/") && !u.startsWith("//"));
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      const r = await get(u, "HEAD");
      if (r.status !== 200) fail(`${u} (referenced by ${page}) → ${r.status}`);
    }
  }
  ok(`${seen.size} distinct internal URLs all return 200`);

  console.log("\n404 fallback");
  const missing = await get("/definitely-not-here/");
  if (missing.status !== 404) fail(`missing path returned ${missing.status}, expected 404`);
  else if (!/从来没有过/.test(missing.body)) fail("404 status but not the 404 page");
  else ok("missing path → 404 status + 404 page");

  console.log("\nmarkup integrity");
  for (const [page, body] of Object.entries(html)) {
    const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) fail(`${page} has duplicate ids: ${[...new Set(dupes)].join(", ")}`);

    const openTags = (body.match(/<div\b/g) || []).length;
    const closeTags = (body.match(/<\/div>/g) || []).length;
    if (openTags !== closeTags) fail(`${page}: ${openTags} <div> vs ${closeTags} </div> — markup is unbalanced`);
  }
  ok("no duplicate ids, balanced divs on every page");

  console.log("\nwall + viewer wiring");
  const home = html["/"];
  if (!home) fail("home page missing");
  else {
    const tiles = (home.match(/class="wall-tile/g) || []).length;
    const slugs = new Set([...home.matchAll(/data-slug="([^"]+)"/g)].map((m) => m[1]));
    const travel = [...home.matchAll(/--travel:(\d+)px/g)].map((m) => Number(m[1]));
    if (tiles === 0) fail("no wall tiles on the home page");
    else ok(`${tiles} tiles across ${travel.length} rows · ${slugs.size} distinct frames`);
    if (travel.some((t) => !t)) fail("a row has no --travel distance");
    if (!/data-lightbox/.test(home)) fail("the viewer is not on the page");
    else ok("viewer present");
    if (!/data-motion-toggle/.test(home)) fail("the motion toggle is not in the masthead");
    else ok("motion toggle present");
    if (!/aria-hidden="true"/.test(home)) fail("wall tiles are not aria-hidden");
    else ok("wall tiles hidden from assistive tech (viewer is the accessible path)");
  }

  console.log("\naccessibility spot-checks");
  const unlabelled = [];
  for (const [page, body] of Object.entries(html)) {
    if (page === "/404.html") continue;
    if (!/<a class="skip" href="#main"/.test(body)) fail(`${page} has no skip link`);
    if (!/<main id="main"/.test(body)) fail(`${page} has no <main id="main">`);
    if (!/<nav[^>]*aria-label=/.test(body)) fail(`${page} has no labelled nav`);

    // A button needs an accessible name from its text OR an aria-label — unless
    // it is deliberately hidden from assistive tech (the wall's tiles are, by
    // design: the collage is exposed as decoration and the viewer carries the
    // accessible presentation instead).
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(body))) {
      const [tag, content] = [m[1], m[2]];
      if (/aria-hidden="true"/.test(tag)) continue;
      const text = content.replace(/<[^>]+>/g, "").trim();
      const hasLabel = /aria-label="[^"]+"/.test(tag);
      if (!text && !hasLabel) unlabelled.push(`${page}: ${tag.trim().slice(0, 60)}`);
    }
  }
  if (unlabelled.length) unlabelled.slice(0, 6).forEach((u) => fail("unlabelled button → " + u));
  else ok("skip link, main landmark, labelled nav and buttons on every page");

  // The one button that MUST be announced is the motion toggle.
  for (const [page, body] of Object.entries(html)) {
    const m = /<button class="motion"[^>]*>/.exec(body);
    if (!m) continue;
    if (!/aria-pressed=/.test(m[0])) fail(`${page}: motion toggle has no aria-pressed`);
  }
  ok("motion toggle exposes its pressed state");

  console.log("\nsize budget");
  const imgBytes = (function walk(d) {
    return fs.readdirSync(d, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? walk(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  })(path.join(ROOT, "images"));
  // only the payload a visitor downloads — src/*.mjs tooling is not served
  const shipped = ["tokens.css", "base.css", "wall.css", "article.css", "lightbox.css", "site.js"];
  const cssJs = shipped.reduce((n, f) => n + fs.statSync(path.join(ROOT, "assets", f)).size, 0);
  const homeKB = Buffer.byteLength(html["/"] || "", "utf8") / 1024;

  const budgets = [
    ["images/ total", imgBytes / 1048576, 8, "MB"],
    ["css+js shipped", cssJs / 1024, 200, "KB"],
    ["home page HTML", homeKB, 400, "KB"]
  ];
  const assets = fs.readdirSync(path.join(ROOT, "assets"));
  const stray = assets.filter((f) => !shipped.includes(f));
  if (stray.length) fail(`assets/ contains files a visitor would fetch but the budget ignores: ${stray.join(", ")}`);
  for (const [name, val, max, unit] of budgets) {
    if (val > max) fail(`${name} is ${val.toFixed(1)}${unit}, budget ${max}${unit}`);
    else ok(`${name} ${val.toFixed(1)}${unit} / ${max}${unit}`);
  }

  code = failures ? 1 : 0;
  console.log("");
  console.log(failures ? `✗ ${failures} failure(s) in ${checks} passing checks` : `✓ all ${checks} checks passed`);
} catch (e) {
  console.error("\n✗ smoke run crashed:", e.message);
  code = 1;
} finally {
  child.kill();
}

process.exit(code);
