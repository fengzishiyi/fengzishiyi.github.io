#!/usr/bin/env node
/**
 * build.mjs — the pipeline. Read sources, render pages, assert, publish.
 *
 *   _site.json            identity, licence, origin
 *   _articles/<domain>/   the writing
 *        │
 *        ├─ content.mjs    front matter + taxonomy validation + link graph
 *        ├─ render.mjs     Markdown, footnotes, sections, refs
 *        ├─ templates.mjs  page shapes
 *        └─ this file      indices, assertions, atomic publish
 *
 * Everything is staged in .build/ and only swapped into the published tree once
 * the whole run — including the content and design assertions — has succeeded.
 * A failed build therefore never publishes, and never touches what is already
 * live.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { esc, plain, slugify, walk, relative, rm, ensure, exists } from "./lib.mjs";
import { Problems, nearMiss, hexFrom, contrast, todayISO } from "./lib.mjs";
import { DOMAINS, domainByKey, domainKeys, statusByKey } from "./taxonomy.mjs";
import { loadSources, buildLinkGraph } from "./content.mjs";
import { renderBody, searchText, excerpt } from "./render.mjs";
import * as T from "./templates.mjs";

/* ══════════════════════════════════════════════════════════════════════ */
/* config                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ASSETS = path.join(HERE, "assets");
const STAGE = path.join(ROOT, ".build");

const DEFAULTS = {
  origin: "https://fengzishiyi.github.io",
  title: "枫子十一",
  subtitle: "个人写作",
  tagline: "文学、哲学与计算机科学的笔记。",
  author: "fengzishiyi",
  license: "CC BY-NC-SA 4.0",
  lang: "zh-Hans"
};

/** Directories the build owns. Anything here is wiped and re-emitted, and
 *  publish() verifies every one of them landed — a page written to the stage
 *  and forgotten in this list is a page that silently never appears.
 *
 *  The three legacy stub directories belong here for exactly that reason. They
 *  were missing once: `/articles/` 404'd in production, and `/contents/` kept
 *  serving the previous site generation's page — complete with links to deleted
 *  stylesheets — because nothing ever overwrote it. Every local check was green,
 *  because every local check was reading the freshly-written stage. */
const MANAGED = [
  "literature", "philosophy", "compsci",
  "tags", "series", "archive", "search", "changelog", "about",
  "articles", "contents", "images",
  "assets", "index.html", "404.html", "rss.xml", "sitemap.xml", "robots.txt",
  "favicon.svg", ".nojekyll"
];

/** URLs that used to exist and must keep resolving. Two redesigns happened
 *  before this one; old links are someone else's bookmarks. */
const LEGACY = [
  { from: "articles", to: "/archive/", why: "旧的文章索引已并入归档。" },
  { from: "contents", to: "/archive/", why: "杂志目录已取消，改为归档。" },
  { from: "images", to: "/archive/", why: "本站已改为纯文本，不再有图片板块。" }
];

const PRIVATE = new Set([
  ".git", ".github", "node_modules", ".build", ".shots", "src",
  "_articles", "_images", "_issues",
  "package.json", "package-lock.json", "README.md", "DESIGN-NOTES.md", "LICENSE"
]);
const isPrivate = (name) => PRIVATE.has(name) || name.startsWith("_") || name.startsWith(".");

const write = (rel, contents) => {
  const p = path.join(STAGE, rel);
  ensure(path.dirname(p));
  fs.writeFileSync(p, contents);
  return p;
};

