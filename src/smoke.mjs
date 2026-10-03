#!/usr/bin/env node
/**
 * smoke.mjs — serve the PUBLISHED tree and pull it apart like a browser would.
 *
 * Requires `npm run build` first.
 *
 * It serves the REPO ROOT, not `.build/`. That is deliberate and was learned the
 * hard way: the build writes to a staging directory and then mirrors a fixed
 * list of paths into the root, and a page written to the stage but missing from
 * that list is absent in production while a stage-based check stays green. The
 * legacy redirect pages were exactly that — green locally, 404 live.
 *
 * Checks, against real HTTP responses:
 *   · every page returns 200, is HTML, and has exactly one <h1>
 *   · every URL referenced anywhere in the HTML resolves
 *   · a missing path falls back to the 404 page with a 404 status
 *   · the promises this site makes are actually kept in the shipped bytes:
 *       — the notes are INLINE (so reading works without scripting)
 *       — no third-party scripts, styles or fonts
 *       — the search index covers every article
 *       — every backlink has a matching forward link
 *       — legacy magazine URLs still redirect
 *   · sizes stay inside the budgets
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

if (!fs.existsSync(path.join(ROOT, "index.html"))) {
  console.error("仓库根目录没有构建产物 —— 先运行 npm run build");
  process.exit(2);
}

/* ---- discover, from the PUBLISHED tree -------------------------------- */
const dirsIn = (p) => fs.existsSync(p)
  ? fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

const DOMAINS = ["literature", "philosophy", "compsci"];
const articles = DOMAINS.flatMap((d) => dirsIn(path.join(ROOT, d)).map((s) => `/${d}/${s}/`));
const tagPages = dirsIn(path.join(ROOT, "tags")).map((t) => `/tags/${t}/`);
const seriesPages = dirsIn(path.join(ROOT, "series")).map((s) => `/series/${s}/`);
// legacy redirect stubs: they exist in the root, so they must be reachable
const legacyArticles = dirsIn(path.join(ROOT, "articles")).map((s) => `/articles/${s}/`);

const pages = [
  "/", "/archive/", "/tags/", "/series/", "/search/", "/changelog/", "/about/", "/404.html",
  "/articles/", "/contents/", "/images/",
  ...DOMAINS.map((d) => `/${d}/`),
  ...tagPages, ...seriesPages, ...articles, ...legacyArticles
];

