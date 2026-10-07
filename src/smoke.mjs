#!/usr/bin/env node
/**
 * smoke.mjs — serve the built site and pull it apart like a browser would.
 *
 * Requires `npm run build` first. It serves `dist/`, which is exactly what the
 * deploy workflow uploads: a page the build writes somewhere else, or an asset
 * the build forgets to emit, is absent here while a stage-based check stays
 * green. That happened three times before this suite existed.
 *
 * Checks, against real HTTP responses:
 *   · every page 200, HTML, exactly one <h1>
 *   · every URL referenced anywhere in the HTML resolves
 *   · the nav is the six labels this design specifies, in order, on every page
 *   · the homepage grid is a grid: cells, three footprints, no nested anchors
 *   · articles keep the promises: inline notes, the five block forms, no two
 *     stylesheets disagreeing, one h1 each
 *   · the link graph is consistent in both directions, including section anchors
 *   · the collections render, or say so when empty
 *   · legacy magazine URLs still redirect
 *
 * What is NOT here: the design contract and the size budgets. Those read the
 * sources and the artefacts directly and live in src/checks/ — this file only
 * knows what a server says.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

const EXPECTED_NAV = ["首页", "写作", "阅读", "爱好", "标签", "关于"];
const DOMAINS = ["literature", "philosophy", "compsci"];
const COLLECTIONS = ["reading", "hobbies"];

let failures = 0;
let checks = 0;
const fail = (m) => { console.log("  ✗ " + m); failures++; };
const ok = (m) => { checks++; console.log("  " + m + "  ✓"); };

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/ 里没有构建产物 —— 先运行 npm run build");
  process.exit(2);
}

/* ---- discover, from the built tree ------------------------------------ */
const dirsIn = (p) => fs.existsSync(p)
  ? fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

const articles = DOMAINS.flatMap((d) => dirsIn(path.join(DIST, d)).map((s) => `/${d}/${s}/`));
const collectionEntries = COLLECTIONS.flatMap((c) => dirsIn(path.join(DIST, c)).map((s) => `/${c}/${s}/`));
const tagPages = dirsIn(path.join(DIST, "tags")).map((t) => `/tags/${t}/`);
const seriesPages = dirsIn(path.join(DIST, "series")).map((s) => `/series/${s}/`);
const legacyArticles = dirsIn(path.join(DIST, "articles")).map((s) => `/articles/${s}/`);

const pages = [
  "/", "/writing/", "/archive/", "/tags/", "/series/", "/search/", "/changelog/", "/about/", "/404.html",
  "/articles/", "/contents/", "/images/",
  ...DOMAINS.map((d) => `/${d}/`),
  ...COLLECTIONS.map((c) => `/${c}/`),
  ...tagPages, ...seriesPages, ...articles, ...collectionEntries, ...legacyArticles
];