function loadSite() {
  const p = path.join(ROOT, "_site.json");
  if (!exists(p)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) {
    throw new Error(`_site.json 不是合法 JSON：${e.message}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
/* git revision history                                                  */
/* ══════════════════════════════════════════════════════════════════════ */

let gitAvailable = null;

/** Is this a git checkout with git on PATH? Cached — the answer does not change
 *  during a build, and asking 50 times is 50 process spawns. */
function haveGit() {
  if (gitAvailable !== null) return gitAvailable;
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, encoding: "utf8" });
  gitAvailable = r.status === 0 && String(r.stdout).trim() === "true";
  return gitAvailable;
}

/**
 * Revision history for one source file, newest first.
 *
 * Honest about failure: if git is missing or the file is untracked, this
 * returns an empty list and the build says so out loud rather than inventing a
 * revision or silently rendering "0 版" as if that were the truth.
 */
function revisionsFor(file) {
  if (!haveGit()) return [];
  const rel = relative(ROOT, file);
  const r = spawnSync("git",
    ["log", "--follow", "--date=short", "--format=%ad%x1f%h%x1f%s", "--", rel],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return [];
  return String(r.stdout).trim().split("\n").filter(Boolean).map((line) => {
    const [date, hash, subject] = line.split("\x1f");
    return { date: date || "", hash: hash || "", subject: subject || "" };
  });
}

/* ══════════════════════════════════════════════════════════════════════ */
/* derived collections                                                   */
/* ══════════════════════════════════════════════════════════════════════ */

function collectTags(articles) {
  const map = new Map();
  for (const a of articles) {
    for (const t of a.tags) {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(a);
    }
  }
  return [...map.entries()]
    .map(([name, items]) => ({
      name,
      items,
      count: items.length,
      // the tag page's own one-line summary: the newest piece under it
      blurb: items[0] ? items[0].description : ""
    }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

function collectSeries(articles) {
  const map = new Map();
  for (const a of articles) {
    if (!a.series) continue;
    if (!map.has(a.series)) map.set(a.series, []);
    map.get(a.series).push(a);
  }
  return [...map.entries()]
    .map(([name, items]) => ({ name, items: items.sort((a, b) => (a.created < b.created ? -1 : 1)) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function buildCounts(articles) {
  const c = {};
  for (const d of DOMAINS) c[d.key] = articles.filter((a) => a.domain === d.key).length;
  c.tags = new Set(articles.flatMap((a) => a.tags)).size;
  c.archive = articles.length;
  c.search = articles.length;
  return c;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* assertions                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

/** gwern's four principles, as checks. These exist so a later edit cannot
 *  quietly walk the site back toward a design that only looks good. */
function checkDesign(log) {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const forScreen = (s) => s.replace(/@media\s+print\s*\{[\s\S]*?\n\}/g, "");
  const css = forScreen(strip(T.CSS.map((n) => fs.readFileSync(path.join(ASSETS, `${n}.css`), "utf8")).join("\n")));
  const js = strip(fs.readFileSync(path.join(ASSETS, "site.js"), "utf8"));
  const failures = [];

  // ---- 极简：no ornament -------------------------------------------------
  const FORBIDDEN = [
    [/box-shadow\s*:(?!\s*none)/g, "出现了阴影（极简原则）"],
    [/border-radius\s*:\s*(?!0)/g, "出现了圆角"],
    [/(?:linear|radial|conic)-gradient/g, "出现了渐变"],
    [/\btext-shadow\s*:/g, "出现了文字阴影"]
  ];
  for (const [re, msg] of FORBIDDEN) {
    const hits = (css.match(re) || []).concat(js.match(re) || []);
    if (hits.length) failures.push(`${msg} → ${[...new Set(hits)].slice(0, 3).join(", ")}`);
  }

  // Colour must be defined once, in tokens.css. A hex literal anywhere else is
  // how a monochrome site silently grows a second palette.
  for (const name of T.CSS.filter((n) => n !== "tokens")) {
    const body = strip(fs.readFileSync(path.join(ASSETS, `${name}.css`), "utf8"));
    const loose = body.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    if (loose.length) {
      failures.push(`${name}.css 里出现了硬编码颜色 ${[...new Set(loose)].slice(0, 4).join(", ")} —— 颜色只能定义在 tokens.css`);
    }
  }

  // ---- no third-party anything -----------------------------------------
  const thirdParty = /https?:\/\/(?!fengzishiyi\.github\.io)[^\s"'<>)]+\.(?:js|css|woff2?|ttf)/gi;
  const external = (css.match(thirdParty) || []).concat(js.match(thirdParty) || []);
  if (external.length) failures.push(`引用了外部脚本/字体：${[...new Set(external)].slice(0, 3).join(", ")}`);
  if (/@import\s+url\(/i.test(css)) failures.push("CSS 里出现了 @import url()，会引入站外请求");

  // ---- 渐进增强：core reading must not need JS --------------------------
  const srcFiles = fs.readdirSync(HERE).filter((f) => f.endsWith(".mjs"));
  const markup = srcFiles.map((f) => fs.readFileSync(path.join(HERE, f), "utf8")).join("\n");
  if (/<aside class="note"/.test(markup) === false) {
    failures.push("脚注不再是内联 <aside>，关掉 JS 后边注会丢失");
  }
  if (!/prefers-reduced-motion/.test(css)) failures.push("没有 prefers-reduced-motion 回退");

  // ---- 中文行宽：30–34 字 ----------------------------------------------
  const measure = /--measure:\s*([\d.]+)em/.exec(css);
  const bodyPx = /--fs-body:\s*([\d.]+)rem/.exec(css);
  if (!measure || !bodyPx) {
    failures.push("--measure 或 --fs-body 未定义，无法校验中文行宽");
  } else {
    // 1em of measure ≈ 1 汉字 of body size, since 汉字 are full-width
    const perLine = parseFloat(measure[1]);
    const ok = perLine >= 29 && perLine <= 35;
    log(`  ${ok ? "ok  " : "FAIL"} 正文行宽 ${perLine.toFixed(1)} 字 (目标 30–34)`);
    if (!ok) failures.push(`正文行宽是 ${perLine.toFixed(1)} 字，超出 30–34 的目标区间`);
  }

  // ---- 对比度：亮色与暗色分别实测 ---------------------------------------
  // Dark values live inside :root[data-theme="dark"], not the base :root, so
  // they need their own reader — reading the base block and pretending it is
  // the dark palette would "pass" while measuring the wrong colours.
  const hexInTheme = (theme, name) => {
    if (!theme) return hexFrom(css, name, null);
    const block = new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\}`).exec(css);
    if (!block) return null;
    return hexFrom(block[1], name, hexFrom(css, name, null));
  };

  const pairs = [
    ["亮色 正文", "ink", "paper", null],
    ["亮色 次要", "ink-mute", "paper", null],
    ["亮色 链接", "link", "paper", null],
    ["暗色 正文", "ink", "paper", "dark"],
    ["暗色 次要", "ink-mute", "paper", "dark"],
    ["暗色 链接", "link", "paper", "dark"]
  ];
  for (const [name, fg, bg, theme] of pairs) {
    const a = hexInTheme(theme, fg);
    const b = hexInTheme(theme, bg);
    if (!a || !b) {
      failures.push(`色板缺少 ${theme ? "暗色" : "亮色"}的 --${fg} 或 --${bg}，无法校验对比度`);
      continue;
    }
    const r = contrast(a, b);
    const ok = r >= 4.5;
    log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(10)} ${r.toFixed(2)}:1`);
    if (!ok) failures.push(`${name}对比度 ${r.toFixed(2)}:1 低于 AA 4.5:1`);
  }

  return failures;
}

/** Guard the promises a personal archive makes to its future self. */
function checkIntegrity({ articles, bySlug, backlinks, outgoing, problems, log }) {
  const failures = [];

  // every slug must be reachable, and no orphan should be unreachable-from
  const linked = new Set([...outgoing.values()].flat().map((l) => l.to));
  const orphans = articles.filter((a) => !linked.has(a.slug) && (backlinks.get(a.slug) || []).length === 0);
  if (orphans.length && articles.length > 1) {
    log(`  ! 没有任何互链的文章 ${orphans.length} 篇：${orphans.slice(0, 3).map((a) => a.slug).join(", ")}`);
    problems.warn(`${orphans.length} 篇文章既没有引用别人，也没有被别人引用`);
  }

  // backlinks must be the exact inverse of outgoing links
  for (const [slug, outs] of outgoing) {
    for (const o of outs) {
      const back = (backlinks.get(o.to) || []).some((b) => b.from === slug);
      if (!back) failures.push(`反向链接不一致：${slug} 引用了 ${o.to}，但 ${o.to} 的 backlinks 里没有 ${slug}`);
    }
  }

  // a source listed twice is usually a copy-paste mistake
  for (const [slug, outs] of outgoing) {
    const seen = new Set();
    for (const o of outs) {
      const key = `${o.to}#${o.anchor}`;
      if (seen.has(key)) problems.warn(`${slug} 重复引用了 ${o.to}${o.anchor ? "#" + o.anchor : ""}`);
      seen.add(key);
    }
  }

  return failures;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* publish                                                               */
