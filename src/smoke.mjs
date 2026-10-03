#!/usr/bin/env node
/**
 * smoke.mjs — serve the built site and pull it apart like a browser would.
 *
 *   node src/smoke.mjs
 *
 * Checks, against real HTTP responses:
 *   · every page returns 200 and declares HTML, with exactly one <h1>
 *   · every CSS/JS/image/JSON URL referenced anywhere in the HTML returns 200
 *   · a missing path falls back to the 404 page with a 404 status
 *   · the magazine's bones are present: nameplate, contents departments,
 *     archive issues, article openers, and the /images/ redirect
 *   · no duplicate element ids, balanced divs
 *   · sizes stay inside the budgets the design committed to
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = path.join(ROOT, ".build");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;
const fail = (m) => { console.log("  ✗ " + m); failures++; };
const ok = (m) => { checks++; console.log("  " + m + "  ✓"); };

/* ---- discover what should exist, from the built tree ------------------ */
const dirs = (p) => fs.existsSync(p)
  ? fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

const articles = dirs(path.join(STAGE, "articles")).map((n) => `/articles/${n}/`);
const pages = ["/", "/contents/", "/archive/", "/about/", "/404.html", "/images/", ...articles];
const mustExist = ["/images/manifest.json", "/sitemap.xml", "/robots.txt", "/favicon.svg",
  ...["tokens", "base", "spread", "article", "lightbox"].map((n) => `/assets/${n}.css`),
  "/assets/site.js"];

if (!fs.existsSync(path.join(STAGE, "index.html"))) {
  console.error("没有构建产物 —— 先运行 npm run build");
  process.exit(2);
}