/* ---- boot the server on the built tree -------------------------------- */
const child = spawn(process.execPath, [path.join(ROOT, "src/serve.mjs"), String(PORT)], {
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
  // The stylesheets and scripts are discovered from the pages rather than listed
  // by hand: the build names them with a content hash, and a hand-written list
  // would go on passing while pointing at files that no longer exist.
  const stylesheets = new Set();
  const scripts = new Set();
  for (const body of Object.values(html)) {
    for (const m of body.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) stylesheets.add(m[1]);
    for (const m of body.matchAll(/<script[^>]+src="([^"]+)"/g)) scripts.add(m[1]);
  }
  const mustExist = ["/search/index.json", "/rss.xml", "/sitemap.xml", "/robots.txt", "/favicon.svg"];
  for (const p of [...mustExist, ...stylesheets, ...scripts]) {
    const r = await get(p);
    if (r.status !== 200) fail(`${p} → ${r.status}`);
  }
  ok(`${mustExist.length} required assets + ${stylesheets.size} 个样式表 + ${scripts.size} 个脚本都能取到`);

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

  // The guess runs in the browser, because GitHub Pages serves this one static
  // file for every missing path. What can be checked here is that the page is
  // wired for it and that a script is actually shipped with it — the guess itself
  // is exercised in layout.mjs, against a real typo.
  if (!/data-guess/.test(missing.body)) fail("404 页面没有「是不是想找」的容器");
  else if (!/<script/.test(missing.body)) fail("404 页面没有引入 guess404 脚本");
  else ok("404 页面接好了「是不是想找」的脚本");

  console.log("\nlegacy magazine URLs");
  for (const [from, to] of [["/articles/", "/archive/"], ["/contents/", "/archive/"], ["/images/", "/archive/"]]) {
    const r = await get(from);
    if (r.status !== 200) { fail(`${from} → ${r.status}`); continue; }
    if (!r.body.includes(`url=${to}`)) fail(`${from} does not redirect to ${to}`);
    if (!r.body.includes(`href="${to}"`)) fail(`${from} has no plain link fallback`);
  }
  if (legacyArticles.length) {
    const r = await get(legacyArticles[0]);
    if (r.status !== 200) fail(`${legacyArticles[0]} → ${r.status}`);
  }
  ok("old magazine paths redirect, with link fallbacks");

  console.log("\nthe navigation");
  const navRe = /<nav class="nav"[^>]*>[\s\S]*?<\/nav>/;
  let navChecked = 0;
  for (const [page, body] of Object.entries(html)) {
    const navM = navRe.exec(body);
    if (!navM) continue;                       // the redirect stubs carry no nav
    const labels = [...navM[0].matchAll(/class="nav__link"[^>]*>([^<]+)</g)].map((m) => m[1]);
    if (labels.join("|") !== EXPECTED_NAV.join("|")) {
      fail(`${page} 的导航是 ${labels.join(" / ")}`);
    } else navChecked++;
  }
  if (navChecked) ok(`${navChecked} 页的导航标签逐字一致：${EXPECTED_NAV.join(" · ")}`);
  else fail("没有任何页面带有导航");

  console.log("\nthe homepage grid");
  const home = html["/"] || "";
  const cells = [...home.matchAll(/class="cell cell--(intro|wide|square)"/g)].map((m) => m[1]);
  const footprints = new Set(cells);
  if (!cells.length) fail("首页没有 masonry 网格");
  else if (!footprints.has("intro")) fail("首页缺少 intro 大卡");
  else ok(`网格 ${cells.length} 格，尺寸：${[...footprints].join(" / ")}`);

  const cardLinks = [...home.matchAll(/<a class="card__link[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
  const outward = cardLinks.filter((h) => /^https?:/i.test(h));
  if (outward.length) fail(`卡片指向站外：${outward.slice(0, 3).join(", ")}`);
  else if (!cardLinks.length) fail("首页没有卡片链接");
  else ok(`${cardLinks.length} 张卡片全部站内跳转，无外链`);

  const grid = /<div class="masonry">([\s\S]*?)<\/div>\s*<p class="home__more"/.exec(home);
  const cardBlocks = grid ? grid[1].split(/(?=<div class="cell )/).slice(1) : [];
  const nested = cardBlocks.filter((b) => /<a [^>]*class="card__link[^"]*"[^>]*>[\s\S]*?<a\b/.test(b));
  if (nested.length) fail(`${nested.length} 张卡片里有嵌套 <a>`);
  else ok(`${cardBlocks.length} 张卡片均无嵌套锚点`);

  console.log("\nthe colour system");
  const allCss = (await Promise.all([...stylesheets].map((s) => get(s)))).map((r) => r.body).join("\n");

  // The current page is marked in the markup, with no script involved: the
  // reference colours the link and rings it.
  //
  // The attribute selector is matched with OPTIONAL quotes: the CSS minifier
  // drops them where they are not needed, so `[aria-current="page"]` ships as
  // `[aria-current=page]`, and a check that demanded the quotes would fail a
  // stylesheet that is perfectly correct.
  if (!/\.nav__link\[aria-current=["']?page["']?\]/.test(allCss)) {
    fail("导航没有给当前页写样式");
  } else if (!/<a class="nav__link" href="\/" aria-current="page">/.test(home)) {
    fail("首页没有把当前页标成 aria-current");
  } else {
    ok("导航当前页由 aria-current 标记，无需脚本");
  }

  // Every page states its accent, and the stylesheet has a rule for it — one
  // without the other means the page silently renders neutral.
  const accented = Object.entries(html).filter(([, b]) => /<body data-accent="[a-z]+"/.test(b));
  if (accented.length !== Object.keys(html).length) {
    fail(`${Object.keys(html).length - accented.length} 个页面没有 data-accent`);
  } else {
    const kinds = new Set(Object.values(html).map((b) => /<body data-accent="([a-z]+)"/.exec(b)[1]));
    for (const k of kinds) {
      if (!new RegExp(`body\\[data-accent=["']?${k}["']?\\]`).test(allCss)) {
        fail(`样式表里没有 body[data-accent="${k}"] 的规则`);
      }
    }
    ok(`${accented.length} 个页面都声明了强调色（${[...kinds].sort().join(" / ")}）`);
  }

  // Tags are chips in a fixed per-name colour, and a tag page carries that same
  // colour as its accent. The invariant worth asserting is the sameness: the
  // colour is information only if it never moves between pages.
  const chipByTag = new Map();
  for (const p of articles) {
    const rail = /id="tags"[\s\S]*?<\/section>/.exec(html[p] || "");
    if (!rail) continue;
    for (const m of rail[0].matchAll(/href="\/tags\/([^"]+)\/"[^>]*>.*?chip chip--([a-z]+)/g)) {
      chipByTag.set(decodeURIComponent(m[1]), m[2]);
    }
  }
  const tagProblems = [];
  for (const [name, colour] of chipByTag) {
    // `html` is keyed by the directory names as they are on disk, which are the
    // decoded ones; the hrefs are percent-encoded, hence the decode above.
    const page = html[`/tags/${name}/`];
    if (!page) { tagProblems.push(`标签「${name}」没有页面`); continue; }
    const accent = /<body data-accent="([a-z]+)"/.exec(page);
    if (!accent) tagProblems.push(`标签页「${name}」没有强调色`);
    else if (accent[1] !== colour) tagProblems.push(`标签「${name}」在文章页是 ${colour}，在标签页是 ${accent[1]}`);
  }
  if (tagProblems.length) tagProblems.slice(0, 3).forEach(fail);
  else if (!chipByTag.size) fail("文章页的标签没有上色");
  else ok(`${chipByTag.size} 个标签在文章页与标签页上同色`);

  console.log("\narticles keep their promises");
  const articleHtml = articles.map((p) => html[p]).filter(Boolean).join("\n");
  const notes = (articleHtml.match(/<aside class="note/g) || []).length;
  const refs = (articleHtml.match(/class="fnref"/g) || []).length;
  if (notes !== refs) fail(`${refs} 个引用标记对应 ${notes} 条脚注`);
  else if (!notes) fail("没有找到内联脚注");
  else ok(`${notes} 条脚注内联在正文里`);

  const forms = {
    admonition: (articleHtml.match(/class="admon admon--/g) || []).length,
    fold: (articleHtml.match(/class="fold"/g) || []).length,
    epigraph: (articleHtml.match(/class="epigraph"/g) || []).length,
    columns: (articleHtml.match(/class="columns"/g) || []).length,
    citation: (articleHtml.match(/class="citeref"/g) || []).length
  };
  const absentForms = Object.entries(forms).filter(([, n]) => n === 0).map(([k]) => k);
  if (absentForms.length) fail(`这些块级写法没有渲染出来：${absentForms.join(", ")}`);
  else ok(`五种块级写法都渲染了：${Object.entries(forms).map(([k, n]) => `${k} ${n}`).join(" · ")}`);

  const leaked = /&lt;div class="(admon|fold|columns|epigraph)/.test(articleHtml);
  if (leaked) fail("块级写法的 HTML 被转义了，说明空行不足");
  else ok("块级写法的 HTML 没有被转义");

  console.log("\ncard covers");
  // Every <img> the site ships is a card cover. The build asserts these too; this
  // pass checks the same things against the SERVED bytes, including that the
  // derivative files are actually reachable (a build that wrote them to the wrong
  // folder would look fine locally and 404 in production).
  const imgs = Object.entries(html).flatMap(([page, body]) =>
    [...body.matchAll(/<img\b([^>]*)>/g)].map((m) => ({ page, attrs: m[1] })));
  if (!imgs.length) fail("全站一张卡片配图都没有 —— 机制在，但没有任何条目用上");
  else {
    const problems = [];
    const files = new Set();
    for (const { page, attrs } of imgs) {
      const attr = (n) => (new RegExp(`${n}="([^"]*)"`).exec(attrs) || [])[1] || "";
      const src = attr("src");
      if (!src.startsWith("/img/")) problems.push(`${page}: 图不是站内的（${src.slice(0, 30)}）`);
      else files.add(src);
      if (!attr("alt").trim()) problems.push(`${page}: 缺 alt`);
      if (!attr("width") || !attr("height")) problems.push(`${page}: 缺宽高`);
      if (attr("loading") !== "lazy") problems.push(`${page}: 没有懒加载`);
      if (!attr("srcset")) problems.push(`${page}: 没有 srcset`);
    }
    if (problems.length) problems.slice(0, 4).forEach(fail);
    else ok(`${imgs.length} 张配图：站内、有 alt、有宽高、懒加载`);
    for (const f of files) {
      const r = await get(f);
      if (r.status !== 200) fail(`${f} → ${r.status}`);
    }
    ok(`${files.size} 个衍生图文件都能取到`);
  }

  console.log("\nthe light-only commitment");
  if (/data-theme/.test(home)) fail("首页仍然带有 data-theme（暗色主题的残留）");
  else ok("没有暗色主题分支");

  console.log("\nmarkup integrity");
  let dupes = 0;
  for (const [page, body] of Object.entries(html)) {
    const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const seenIds = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (seenIds.length) { fail(`${page} has duplicate ids: ${[...new Set(seenIds)].slice(0, 4).join(", ")}`); dupes++; }
  }
  if (!dupes) ok("no duplicate ids");

  console.log("\nthe link graph");
  const index = JSON.parse((await get("/search/index.json")).body);
  if (index.length !== articles.length) fail(`搜索索引 ${index.length} 条，文章 ${articles.length} 篇`);
  else ok(`搜索索引覆盖全部 ${index.length} 篇文章`);

  const broken = [];
  let backlinkChecks = 0;
  for (const a of index) {
    const page = html[a.url];
    if (!page) continue;
    const backlisted = [...page.matchAll(/class="backlist"[^>]*>([\s\S]*?)<\/section>/g)]
      .flatMap((m) => [...m[1].matchAll(/href="([^"]+)"/g)].map((x) => x[1]));
    for (const target of backlisted) {
      const targetPage = html[target];
      if (!targetPage) continue;
      backlinkChecks++;
      if (!targetPage.includes(`href="${a.url}"`)) {
        broken.push(`${target} 的反向链接里说有 ${a.url}，但那一页没有链到它`);
      }
    }
  }
  if (broken.length) broken.slice(0, 3).forEach(fail);
  else ok(`${backlinkChecks} 条反向链接与正向链接双向一致`);

  // Section-level backlinks: the referring page must actually link into THAT
  // section of the target, and the block must sit inside that section rather than
  // anywhere on the page. A fragment that resolves to nothing looks fine to every
  // link checker ever written, so check it here.
  const sectionBack = [];
  const sectionProblems = [];
  for (const [page, body] of Object.entries(html)) {
    for (const m of body.matchAll(/<div class="sectionback">([\s\S]*?)<\/div>/g)) {
      const before = body.slice(0, m.index);
      const headings = [...before.matchAll(/<section class="sec" aria-labelledby="([^"]+)"/g)];
      const sectionId = headings.length ? headings[headings.length - 1][1] : "";
      for (const h of m[1].matchAll(/href="([^"]+)"/g)) {
        const [url, frag] = h[1].split("#");
        sectionBack.push(`${page}#${sectionId} ← ${h[1]}`);
        if (!frag) { sectionProblems.push(`${page} 的节级反向链接没有锚点：${h[1]}`); continue; }
        const source = html[url];
        if (!source) { sectionProblems.push(`${page} 的节级反向链接指向不存在的页面：${url}`); continue; }
        if (!source.includes(`#${frag}`)) {
          sectionProblems.push(`${url} 没有链到 #${frag}，但 ${page} 说它引用了那一节`);
        }
        if (!body.includes(`aria-labelledby="${frag}"`)) {
          sectionProblems.push(`${page} 没有 id 为 ${frag} 的章节，节级反向链接落空了`);
        }
      }
    }
  }
  if (sectionProblems.length) sectionProblems.slice(0, 3).forEach(fail);
  else if (sectionBack.length) ok(`${sectionBack.length} 条节级反向链接落在被引用的那一节里`);
  else fail("节级反向链接一条都没有 —— 机制没有生效");

  console.log("\ncollections");
  for (const c of COLLECTIONS) {
    const body = html[`/${c}/`] || "";
    // Count the CARDS on the page, not the directories on disk: hobbies entries
    // deliberately have no pages of their own, so counting `/hobbies/<slug>/`
    // reported "empty" for a collection that renders a card perfectly well.
    const cards = (body.match(/class="cell cell--/g) || []).length;
    const empty = /class="masonry__empty"|class="empty"/.test(body);
    const entryPages = collectionEntries.filter((p) => p.startsWith(`/${c}/`)).length;
    if (!cards && !empty) fail(`/${c}/ 既没有卡片也没有空态说明`);
    else if (cards && !/class="card[\s"]/.test(body)) fail(`/${c}/ 有格子但没有卡片`);
    else ok(`/${c}/ ${cards} 张卡片${entryPages ? ` · ${entryPages} 个条目页` : " · 无条目页"}`);
  }

  console.log("\naccessibility spot-checks");
  const unlabelled = [];
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
      const label = m[2].replace(/<[^>]+>/g, "").trim();
      if (!label && !/aria-label="[^"]+"/.test(m[1])) unlabelled.push(`${page}: ${m[1].trim().slice(0, 46)}`);
    }
  }
  if (unlabelled.length) unlabelled.slice(0, 5).forEach((u) => fail("unlabelled button → " + u));
  else ok("skip link, main landmark, labelled nav and buttons everywhere");

  console.log("\nfeeds");
  const rss = await get("/rss.xml");
  if (!/<rss/.test(rss.body) || !/<item>/.test(rss.body)) fail("RSS feed is empty or malformed");
  else ok(`RSS 有 ${(rss.body.match(/<item>/g) || []).length} 条`);

  const sitemap = await get("/sitemap.xml");
  const locs = (sitemap.body.match(/<loc>/g) || []).length;
  if (!locs) fail("sitemap is empty");
  else ok(`sitemap 有 ${locs} 条`);

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