/* ══════════════════════════════════════════════════════════════════════ */

function mirrorDir(from, to) {
  rm(to);
  ensure(to);
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) mirrorDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Delete anything in the published tree the build no longer emits.
 *
 *  Recursive on purpose. The first version only looked at root-level FILES, so a
 *  directory dropped from the build survived for ever with its old pages intact
 *  — a stale `/contents/` from the previous site generation kept being served,
 *  still linking to stylesheets that no longer existed. Nothing local noticed,
 *  because every local check was reading the freshly-written stage.
 *
 *  Sources and config live in the same root, so PRIVATE protects them. */
function prunePublished(log) {
  let removed = 0;

  const sweep = (dir, stagedDir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = e.name;
      if (isPrivate(name)) continue;
      const full = path.join(dir, name);
      const staged = stagedDir ? path.join(stagedDir, name) : null;

      if (e.isDirectory()) {
        if (!staged || !exists(staged)) {
          rm(full);
          log(`  pruned      ${relative(ROOT, full)}/（构建已不再产出）`);
          removed++;
        } else {
          sweep(full, staged);
        }
      } else if (!staged || !exists(staged)) {
        fs.rmSync(full, { force: true });
        log(`  pruned      ${relative(ROOT, full)}`);
        removed++;
      }
    }
  };

  sweep(ROOT, STAGE);
  return removed;
}