/* ---- boot the server ------------------------------------------------- */
const child = spawn(process.execPath, [path.join(ROOT, "src/serve.mjs"), String(PORT)], {
  cwd: ROOT, stdio: "inherit"
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p, method = "GET") => {
  const res = await fetch(BASE + p, { method });
  const body = method === "HEAD" ? "" : await res.text();
  return { status: res.status, type: res.headers.get("content-type") || "", body };
};

let code = 1;
try {
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

    const h1s = (r.body.match(/<h1\b/g) || []).length;
    if (h1s !== 1) fail(`${p} has ${h1s} <h1> elements, expected exactly 1`);

    html[p] = r.body;
    ok(`${p} 200 · ${(r.body.length / 1024).toFixed(0)}KB`);
  }

  console.log("\nassets");
  for (const p of mustExist) {
    const r = await get(p);
    if (r.status !== 200) fail(`${p} → ${r.status}`);
    else ok(`${p} 200`);
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
    const open = (body.match(/<div\b/g) || []).length;
    const close = (body.match(/<\/div>/g) || []).length;
    if (open !== close) fail(`${page}: ${open} <div> vs ${close} </div> — unbalanced`);
  }
  ok("no duplicate ids, balanced divs on every page");

  console.log("\nthe magazine's bones");
  const home = html["/"] || "";
  if (!/class="nameplate"/.test(home)) fail("the cover has no nameplate");
  else if (!/class="feature"/.test(home)) fail("the cover has no featured article");
  else ok("cover: nameplate + featured article");
  if (!/og:image/.test(home)) fail("the cover has no og:image");
  else ok("cover declares og:image for sharing");

  const toc = html["/contents/"] || "";
  const depts = (toc.match(/class="toc__dept"/g) || []).length;
  if (!depts) fail("the contents page has no departments");
  else ok(`contents groups articles into ${depts} department(s)`);

  const arch = html["/archive/"] || "";
  const issues = (arch.match(/class="issue"/g) || []).length;
  if (!issues) fail("the archive lists no issues");
  else ok(`archive lists ${issues} issue(s)`);

  const redir = html["/images/"] || "";
  if (!/http-equiv="refresh"/.test(redir) || !/url=\/archive\//.test(redir)) {
    fail("the /images/ redirect is missing or points somewhere unexpected");
  } else if (!/href="\/archive\/"/.test(redir)) {
    fail("the /images/ redirect has no plain link fallback for no-JS");
  } else ok("/images/ redirects to the archive, with a link fallback");

  for (const p of articles) {
    const body = html[p] || "";
    if (!/class="opener/.test(body)) fail(`${p} has no magazine opener`);
    if (!/class="lead"|prose/.test(body)) fail(`${p} has no reading column`);
    if (!/data-lightbox/.test(body)) fail(`${p} has no image viewer`);
  }
  ok("every article has an opener, a reading column and a viewer");

  console.log("\naccessibility spot-checks");
  const unlabelled = [];
  // /images/ is a bare redirect page (meta refresh + link), not a destination —
  // it carries no reading content, so landmark/heading rules do not apply.
  const structural = Object.keys(html).filter((p) => p !== "/404.html" && p !== "/images/");
  for (const page of structural) {
    const body = html[page];
    if (!/<a class="skip" href="#main"/.test(body)) fail(`${page} has no skip link`);
    if (!/<main id="main"/.test(body)) fail(`${page} has no <main id="main">`);
    if (!/<nav[^>]*aria-label=/.test(body)) fail(`${page} has no labelled nav`);
  }
  for (const [page, body] of Object.entries(html)) {
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(body))) {
      if (/aria-hidden="true"/.test(m[1])) continue;
      const text = m[2].replace(/<[^>]+>/g, "").trim();
      if (!text && !/aria-label="[^"]+"/.test(m[1])) {
        unlabelled.push(`${page}: ${m[1].trim().slice(0, 50)}`);
      }
    }
  }
  if (unlabelled.length) unlabelled.slice(0, 5).forEach((u) => fail("unlabelled button → " + u));
  else ok("skip link, main landmark, labelled nav and buttons on every page");

  // images the viewer can open must be reachable by keyboard
  for (const p of articles) {
    const body = html[p] || "";
    const btn = (body.match(/role="button"/g) || []).length;
    const focusable = (body.match(/role="button"[^>]*tabindex="0"|tabindex="0"[^>]*role="button"/g) || []).length;
    if (btn && focusable !== btn) fail(`${p}: ${btn} openable images but only ${focusable} are focusable`);
  }
  ok("every openable image is keyboard focusable");

  console.log("\nsize budget");
  const walkSize = (d) => fs.readdirSync(d, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory()
      ? walkSize(path.join(d, e.name))
      : fs.statSync(path.join(d, e.name)).size), 0);
  const imgBytes = walkSize(path.join(STAGE, "images"));
  const shipped = ["tokens.css", "base.css", "spread.css", "article.css", "lightbox.css", "site.js"];
  const cssJs = shipped.reduce((n, f) => n + fs.statSync(path.join(STAGE, "assets", f)).size, 0);
  const homeKB = Buffer.byteLength(html["/"] || "", "utf8") / 1024;

  const stray = fs.readdirSync(path.join(STAGE, "assets")).filter((f) => !shipped.includes(f));
  if (stray.length) fail(`assets/ ships files the budget ignores: ${stray.join(", ")}`);

  /* Budgets are set from the site's own economics, not round numbers. Each
     image costs ~560KB for both derivatives plus its LQIP, and one is added per
     article — so this scales with the collection and the limit is a tripwire
     for a size regression, not a target. */
  const derivedCount = fs.existsSync(path.join(STAGE, "images", "derived"))
    ? fs.readdirSync(path.join(STAGE, "images", "derived")).filter((f) => f.endsWith("-1x.webp")).length
    : 1;
  const perImageKB = imgBytes / 1024 / Math.max(1, derivedCount);
  for (const [name, val, max, unit] of [
    ["images/ total", imgBytes / 1048576, 10, "MB"],
    ["css+js shipped", cssJs / 1024, 60, "KB"],
    ["cover page HTML", homeKB, 60, "KB"]
  ]) {
    if (val > max) fail(`${name} is ${val.toFixed(1)}${unit}, budget ${max}${unit}`);
    else ok(`${name} ${val.toFixed(1)}${unit} / ${max}${unit}`);
  }
  ok(`≈${perImageKB.toFixed(0)}KB of derivatives per image`);

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