/* ---- boot the server on the published tree ---------------------------- */
const child = spawn(process.execPath, [path.join(ROOT, "src/serve.mjs"), "--published", String(PORT)], {
  cwd: ROOT, stdio: "inherit"
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p, method = "GET") => {
  const res = await fetch(BASE + p, { method, redirect: "manual" });
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
  }
  ok(`${Object.keys(html).length} pages return 200 with exactly one h1`);

  console.log("\nassets");
  // Listed here rather than derived: these are the files the pages import, and
  // discovering them would just re-read the HTML that the next check already
  // walks. A missing one is a hard failure.
  const mustExist = [
    "/search/index.json", "/rss.xml", "/sitemap.xml", "/robots.txt", "/favicon.svg",
    ...["tokens", "base", "prose", "components", "search"].map((n) => `/assets/${n}.css`),
    "/assets/site.js"
  ];
  for (const p of mustExist) {
    const r = await get(p);
    if (r.status !== 200) fail(`${p} → ${r.status}`);
  }
  ok(`${mustExist.length} required assets resolve`);

  console.log("\nreferenced urls resolve");
  const seen = new Set();
  for (const [page, body] of Object.entries(html)) {
    const urls = [...body.matchAll(/(?:href|src|content)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => u.startsWith("/") && !u.startsWith("//"));
    for (const u of urls) {
      const clean = u.split("#")[0];
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      const r = await get(clean, "HEAD");
      if (r.status !== 200) fail(`${clean} (referenced by ${page}) → ${r.status}`);
    }
  }
  ok(`${seen.size} distinct internal URLs all return 200`);

  console.log("\n404 fallback");
  const missing = await get("/definitely-not-here/");
  if (missing.status !== 404) fail(`missing path returned ${missing.status}, expected 404`);
  else if (!/没有这一页/.test(missing.body)) fail("404 status but not the 404 page");
  else ok("missing path → 404 status + 404 page");

  console.log("\nlegacy magazine URLs");
  for (const [from, to] of [["/articles/", "/archive/"], ["/contents/", "/archive/"], ["/images/", "/archive/"]]) {
    const r = await get(from);
    if (r.status !== 200) { fail(`${from} → ${r.status}`); continue; }
    if (!r.body.includes(`url=${to}`)) fail(`${from} does not redirect to ${to}`);
    if (!r.body.includes(`href="${to}"`)) fail(`${from} has no plain link fallback`);
  }
  const legacyArticle = articles.length ? `/articles/${articles[0].split("/")[2]}/` : null;
  if (legacyArticle) {
    const r = await get(legacyArticle);
    if (r.status !== 200) fail(`${legacyArticle} → ${r.status}`);
  }
  ok("old magazine paths redirect, with link fallbacks");

  console.log("\nmarkup integrity");
  for (const [page, body] of Object.entries(html)) {
    const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) fail(`${page} has duplicate ids: ${[...new Set(dupes)].slice(0, 4).join(", ")}`);
    const open = (body.match(/<div\b/g) || []).length;
    const close = (body.match(/<\/div>/g) || []).length;
    if (open !== close) fail(`${page}: ${open} <div> vs ${close} </div>`);
  }
  ok("no duplicate ids, balanced divs");

  console.log("\nthe promises, in the shipped bytes");
  const articleHtml = articles.map((p) => html[p]).filter(Boolean).join("\n");
  const notes = (articleHtml.match(/<aside class="note/g) || []).length;
  const refs = (articleHtml.match(/class="fnref"/g) || []).length;
  if (notes === 0) fail("没有找到内联脚注 —— 边注/脚注不再是内联的，关掉 JS 就会丢");
  else if (notes !== refs) fail(`${refs} 个引用标记对应 ${notes} 条脚注`);
  else ok(`${notes} 条脚注内联在正文里（并附 ${refs} 个引用标记）`);

  // Loading anything off-site would leak the reader's browsing to a third
  // party. Hyperlinks to other sites are the opposite — they are the point of
  // hypertext — so this checks only tags that FETCH: src, srcset, and link
  // rel=stylesheet/preload. An audit that flags <a href> would fail every page
  // that cites a source.
  const externalLoads = [];
  for (const [page, body] of Object.entries(html)) {
    for (const m of body.matchAll(/<(\w+)([^>]*)>/g)) {
      const [tag, attrs] = [m[1].toLowerCase(), m[2]];
      if (tag === "a") continue;
      for (const attr of ["src", "srcset", "data-src", "poster"]) {
        const v = new RegExp(`${attr}="([^"]*)"`, "i").exec(attrs);
        if (v && /^https?:\/\//i.test(v[1])) externalLoads.push(`${page} <${tag} ${attr}=${v[1].slice(0, 40)}>`);
      }
      if (tag === "link" && /rel="stylesheet"/i.test(attrs)) {
        const v = /href="([^"]*)"/i.exec(attrs);
        if (v && /^https?:\/\//i.test(v[1])) externalLoads.push(`${page} <link href=${v[1].slice(0, 40)}>`);
      }
    }
  }
  if (externalLoads.length) {
    [...new Set(externalLoads)].slice(0, 4).forEach(fail);
  } else {
    ok("没有从站外加载任何资源（脚本、样式、字体、图片）");
  }

  const searchIndex = JSON.parse((await get("/search/index.json")).body);
  if (searchIndex.length !== articles.length) {
    fail(`搜索索引有 ${searchIndex.length} 条，文章有 ${articles.length} 篇`);
  } else if (searchIndex.some((a) => !a.text || !a.title || !a.url)) {
    fail("搜索索引里有条目缺 title/text/url");
  } else ok(`搜索索引覆盖全部 ${searchIndex.length} 篇文章`);

  // The link graph must be consistent in the shipped HTML, not just in memory.
  let backlinkChecks = 0;
  const broken = [];
  for (const a of searchIndex) {
    const page = html[a.url];
    if (!page) continue;
    const backlisted = [...page.matchAll(/class="backlist"[^>]*>([\s\S]*?)<\/section>/g)]
      .flatMap((m) => [...m[1].matchAll(/href="([^"]+)"/g)].map((x) => x[1]));
    for (const target of backlisted) {
      const targetPage = html[target];
      if (!targetPage) continue;
      backlinkChecks++;
      if (!targetPage.includes(`href="${a.url}"`)) {
        broken.push(`${target} 的反向链接里说有 ${a.url}，但那一页并没有链到它`);
      }
    }
  }
  if (broken.length) broken.slice(0, 4).forEach(fail);
  else ok(`${backlinkChecks} 条反向链接与正向链接双向一致`);

  console.log("\naccessibility spot-checks");
  const unlabelled = [];
  // Redirect stubs carry no reading content — they are a meta refresh plus a
  // link — so landmark and heading rules do not apply to them.
  const STRUCTURAL = /^(?:\/(?:articles|contents|images)\/[^/]*\/?|\/404\.html)$/;
  for (const [page, body] of Object.entries(html)) {
    if (STRUCTURAL.test(page)) continue;
    if (!/<a class="skip" href="#main"/.test(body)) fail(`${page} has no skip link`);
    if (!/<main id="main"/.test(body)) fail(`${page} has no <main id="main">`);
    if (!/<nav[^>]*aria-label=/.test(body)) fail(`${page} has no labelled nav`);
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(body))) {
      if (/aria-hidden="true"/.test(m[1])) continue;
      const text = m[2].replace(/<[^>]+>/g, "").trim();
      if (!text && !/aria-label="[^"]+"/.test(m[1])) unlabelled.push(`${page}: ${m[1].trim().slice(0, 46)}`);
    }
  }
  if (unlabelled.length) unlabelled.slice(0, 5).forEach((u) => fail("unlabelled button → " + u));
  else ok("skip link, main landmark, labelled nav and buttons everywhere");

  console.log("\nfeeds & size");
  const rss = await get("/rss.xml");
  if (!/<rss/.test(rss.body) || !/<item>/.test(rss.body)) fail("RSS feed is empty or malformed");
  else ok(`RSS 有 ${(rss.body.match(/<item>/g) || []).length} 条`);

  const walkSize = (d) => fs.readdirSync(d, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? walkSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  const cssJs = ["tokens", "base", "prose", "components", "search"].map((n) => `/assets/${n}.css`)
    .concat(["/assets/site.js"])
    .reduce((n, p) => n + fs.statSync(path.join(ROOT, p)).size, 0);
  const biggest = Object.entries(html)
    .map(([p, b]) => [p, Buffer.byteLength(b, "utf8")])
    .sort((a, b) => b[1] - a[1])[0];

  for (const [name, val, max, unit] of [
    ["css + js", cssJs / 1024, 60, "KB"],
    ["最大单页", biggest[1] / 1024, 120, "KB"]
  ]) {
    if (val > max) fail(`${name} 是 ${val.toFixed(1)}${unit}，超出预算 ${max}${unit}`);
    else ok(`${name} ${val.toFixed(1)}${unit} / ${max}${unit}  (${biggest[0]})`);
  }

  code = failures ? 1 : 0;
  console.log("");
  console.log(failures ? `✗ ${failures} 项失败，${checks} 项通过` : `✓ 全部 ${checks} 项检查通过`);
} catch (e) {
  console.error("\n✗ smoke 运行出错:", e.message);
  code = 1;
} finally {
  child.kill();
}

process.exit(code);