function publish(log) {
  const stageAssets = path.join(STAGE, "assets");
  rm(stageAssets);
  ensure(stageAssets);
  for (const f of fs.readdirSync(ASSETS)) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(stageAssets, f));
  }

  const assetDst = path.join(ROOT, "assets");
  rm(assetDst);
  ensure(assetDst);
  for (const f of fs.readdirSync(ASSETS)) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(assetDst, f));
  }

  for (const rel of MANAGED) {
    if (rel === "assets") continue;
    const src = path.join(STAGE, rel);
    const dst = path.join(ROOT, rel);
    if (!exists(src)) { rm(dst); continue; }
    if (fs.statSync(src).isDirectory()) mirrorDir(src, dst);
    else { ensure(path.dirname(dst)); fs.copyFileSync(src, dst); }
  }

  const missing = MANAGED.filter((r) => !exists(path.join(ROOT, r)));
  if (missing.length) throw new Error(`这些路径没有发布成功：${missing.join(", ")}`);

  const removed = prunePublished(log);
  log(`  published → 仓库根目录（${MANAGED.length} 个路径全部就位${removed ? `，清理了 ${removed} 个陈旧文件` : ""}）`);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* main                                                                  */
/* ══════════════════════════════════════════════════════════════════════ */

async function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check-only");
  const contentOnly = argv.includes("--content-only");
  const linksOnly = argv.includes("--links-only");
  const log = (s) => console.log(s);
  const t0 = Date.now();

  if (argv.includes("--clean")) {
    rm(STAGE);
    for (const rel of MANAGED) rm(path.join(ROOT, rel));
    log("已清理");
    if (!checkOnly && !contentOnly && !linksOnly) return;
  }

  if (!checkOnly && !linksOnly) { rm(STAGE); ensure(STAGE); }

  const site = loadSite();
  const problems = new Problems();

  /* ---- content ------------------------------------------------------ */
  log("▸ 读取文章");
  const sources = loadSources(ROOT, problems, log);
  if (!sources.length) {
    log("\n没有找到任何文章。_articles/ 下需要有 <领域>/ 目录与 .md 文件。");
    process.exit(1);
  }

  /* ---- link graph --------------------------------------------------- */
  log("▸ 链接图");
  const { bySlug, byTag, outgoing, backlinks } = buildLinkGraph(sources, problems);
  const refCount = [...outgoing.values()].reduce((n, l) => n + l.length, 0);
  log(`  ${refCount} 条互链 · ${[...backlinks.values()].filter((b) => b.length).length} 篇被引用`);

  if (linksOnly) {
    problems.report(log, "✗ 链接有问题");
    const status = problems.failed ? 1 : 0;
    if (!status) {
      log("\n✓ 链接检查通过");
      log("\n可用 slug：");
      for (const slug of [...bySlug.keys()].sort()) {
        const a = bySlug.get(slug);
        log(`  ${slug.padEnd(28)} ${a.domainName} · ${a.kind} · ${a.title}`);
      }
    }
    process.exit(status);
  }

  /* ---- render ------------------------------------------------------- */
  log("▸ 渲染正文");
  const revisions = new Map();
  for (const a of sources) {
    const body = renderBody(a, {
      resolve: (slug) => bySlug.get(slug) || null
    });
    a.html = body.html;
    a.notes = body.notes;
    a.headings = body.headings;
    a.allHeadings = body.allHeadings;
    if (!checkOnly && !contentOnly) {
      a.revisions = revisionsFor(a.file);
      revisions.set(a.slug, a.revisions);
    }
    if (!a.revisions) a.revisions = [];
  }

  const withRevisions = sources.filter((a) => a.revisions.length);
  if (!checkOnly && !contentOnly) {
    if (!haveGit()) {
      log("  ! 没有可用的 git —— 修订记录会显示为空。这不是数据丢失，只是这台机器上取不到历史。");
      problems.warn("无法读取 git 历史：修订记录为空、引用里的版本号缺失");
    } else if (withRevisions.length < sources.length) {
      const untracked = sources.filter((a) => !a.revisions.length);
      problems.warn(`${untracked.length} 篇文章还没有提交过，暂无修订记录：${untracked.slice(0, 3).map((a) => a.slug).join(", ")}`);
    }
    log(`  ${withRevisions.length}/${sources.length} 篇有 git 历史`);
  }

  /* ---- derived collections ------------------------------------------ */
  const articles = sources.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  const tags = collectTags(articles);
  const series = collectSeries(articles);
  const counts = buildCounts(articles);
  const byDomain = new Map(DOMAINS.map((d) => [d.key, articles.filter((a) => a.domain === d.key)]));

  if (contentOnly) {
    problems.report(log, "✗ 内容有问题");
    log(problems.failed ? "" : "\n✓ 内容检查通过");
    log(`  ${articles.length} 篇 · ${tags.length} 个标签 · ${series.length} 个系列`);
    process.exit(problems.failed ? 1 : 0);
  }

  /* ---- assertions --------------------------------------------------- */
  log("▸ 风格与完整性断言");
  const designFailures = checkDesign(log);
  const integrityFailures = checkIntegrity({ articles, bySlug, backlinks, outgoing, problems, log });
  const failures = [...designFailures, ...integrityFailures];

  if (checkOnly) {
    problems.report(log, "✗ 内容有问题");
    log(failures.length ? `\n✗ ${failures.length} 项断言失败` : "\n✓ 断言通过");
    process.exit(failures.length || problems.failed ? 1 : 0);
  }

  /* ---- pages -------------------------------------------------------- */
  log("▸ 生成页面");

  for (const d of DOMAINS) {
    const items = byDomain.get(d.key) || [];
    write(`${d.key}/index.html`, T.pageDomain(site, d, items, counts));
  }

  write("index.html", T.pageHome(site, {
    articles,
    byDomain,
    tags,
    series,
    latest: articles,
    random: articles.length ? articles[Math.floor(articles.length / 2)] : null,
    counts
  }));

  write("archive/index.html", T.pageArchive(site, {
    articles,
    years: [...new Set(articles.map((a) => a.created.slice(0, 4)))].sort().reverse(),
    counts
  }));

  write("tags/index.html", T.pageTags(site, tags, counts));
  for (const t of tags) {
    write(`tags/${slugify(t.name)}/index.html`,
      T.pageTag(site, t.name, t.items, backlinks, counts));
  }

  write("series/index.html", T.pageSeriesIndex(site, series, counts));
  for (const s of series) {
    write(`series/${slugify(s.name)}/index.html`,
      T.pageSeries(site, s.name, s.items, counts));
  }

  write("search/index.html", T.pageSearch(site, counts));
  write("changelog/index.html", T.pageChangelog(site, { articles, counts }));
  write("about/index.html", T.pageAbout(site, { articles, counts, tags }));

  const htmlFiles = [];
  for (const a of articles) {
    const idx = articles.indexOf(a);
    write(`${a.domain}/${a.slug}/index.html`, T.pageArticle(site, a, {
      revisions: a.revisions,
      backlinks: backlinks.get(a.slug) || [],
      outgoing: outgoing.get(a.slug) || [],
      bySlug,
      notes: a.notes,
      notesHtml: a.html,
      headings: a.headings,
      prev: articles[idx - 1] || null,
      next: articles[idx + 1] || null
    }));
    htmlFiles.push(`${a.domain}/${a.slug}/index.html`);
  }

  /* ---- legacy redirects -------------------------------------------- */
  for (const l of LEGACY) {
    write(`${l.from}/index.html`, T.pageRedirect(site, `/${l.from}/`, l.to, l.why, counts));
  }
  // the old magazine used /articles/<slug>/ for individual pieces
  for (const a of articles) {
    const legacyPath = `articles/${a.slug}/index.html`;
    write(legacyPath, T.pageRedirect(site, `/articles/${a.slug}/`, a.url,
      "杂志形态已取消，文章现在按领域归档。", counts));
    htmlFiles.push(legacyPath);
  }

  /* ---- search index ------------------------------------------------- */
  const index = articles.map((a) => ({
    slug: a.slug,
    url: a.url,
    title: a.title,
    description: a.description,
    domain: a.domain,
    domainName: a.domainName,
    kind: a.kind,
    year: a.created.slice(0, 4),
    date: a.created,
    tags: a.tags,
    status: a.status,
    chars: a.chars,
    text: searchText(a.html)
  }));
  write("search/index.json", JSON.stringify(index));

  /* ---- 404 with a guess --------------------------------------------- */
  write("404.html", T.page404(site, null, counts));

  /* ---- feeds & meta ------------------------------------------------- */
  write("rss.xml", T.rss(site, articles));
  write("favicon.svg", T.favicon(site));
  write(".nojekyll", "");
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${site.origin}/sitemap.xml\n`);

  const urls = [
    "/", "/archive/", "/tags/", "/series/", "/search/", "/changelog/", "/about/",
    ...DOMAINS.map((d) => `/${d.key}/`),
    ...tags.map((t) => `/tags/${slugify(t.name)}/`),
    ...series.map((s) => `/series/${slugify(s.name)}/`),
    ...articles.map((a) => a.url)
  ];
  write("sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map((u) => `  <url><loc>${site.origin}${u}</loc></url>`).join("\n")
    }\n</urlset>\n`);

  /* ---- size report -------------------------------------------------- */
  const pageBytes = htmlFiles.reduce((n, f) => n + fs.statSync(path.join(STAGE, f)).size, 0);
  const biggest = htmlFiles
    .map((f) => [f, fs.statSync(path.join(STAGE, f)).size])
    .sort((a, b) => b[1] - a[1])[0];
  // T.CSS holds bare names ("tokens", "base", …); the script is listed too so
  // the budget covers everything a reader actually downloads.
  const shippedFiles = T.CSS.map((n) => `${n}.css`).concat(["site.js"]);
  const cssJs = shippedFiles.reduce((n, f) => n + fs.statSync(path.join(ASSETS, f)).size, 0);

  log("▸ 体积");
  log(`  文章平均    ${(pageBytes / Math.max(1, htmlFiles.length) / 1024).toFixed(1)} KB`);
  log(`  最大一页    ${(biggest[1] / 1024).toFixed(1)} KB  (${biggest[0]})`);
  log(`  css + js    ${(cssJs / 1024).toFixed(1)} KB  (${shippedFiles.length} 个文件，无第三方)`);

  const budgets = [
    ["最大单页", biggest[1] / 1024, 120, "KB"],
    ["css+js", cssJs / 1024, 60, "KB"]
  ];
  for (const [name, val, max, unit] of budgets) {
    if (val > max) failures.push(`${name} ${val.toFixed(1)}${unit} 超出预算 ${max}${unit}`);
    else log(`  ${name} 在预算内 ${val.toFixed(1)}${unit} / ${max}${unit}`);
  }

  /* ---- gate ---------------------------------------------------------- */
  problems.report(log, "✗ 内容有问题");
  if (failures.length || problems.failed) {
    log("\n✗ 构建未发布任何文件（上一版仍然在线）：");
    for (const f of failures) log("   · " + f);
    process.exit(1);
  }

  publish(log);
  log(`\n✓ 构建完成：${walk(STAGE).length} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  ${articles.length} 篇 · ${tags.length} 个标签 · ${series.length} 个系列 · ${refCount} 条互链`);
}

main().catch((e) => {
  console.error("\n✗ 构建失败:", e.message);
  console.error(e.stack);
  process.exit(1);
});
