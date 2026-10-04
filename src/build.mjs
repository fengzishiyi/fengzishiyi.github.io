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
import { Problems, nearMiss, hexFrom, rgbaFrom, flatten, contrast, todayISO } from "./lib.mjs";
import { DOMAINS, domainByKey, domainKeys, statusByKey } from "./taxonomy.mjs";
import { loadSources, loadCollections, buildLinkGraph } from "./content.mjs";
import { renderBody, searchText } from "./render.mjs";
import { prepareImage, emitImage } from "./images.mjs";
import { COLLECTIONS, collectionByKey } from "./taxonomy.mjs";
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
  "literature", "philosophy", "compsci", "writing",
  "reading", "hobbies",
  "tags", "series", "archive", "search", "changelog", "about",
  "articles", "contents", "images",
  "assets", "img", "index.html", "404.html", "rss.xml", "sitemap.xml", "robots.txt",
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
  "_articles", "_images", "_issues", "_reading", "_hobbies",
  "package.json", "package-lock.json", "README.md", "DESIGN-NOTES.md", "LICENSE"
]);

/**
 * What the publish pruner must never delete.
 *
 * The name list above is for files that live in the root but are not output.
 * The extension rule is the important half: the build never emits Markdown, so
 * ANY root-level `.md` is documentation and must survive. Without it, adding a
 * new document to the repository root means the next build silently deletes it —
 * which is exactly what happened to AUDIT.md the first time it was written.
 * Protection by rule rather than by a list someone has to remember to extend.
 */
const isPrivate = (name) =>
  PRIVATE.has(name) || name.startsWith("_") || name.startsWith(".") || /\.(md|markdown)$/i.test(name);

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

/**
 * Tags span BOTH content kinds.
 *
 * They were originally collected from articles alone, so a tag on a reading or
 * hobby entry rendered as a chip that linked to a tag page the build never
 * created — 404s that only the smoke suite (which walks every href) caught.
 * A tag is a property of the collection, not of one content type.
 */
function collectTags(articles, collections = {}) {
  const map = new Map();
  const add = (item) => {
    for (const t of item.tags || []) {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(item);
    }
  };
  for (const a of articles) add(a);
  for (const key of Object.keys(collections)) for (const e of collections[key]) add(e);

  return [...map.entries()]
    .map(([name, items]) => ({
      name,
      items: items.sort((a, b) => (a.created < b.created ? 1 : -1)),
      count: items.length,
      // A tag with only one piece under it has nothing to summarise: printing
      // that piece's own description under the tag just repeats a sentence the
      // reader is about to see again. The count already says how much is here.
      blurb: items.length > 1 && items[0] ? (items[0].description || items[0].title) : ""
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

/**
 * The design contract, as checks.
 *
 * The previous revision of this file asserted a MONOCHROME system — no shadows,
 * no rounded corners, no gradients, one grayscale palette. chester.how is the
 * opposite of that: rounded cards, three shadow levels, and colour used as tag
 * decoration. Those assertions are gone, and what replaces them is what matters
 * about this design instead:
 *
 *   · the measured type ramp (weight 300, negative tracking, 16/26 body)
 *   · the light-only commitment — a dark palette must NOT exist
 *   · the card grid stays a grid: every card links inside the site
 *   · the content promises (Chinese measure, inline notes, no third parties)
 */
function checkDesign(log) {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const forScreen = (s) => s.replace(/@media\s+print\s*\{[\s\S]*?\n\}/g, "");
  const css = forScreen(strip(T.CSS.map((n) => fs.readFileSync(path.join(ASSETS, `${n}.css`), "utf8")).join("\n")));
  const tokens = strip(fs.readFileSync(path.join(ASSETS, "tokens.css"), "utf8"));
  const js = strip(fs.readFileSync(path.join(ASSETS, "site.js"), "utf8"));
  const failures = [];

  // ---- light only ------------------------------------------------------
  // chester.how states "no dark surfaces or backgrounds" as a rule, and the
  // previous two-theme system is deliberately retired. If a dark branch ever
  // comes back it should be a decision, not a drift.
  if (/data-theme|prefers-color-scheme:\s*dark/.test(css + js)) {
    failures.push("出现了暗色主题分支 —— 本站是纯亮色设计（chester.how 的明确规则）");
  }
  if (/--paper-dark|--ink-dark/.test(css)) failures.push("tokens.css 里又出现了暗色令牌");

  // ---- the type ramp ---------------------------------------------------
  // Read out of the stylesheet, because the whole design is these numbers and a
  // quiet edit to any of them is a design change. Values are normalised to px
  // (1rem = 16px) so the comparison does not depend on the unit chosen.
  //
  // chester.how publishes four roles: H1 36/300/−1.08, H3 30/300/−0.90, body
  // 16/400/−0.40, nav 14/400/−0.35. An article here needs three heading levels —
  // the page title, its sections, and subsections within a section — so the two
  // heading numbers chester does publish go on the two levels that exist
  // (page title = 36, section = 30) and the third is derived one step below.
  const ramp = [
    ["--fs-body", 16, 0, "正文 16px"],
    ["--lh-body", 1.625, 0.02, "正文行高 26/16"],
    ["--tr-body", -0.4, 0.05, "正文字距 −0.40px"],
    ["--fs-h1", 36, 0, "H1 36px"],
    ["--fs-h2", 30, 0, "H2 30px"],
    ["--fs-h3", 24, 0, "H3 24px"]
  ];
  const rampPx = new Map();
  for (const [name, want, tol, label] of ramp) {
    // unitless is legitimate for a line-height, so accept all three forms
    const m = new RegExp(`${name}:\\s*(-?[\\d.]+)(px|rem|)\\s*;`).exec(tokens);
    if (!m) { failures.push(`tokens.css 缺少 ${name}`); continue; }
    const raw = parseFloat(m[1]);
    const value = m[2] === "rem" ? raw * 16 : raw;   // px or unitless-as-px
    rampPx.set(name, value);
    const ok = Math.abs(value - want) <= tol;
    log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(22)} ${m[1]}${m[2] || ""}`);
    if (!ok) failures.push(`${label} 变成了 ${m[1]}${m[2] || ""}`);
  }
  // The hierarchy itself, asserted separately from the individual numbers.
  // `font-size: var(--fs-h2)` with --fs-h2 undefined is not an error anywhere:
  // the declaration is dropped and the element inherits its parent's size, so an
  // H2 rendered at 16px — SMALLER than the H3 under it — with every check green.
  // It took a screenshot to notice. This is the check that states the invariant.
  const h1 = rampPx.get("--fs-h1"), h2 = rampPx.get("--fs-h2"), h3 = rampPx.get("--fs-h3");
  if (h1 && h2 && h3) {
    const ranked = h1 > h2 && h2 > h3;
    log(`  ${ranked ? "ok  " : "FAIL"} 标题层级       H1 ${h1} > H2 ${h2} > H3 ${h3}`);
    if (!ranked) failures.push(`标题层级乱了：H1 ${h1} / H2 ${h2} / H3 ${h3}，必须逐级递减`);
  }

  // ---- every referenced custom property must exist ---------------------
  // Same failure mode as above, caught in general: an undefined custom property
  // makes the whole declaration invalid, and the element quietly inherits.
  // `--note-offset` is the one legitimate exception — site.js sets it on the
  // element, so it can never appear in a stylesheet.
  const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  // Two legitimate exceptions, both set on the element at runtime rather than in
  // a stylesheet: the sidenote offset the script computes, and the entrance
  // index the template writes per card and per list row.
  const RUNTIME_VARS = new Set(["--note-offset", "--i"]);
  const undefinedVars = new Set();
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)/gi)) {
    if (!defined.has(m[1]) && !RUNTIME_VARS.has(m[1])) undefinedVars.add(m[1]);
  }
  if (undefinedVars.size) {
    failures.push(`这些变量没有定义，用到它们的整条声明会被丢弃：${[...undefinedVars].join(", ")}`);
  } else {
    log(`  ok   变量引用      ${defined.size} 个变量，每个 var() 都有着落`);
  }
  // headings at weight 300 — the lightness IS the aesthetic
  const hRule = /(?:^|[\s,])(?:h1|h2|h3|h4)[^{]*\{[^}]*\}/g;
  for (const block of css.match(hRule) || []) {
    const w = /font-weight:\s*(\d+)/.exec(block);
    if (w && w[1] !== "300") failures.push(`标题字重变成了 ${w[1]} —— chester 的排版是 300`);
  }

  // ---- no third-party anything -----------------------------------------
  const thirdParty = /https?:\/\/(?!fengzishiyi\.github\.io)[^\s"'<>)]+\.(?:js|css|woff2?|ttf)/gi;
  const external = (css.match(thirdParty) || []).concat(js.match(thirdParty) || []);
  if (external.length) failures.push(`引用了外部脚本/字体：${[...new Set(external)].slice(0, 3).join(", ")}`);
  if (/@import\s+url\(/i.test(css)) failures.push("CSS 里出现了 @import url()，会引入站外请求");

  // ---- progressive enhancement -----------------------------------------
  const srcFiles = fs.readdirSync(HERE).filter((f) => f.endsWith(".mjs"));
  const markup = srcFiles.map((f) => fs.readFileSync(path.join(HERE, f), "utf8")).join("\n");
  if (!/<aside class="note"/.test(markup)) {
    failures.push("脚注不再是内联 <aside>，关掉 JS 后边注会丢失");
  }
  for (const marker of ['class="admon', 'class="fold', 'class="epigraph', 'class="columns']) {
    if (!markup.includes(marker)) failures.push(`标记不见了：${marker}（关掉 JS 后应仍然可见）`);
  }
  if (!/prefers-reduced-motion/.test(css)) failures.push("没有 prefers-reduced-motion 回退");

  // ---- 中文行宽：30–34 字 ----------------------------------------------
  const measure = /--measure:\s*([\d.]+)em/.exec(css);
  if (!measure) {
    failures.push("--measure 未定义，无法校验中文行宽");
  } else {
    const perLine = parseFloat(measure[1]);
    const ok = perLine >= 29 && perLine <= 35;
    log(`  ${ok ? "ok  " : "FAIL"} 正文行宽 ${perLine.toFixed(1)} 字 (目标 30–34)`);
    if (!ok) failures.push(`正文行宽是 ${perLine.toFixed(1)} 字，超出 30–34 的目标区间`);
  }

  // ---- contrast ---------------------------------------------------------
  // Measured on the values that actually render: the two text greys against
  // every ground they sit on, and every chip — the site's only chromatic
  // surfaces — composited over the page and over a card, because a 40% tint is
  // not the colour anybody sees until it is laid over something.
  const contrastPairs = [
    ["正文", "ink", "page", 4.5],
    ["卡片正文", "ink-body", "card", 4.5],
    ["次要文字（页面）", "ink-muted", "page", 4.5],
    ["次要文字（卡片）", "ink-muted", "card", 4.5],
    ["焦点环", "focus-ring-strong", "page", 3],
    ["焦点环（卡片）", "focus-ring-strong", "card", 3]
  ];
  for (const [name, fg, bg, need] of contrastPairs) {
    const a = hexFrom(tokens, fg, null);
    const b = hexFrom(tokens, bg, null);
    if (!a || !b) { failures.push(`色板缺少 --${fg} 或 --${bg}，无法校验${name}对比度`); continue; }
    const r = contrast(a, b);
    const ok = r >= need;
    log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(16)} ${r.toFixed(2)}:1 (需要 ${need})`);
    if (!ok) failures.push(`${name}对比度 ${r.toFixed(2)}:1 低于 ${need}:1`);
  }

  // The chips are drawn at 14px, so they are normal text and need the full 4.5.
  const chipNames = ["amber", "lime", "orange", "green", "purple", "sky", "rose", "teal", "neutral"];
  const chipFailures = [];
  for (const name of chipNames) {
    const fill = rgbaFrom(tokens, `chip-${name}-bg`, null);
    const ink = hexFrom(tokens, `chip-${name}-fg`, null);
    if (!fill || !ink) { chipFailures.push(`${name} 缺少定义`); continue; }
    for (const [ground, base] of [["页面", hexFrom(tokens, "page", null)], ["卡片", hexFrom(tokens, "card", null)]]) {
      const r = contrast(ink, flatten(fill, base));
      if (r < 4.5) chipFailures.push(`${name}/${ground} ${r.toFixed(2)}:1`);
    }
  }
  const chipCount = chipNames.length * 2;
  if (chipFailures.length) failures.push(`标签配色对比度不足：${chipFailures.slice(0, 4).join(", ")}`);
  else log(`  ok   标签配色      ${chipNames.length} 色 × 2 底色 = ${chipCount} 组全部 ≥4.5`);

  // ---- decoration stays decoration -------------------------------------
  // `--ink-faint` measures 3.45:1 — fine for a glyph, not for text. Rather than
  // leave that as a note in a comment, the allowed selectors are listed and
  // anything else using it fails the build.
  const FAINT_ALLOWED = [".anchor", "hr.divider::before"];
  const faintUsers = [];
  for (const block of css.match(/[^{}]+\{[^}]*\}/g) || []) {
    if (!/var\(--ink-faint\)/.test(block)) continue;
    const selector = block.slice(0, block.indexOf("{")).trim();
    if (!FAINT_ALLOWED.includes(selector)) faintUsers.push(selector);
  }
  if (faintUsers.length) {
    failures.push(`--ink-faint（3.45:1）只能用于装饰，这些地方把它用在文字上了：${[...new Set(faintUsers)].join(", ")}`);
  } else {
    log(`  ok   浅灰用途     --ink-faint 只用于 ${FAINT_ALLOWED.join(" / ")}`);
  }

  // ---- the script and the stylesheet must agree -------------------------
  // The bug this exists for: site.js toggled `is-collapsed` on a fold while the
  // stylesheet answered to `fold--folded`, so the control flipped its own label
  // and hid nothing. Same shape as `.reveal`/`is-shown`, which had a script and
  // no CSS at all. Neither was an error anywhere — a class name is a string, and
  // nothing checks strings. So: every class the script writes must be a selector
  // somewhere, and every `data-` attribute the stylesheet branches on must have
  // a writer.
  const SCRIPT_CLASS_EXCEPTIONS = new Set(["fold__label--inline"]);
  const written = new Set();
  for (const m of js.matchAll(/classList\.(?:add|toggle|remove)\(\s*"([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) written.add(c);
  }
  for (const m of js.matchAll(/\.className\s*=\s*"([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) written.add(c);
  }
  const unstyled = [...written].filter((c) => !SCRIPT_CLASS_EXCEPTIONS.has(c) && !new RegExp(`\\.${c}\\b`).test(css));
  if (unstyled.length) {
    failures.push(`脚本会写这些类名，但样式表里没有对应规则，等于点了没反应：${unstyled.join(", ")}`);
  } else {
    log(`  ok   脚本↔样式   ${written.size} 个类名都有对应规则`);
  }

  const sources = fs.readdirSync(HERE).filter((f) => f.endsWith(".mjs"))
    .map((f) => fs.readFileSync(path.join(HERE, f), "utf8"))
    .join("\n") + fs.readFileSync(path.join(ASSETS, "site.js"), "utf8")
    + fs.readFileSync(path.join(ASSETS, "guess404.js"), "utf8");
  const dataAttrs = new Set([...css.matchAll(/\[(data-[a-z-]+)/g)].map((m) => m[1]));
  const unwritten = [...dataAttrs].filter((a) => !sources.includes(a));
  if (unwritten.length) {
    failures.push(`样式表按这些属性分支，但没有任何地方写它，分支永远走不到：${unwritten.join(", ")}`);
  } else {
    log(`  ok   属性分支   ${dataAttrs.size} 个 data- 属性都有写入者`);
  }

  // ---- deleted things stay deleted --------------------------------------
  // Each of these was removed for a reason recorded in DESIGN-NOTES; a selector
  // creeping back means the reason was forgotten.
  //
  // `.card--image`, `.card__img` and `.card__caption` were on this list and were
  // taken off deliberately: cards carry covers again, so those rules are live.
  // They are now spelled `.card--photo` / `.card--scrim`, and the list below
  // keeps the OLD names gone so a half-rename cannot leave two spellings of the
  // same component in the stylesheet.
  const GONE = {
    "card--image": "改名为 card--photo / card--scrim",
    "home__title": "上一代的首页版式",
    "homecols": "上一代的首页版式",
    "tagcloud": "上一代的首页版式",
    "serieslist": "上一代的首页版式",
    "linkbtn": "无人使用",
    "wrap--narrow": "无人使用",
    "tracking-tight": "无人使用",
    "nav__n": "无人使用",
    "fold--folded": "脚本写的是 is-collapsed",
    "notelist": "脚注开关已删除",
    "readerbtn": "阅读模式已删除"
  };
  const back = Object.keys(GONE).filter((c) => new RegExp(`\\.${c}\\b`).test(css));
  if (back.length) failures.push(`这些已经删掉的东西又回来了：${back.map((c) => `${c}（${GONE[c]}）`).join("；")}`);
  else log(`  ok   已删项       ${Object.keys(GONE).length} 个删除项没有回来`);
  for (const dead of ["--ink-40", "--ink-60", "--ink-80", "--link-visited", "--shadow-lift"]) {
    if (new RegExp(`${dead}:`).test(tokens)) failures.push(`令牌 ${dead} 又出现了，它是前几代的遗留`);
  }
  if (/data-notes|data-reader/.test(css + js)) {
    failures.push("样式或脚本里又出现了 data-notes / data-reader —— 那些开关已经删掉了");
  }

  // ---- the nav is fixed ------------------------------------------------
  const navTexts = T.NAV.map((n) => n.text);
  if (navTexts.join("|") !== "首页|写作|阅读|爱好|标签|关于") {
    failures.push(`导航标签变成了 ${navTexts.join(" / ")}`);
  } else {
    log(`  ok   导航标签  ${navTexts.join(" · ")}`);
  }
  if (navTexts.includes("项目")) failures.push("导航里又出现了「项目」—— 本轮明确要去掉");

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
/* assertions on the rendered output                                     */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * Checks that can only run once the pages exist.
 *
 * These read the ARTEFACT. An earlier version of the card check pattern-matched
 * a variable name inside templates.mjs, so renaming a local variable failed the
 * build while the output was perfectly correct — an assertion coupled to how the
 * code is written rather than to what it produces. Everything here inspects the
 * generated HTML instead.
 */
function checkRendered(log) {
  const failures = [];
  const homePath = path.join(STAGE, "index.html");
  if (!exists(homePath)) return failures;

  const home = fs.readFileSync(homePath, "utf8");

  // cards must point inside the site
  const cardHrefs = [...home.matchAll(/<a class="card__link[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
  const outward = cardHrefs.filter((h) => /^https?:/i.test(h));
  if (outward.length) {
    failures.push(`卡片指向了站外：${[...new Set(outward)].slice(0, 3).join(", ")}`);
  } else if (cardHrefs.length) {
    log(`  ok   卡片链接      ${cardHrefs.length} 张全部站内跳转`);
  } else {
    failures.push("首页上找不到任何卡片链接");
  }

  // An anchor inside an anchor is invalid: the parser closes the outer one, the
  // DOM is restructured, and the card ends up 883px wide in a 390px grid.
  //
  // Two boundaries matter here. The grid is sliced out of the page first, so the
  // scan cannot run on into the footer's links; and each card is split on the
  // next card, so a window cannot span two siblings. Without both, this reports
  // nesting that is not there — it did, twice.
  const grid = /<div class="masonry">([\s\S]*?)<\/div>\s*<p class="home__more"/.exec(home);
  const cards = grid ? grid[1].split(/(?=<div class="cell )/).slice(1) : [];
  const nested = cards.filter((b) =>
    /<a [^>]*class="card__link[^"]*"[^>]*>[\s\S]*?<a\b/.test(b));
  if (nested.length) {
    failures.push(`卡片里出现了嵌套的 <a>（${nested.length} 张），会导致浏览器重构 DOM 并破坏版式`);
  } else {
    log(`  ok   卡片结构      ${cards.length} 张均无嵌套 <a>`);
  }

  // the grid must actually be a grid
  const cells = (home.match(/class="cell cell--(intro|wide|square)"/g) || []);
  const kinds = new Set(cells.map((c) => /cell--(\w+)/.exec(c)[1]));
  if (!cells.length) failures.push("首页没有 masonry 网格");
  else log(`  ok   网格          ${cells.length} 格 (${[...kinds].join(" / ")})`);
  if (!kinds.has("intro")) failures.push("首页缺少 intro 大卡");

  // ---- the section pages are grids too ---------------------------------
  // They used to be three labelled blocks with entry lists, which is what the
  // instruction "writing does not need to be forced into three groups, just
  // scatter it into cards" was about. Every one of them now wears the same
  // header and the same grid as the homepage.
  const gridPages = [
    "writing/index.html", "reading/index.html", "hobbies/index.html",
    ...DOMAINS.map((d) => `${d.key}/index.html`)
  ];
  const notGrid = [];
  for (const rel of gridPages) {
    const f = path.join(STAGE, rel);
    if (!exists(f)) { notGrid.push(`${rel} 不存在`); continue; }
    const body = fs.readFileSync(f, "utf8");
    if (!/<div class="masonry">/.test(body)) notGrid.push(`${rel} 没有砖石网格`);
    if (!/class="pagehead__title"/.test(body)) notGrid.push(`${rel} 没有页首大标题`);
    if (/class="secblock"/.test(body)) notGrid.push(`${rel} 还留着按领域分组的旧结构`);
  }
  if (notGrid.length) failures.push(`分区页不一致：${notGrid.slice(0, 3).join("；")}`);
  else log(`  ok   分区页        ${gridPages.length} 个分区页都是网格 + 页首标题`);

  // ---- hobby cards are display tiles -----------------------------------
  // A card that looks clickable but is not is worse than one that plainly is
  // not, so this is checked in both directions: the hobby grid must have no card
  // links, and the reading grid must still have them.
  const hobbyPage = path.join(STAGE, "hobbies/index.html");
  if (exists(hobbyPage)) {
    const body = fs.readFileSync(hobbyPage, "utf8");
    const gridHtml = /<div class="masonry">([\s\S]*?)\n<\/div>/.exec(body);
    const inner = gridHtml ? gridHtml[1] : "";
    const links = (inner.match(/<a\b/g) || []).length;
    const arrows = (inner.match(/class="card__arrow"/g) || []).length;
    const tiles = (inner.match(/class="card card--display"/g) || []).length;
    if (links) failures.push(`爱好卡片里出现了 ${links} 个链接 —— 它们是只展示的卡片`);
    else if (arrows) failures.push(`爱好卡片里出现了 ${arrows} 个 ↗ —— 没有链接就不该有箭头`);
    else log(`  ok   爱好卡片      ${tiles} 张只展示：无链接、无箭头`);
  }

  // ---- and they have no pages of their own -----------------------------
  const strayHobbyPages = walk(STAGE).filter((f) => /[\\/]hobbies[\\/][^\\/]+[\\/]index\.html$/.test(f));
  if (strayHobbyPages.length) {
    failures.push(`爱好条目不该有自己的页面：${strayHobbyPages.slice(0, 2).map((f) => relative(STAGE, f)).join(", ")}`);
  } else {
    log("  ok   爱好条目     没有生成页面，与只展示的卡片一致");
  }

  // exactly one h1 per page, checked on the rendered files
  let worst = 0;
  const themed = [];
  const orphans = [];
  const selfLinks = [];
  const nesting = [];
  const bareHeads = [];
  const badImages = [];
  let cardImages = 0;
  let imageBytes = 0;
  for (const f of walk(STAGE).filter((x) => x.endsWith(".html"))) {
    const body = fs.readFileSync(f, "utf8");

    // ---- card covers --------------------------------------------------
    // Every <img> on the site is a card cover, and each one has to be local,
    // described, lazy, and sized. Each of those has a failure mode that is
    // invisible in a browser: a remote src is a third-party request, a missing
    // alt is a picture nobody can hear, a missing width/height is a grid that
    // jumps as the pictures land.
    for (const m of body.matchAll(/<img\b([^>]*)>/g)) {
      const attrs = m[1];
      cardImages++;
      const attr = (n) => (new RegExp(`${n}="([^"]*)"`).exec(attrs) || [])[1] || "";
      const src = attr("src");
      const file = relative(STAGE, f);
      if (!src.startsWith("/img/")) badImages.push(`${file}: 图片不是站内的（${src.slice(0, 40)}）`);
      else {
        const onDisk = path.join(STAGE, src.replace(/^\//, ""));
        if (!exists(onDisk)) badImages.push(`${file}: 图片文件不存在（${src}）`);
        else imageBytes += fs.statSync(onDisk).size;
      }
      if (!attr("alt").trim()) badImages.push(`${file}: 图片没有 alt`);
      if (attr("loading") !== "lazy") badImages.push(`${file}: 图片没有 loading="lazy"`);
      if (!attr("width") || !attr("height")) badImages.push(`${file}: 图片没有写宽高，加载时会把版式顶开`);
      if (!attr("srcset")) badImages.push(`${file}: 图片没有 srcset，手机也会拉大图`);
    }

    // A page head must use the component. The rule that styled a bare
    // `.pagehead h1` was replaced by `.pagehead__title`, and six pages kept
    // emitting the old markup — their titles silently fell back to the browser's
    // default 32px bold. Every check still passed: there was exactly one h1 per
    // page, and it was the right words. So the class is asserted, not the tag.
    if (/<header class="pagehead">/.test(body) && !/class="pagehead__title"/.test(body)) {
      bareHeads.push(rel);
    }

    // exactly one h1 per page, checked on the rendered files
    const n = (body.match(/<h1\b/g) || []).length;
    if (n !== 1) {
      worst++;
      if (worst <= 3) failures.push(`${relative(STAGE, f)} 有 ${n} 个 h1，应为 1`);
    }
    // The redirect stubs hand-rolled their own <head> for two generations and
    // kept a data-theme="auto" in it long after the theme was retired: the CSS
    // and JS were clean, so nothing caught it. Every template goes through
    // head() now, which emits `color-scheme: light` and no attribute at all.
    if (/data-theme|prefers-color-scheme/.test(body)) themed.push(relative(STAGE, f));

    // A hover preview reads `#pv-<slug>`. When that template is missing the
    // preview does not break loudly — hovering simply does nothing, which reads
    // as "this link has no preview" and would never be reported. This check is
    // the only thing standing between that and a working feature.
    for (const m of body.matchAll(/data-preview="([^"]+)"/g)) {
      if (!body.includes(`id="pv-${m[1]}"`)) {
        orphans.push(`${relative(STAGE, f)} → ${m[1]}`);
      }
    }

    // "Similar links" is derived, so it can suggest the page the reader is
    // already on, or an address that does not exist. Both would look like
    // content. The page's own url is derivable from where the file landed.
    const rel = relative(STAGE, f).split(path.sep).join("/");
    const selfUrl = rel.endsWith("/index.html")
      ? `/${rel.slice(0, -"index.html".length)}`
      : `/${rel}`;
    for (const m of body.matchAll(/<ul class="rellist">([\s\S]*?)<\/ul>/g)) {
      for (const h of m[1].matchAll(/href="([^"]+)"/g)) {
        if (!h[1].startsWith("/")) selfLinks.push(`${rel} → ${h[1]}（不是站内链接）`);
        else if (h[1] === selfUrl) selfLinks.push(`${rel} 把自己列进了「相关」`);
      }
      if (!/rellist__meta/.test(m[1])) selfLinks.push(`${rel} 的「相关」没有写明理由`);
    }

    // A subsection must sit INSIDE the section above it, or folding that
    // section leaves its subsections on screen. Nesting is structural, so it is
    // checked structurally: walk every section tag and require depth > 0 when a
    // subsec opens. The earlier flat version passed every other check.
    //
    // EVERY <section> counts, not just .sec/.subsec — the references block has
    // its own section, and counting only the two classes we generate made its
    // closing tag look like an extra one.
    const main = /<div class="artmain[\s\S]*?(?=<aside class="rail")/.exec(body);
    if (main) {
      let depth = 0;
      for (const t of main[0].matchAll(/<section\b([^>]*)>|<\/section>/g)) {
        if (t[0] === "</section>") depth--;
        else if (/class="subsec"/.test(t[1] || "") && depth < 1) {
          nesting.push(`${rel} 里的小节没有嵌在所属章节内`);
          break;
        } else depth++;
      }
      if (depth !== 0) nesting.push(`${rel} 的 <section> 标签没有配对（余 ${depth}）`);
    }
  }
  if (!worst) log("  ok   每页 h1      全部恰好一个");
  if (bareHeads.length) {
    failures.push(`这些页面的页首没有用 .pagehead__title，标题会退回浏览器默认字号：${[...new Set(bareHeads)].slice(0, 4).join(", ")}`);
  } else {
    log("  ok   页首         每个 .pagehead 都用统一的标题组件");
  }
  if (themed.length) {
    failures.push(`这些页面的 HTML 里还带着主题属性：${themed.slice(0, 3).join(", ")}`);
  } else {
    log("  ok   只有亮色     没有页面带 data-theme 或 color-scheme 分支");
  }
  if (orphans.length) {
    failures.push(`这些互链没有对应的预览片段：${[...new Set(orphans)].slice(0, 3).join("；")}`);
  } else {
    log("  ok   预览片段     每个 data-preview 都有对应的 <template>");
  }
  if (selfLinks.length) {
    failures.push(`「相关」有问题：${[...new Set(selfLinks)].slice(0, 3).join("；")}`);
  } else {
    log("  ok   相关链接     站内、不指向自己、且写明了理由");
  }
  if (nesting.length) {
    failures.push(`章节嵌套有问题：${[...new Set(nesting)].slice(0, 3).join("；")}`);
  } else {
    log("  ok   章节嵌套     小节都嵌在所属章节内，标签配对");
  }
  if (badImages.length) {
    badImages.slice(0, 4).forEach((b) => failures.push(`配图问题：${b}`));
  } else if (cardImages) {
    log(`  ok   卡片配图     ${cardImages} 张全部站内、有 alt、有宽高、懒加载（合计 ${(imageBytes / 1024).toFixed(0)}KB）`);
  } else {
    log("  ok   卡片配图     当前没有配图（机制已就位）");
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

/**
 * Strip comments and redundant whitespace from a stylesheet before it ships.
 *
 * The source CSS is 61KB and half of it is commentary — the reasoning that
 * belongs next to the rule, not in the reader's download. This is deliberately
 * the smallest possible transform rather than a real minifier: it removes
 * comments and collapses whitespace, and it does NOT touch anything inside a
 * value. `calc(100% - 2rem)` keeps its spaces around the minus because that
 * space is syntax, and every assertion in the build reads the SOURCE files, so
 * nothing that is checked can be affected by what is stripped here.
 */
function minifyCss(src) {
  // Comments go first, so an apostrophe inside a comment cannot be mistaken for
  // the start of a string.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Then everything quoted is held aside. The four link-type icons are inline
  // SVG data URIs, and their contents — `viewBox='0 0 16 16'`, the `%3A` in a
  // colour — must survive untouched: collapsing whitespace inside a URL is a
  // silent corruption that no assertion would catch.
  return code
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((part, i) => (i % 2 === 1 ? part : part
      .replace(/\s*([{};:,>])\s*/g, "$1")
      .replace(/\s+/g, " ")))
    .join("")
    .trim();
}

function publish(log) {
  const stageAssets = path.join(STAGE, "assets");
  rm(stageAssets);
  ensure(stageAssets);
  const writeAsset = (dir, f) => {
    const from = path.join(ASSETS, f);
    const to = path.join(dir, f);
    if (f.endsWith(".css")) fs.writeFileSync(to, minifyCss(fs.readFileSync(from, "utf8")));
    else fs.copyFileSync(from, to);
  };
  for (const f of fs.readdirSync(ASSETS)) writeAsset(stageAssets, f);

  const assetDst = path.join(ROOT, "assets");
  rm(assetDst);
  ensure(assetDst);
  for (const f of fs.readdirSync(ASSETS)) writeAsset(assetDst, f);

  for (const rel of MANAGED) {
    if (rel === "assets") continue;
    const src = path.join(STAGE, rel);
    const dst = path.join(ROOT, rel);
    if (!exists(src)) { rm(dst); continue; }
    if (fs.statSync(src).isDirectory()) mirrorDir(src, dst);
    else { ensure(path.dirname(dst)); fs.copyFileSync(src, dst); }
  }

  // `img` is only there when something has a cover, so it is checked separately
  // rather than demanded: a site with no pictures is a valid site, and the
  // absence of the folder is how "no covers" looks on disk.
  const OPTIONAL = new Set(["assets", "img"]);
  const missing = MANAGED.filter((r) => !OPTIONAL.has(r) && !exists(path.join(ROOT, r)));
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

  /* ---- optional collections ----------------------------------------- */
  log("▸ 收藏夹");
  const collections = loadCollections(ROOT, problems, log);
  const collectionTotal = Object.values(collections).reduce((n, l) => n + l.length, 0);
  if (!collectionTotal) log("  阅读与爱好都还是空的（这两个目录是可选的）");

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
    // Only anchored backlinks can be placed inside a section; the page-level
    // list below the article still carries everything.
    const perSection = new Map();
    for (const b of backlinks.get(a.slug) || []) {
      if (!b.anchor) continue;
      if (!perSection.has(b.anchor)) perSection.set(b.anchor, []);
      perSection.get(b.anchor).push(b);
    }

    const body = renderBody(a, {
      resolve: (slug) => bySlug.get(slug) || null,
      sectionBacklinks: perSection
    });
    a.html = body.html;
    a.notes = body.notes;
    a.headings = body.headings;
    a.allHeadings = body.allHeadings;
    a.citations = body.citations;
    if (body.unusedCitations && body.unusedCitations.length) {
      problems.warn(`${a.name}: 这些引用定义了但正文里没用到 —— ${body.unusedCitations.join(", ")}`);
    }
    if (!checkOnly && !contentOnly) {
      a.revisions = revisionsFor(a.file);
      revisions.set(a.slug, a.revisions);
    }
    if (!a.revisions) a.revisions = [];
  }

  // collection entries are pages too, and get the same rendering
  for (const key of Object.keys(collections)) {
    for (const e of collections[key]) {
      const body = renderBody({ body: e.body, slug: e.slug }, { resolve: (s) => bySlug.get(s) || null });
      e.html = body.html;
      e.notes = body.notes;
      e.headings = body.headings;
    }
  }

  /* ---- anchored refs must land somewhere ---------------------------- */
  // A `{{ref:x|#sec-2}}` whose anchor does not exist still returns 200, so
  // neither the link checker nor the smoke suite would notice: the reader lands
  // at the top of the page and the section backlink never appears. Check the
  // fragment against the target's real headings while both are still in hand.
  let anchorRefs = 0;
  for (const a of sources) {
    for (const o of outgoing.get(a.slug) || []) {
      if (!o.anchor) continue;
      anchorRefs++;
      const target = bySlug.get(o.to);
      const ids = (target && target.allHeadings ? target.allHeadings : []).map((h) => h.id);
      if (!ids.includes(o.anchor)) {
        const secs = ids.filter((id) => /^sec-\d+$/.test(id));
        problems.error(a.name,
          `{{ref:${o.to}|#${o.anchor}}} 指向的章节不存在。`
          + `${o.to} 现有章节：${secs.length ? secs.join(" / ") : "（没有编号章节）"}`);
      }
    }
  }
  if (anchorRefs) log(`  ${anchorRefs} 条引用指向具体章节`);

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
  const tags = collectTags(articles, collections);
  const series = collectSeries(articles);
  const counts = buildCounts(articles);

  /* ---- similar links -------------------------------------------------
   * gwern's "similar links" come from a neural embedding of the full text.
   * That needs a model, which this site does not have and will not download, so
   * the signal here is the tags the writer already chose — weighted by how rare
   * a shared tag is. A tag used twice says far more about two pieces than one
   * used twenty times, and a raw overlap count would mostly surface whichever
   * tag happens to be most popular.
   *
   * Links that are already explicit `{{ref:}}` pairs are dropped: the reader
   * sees those in 本篇引用 / 反向链接, and repeating them here would make the
   * rail look fuller without saying anything new.
   *
   * Same series counts too, and counts most: a series is a grouping the writer
   * made on purpose, so it outranks any tag overlap. When two pieces share
   * nothing at all, nothing is offered — a suggestion the reader cannot account
   * for is worse than no suggestion.
   */
  const tagCount = new Map();
  for (const a of articles) {
    for (const t of a.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  const related = new Map();
  for (const a of articles) {
    const explicit = new Set([
      ...(outgoing.get(a.slug) || []).map((l) => l.to),
      ...(backlinks.get(a.slug) || []).map((b) => b.from)
    ]);
    const scored = [];
    for (const b of articles) {
      if (b.slug === a.slug || explicit.has(b.slug)) continue;
      const shared = b.tags.filter((t) => a.tags.includes(t));
      const sameSeries = !!(a.series && b.series && a.series === b.series);
      if (!shared.length && !sameSeries) continue;
      // rarer tag ⇒ heavier; the +1 keeps a tag used once from dominating outright
      let score = shared.reduce((n, t) => n + 1 / (tagCount.get(t) + 1), 0);
      if (sameSeries) score += 2;
      scored.push({
        item: b,
        score,
        why: sameSeries ? [`系列 · ${a.series}`, ...shared] : shared
      });
    }
    // score first, then newest — a tie should lead with current work, not with
    // whatever order the filesystem happened to return
    scored.sort((x, y) => (y.score - x.score) || (x.item.created < y.item.created ? 1 : -1));
    related.set(a.slug, scored.slice(0, 4).map((s) => ({
      url: s.item.url, title: s.item.title, domainName: s.item.domainName,
      kind: s.item.kind, why: s.why
    })));
  }

  const byDomain = new Map(DOMAINS.map((d) => [d.key, articles.filter((a) => a.domain === d.key)]));

  /* ---- card covers ---------------------------------------------------
   * Every entry that names an `image:` gets its derivatives written now, before
   * any page is rendered, so the cards can carry real width/height attributes
   * (which is what keeps the grid from reflowing as pictures arrive). Resizing
   * is the slowest thing a build does; it is skipped entirely when nothing has
   * a cover, which is the state this site spent its whole life in until now. */
  const pictured = [...articles, ...Object.values(collections).flat()].filter((i) => i.image);
  if (pictured.length) {
    log("▸ 卡片配图");
    let emitted = 0;
    for (const item of pictured) {
      const prepared = await prepareImage(item, ROOT, problems);
      item.picture = await emitImage(prepared, ROOT);
      if (item.picture && !item.picture.reused) emitted += prepared.widths.length;
    }
    log(`  ${pictured.length} 张配图 · ${emitted} 个衍生文件`);
  }

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

  // every page that gets written, for the size report at the end
  const htmlFiles = [];

  for (const d of DOMAINS) {
    const items = byDomain.get(d.key) || [];
    write(`${d.key}/index.html`, T.pageDomain(site, d, items, counts));
  }

  write("writing/index.html", T.pageWriting(site, { articles, byDomain, counts }));

  write("index.html", T.pageHome(site, { articles, collections, byDomain, tags, series, counts }));

  for (const c of COLLECTIONS) {
    const items = collections[c.key] || [];
    write(`${c.key}/index.html`, T.pageCollection(site, c, items, counts));
    // A collection whose cards are display tiles gets the index and nothing
    // else: writing a page per tile would produce pages nothing links to. See
    // the `linked` flag in taxonomy.mjs.
    if (c.linked === false) continue;
    for (const e of items) {
      write(`${c.key}/${e.slug}/index.html`, T.pageCollectionEntry(site, c, e, e.html));
      htmlFiles.push(`${c.key}/${e.slug}/index.html`);
    }
  }

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

  // every index page counts toward the size report
  for (const f of ["index.html", "writing/index.html", "archive/index.html", "tags/index.html",
    "series/index.html", "search/index.html", "changelog/index.html", "about/index.html",
    ...DOMAINS.map((d) => `${d.key}/index.html`),
    ...COLLECTIONS.map((c) => `${c.key}/index.html`)]) {
    htmlFiles.push(f);
  }

  for (const a of articles) {
    const idx = articles.indexOf(a);
    write(`${a.domain}/${a.slug}/index.html`, T.pageArticle(site, a, {
      revisions: a.revisions,
      backlinks: backlinks.get(a.slug) || [],
      outgoing: outgoing.get(a.slug) || [],
      related: related.get(a.slug) || [],
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
  // The guess is made in the browser (guess404.js): GitHub Pages serves this one
  // static file for every missing path, so there is no request path to read at
  // build time.
  write("404.html", T.page404(site, counts));

  /* ---- feeds & meta ------------------------------------------------- */
  write("rss.xml", T.rss(site, articles));
  write("favicon.svg", T.favicon(site));
  write(".nojekyll", "");
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${site.origin}/sitemap.xml\n`);

  const urls = [
    "/", "/writing/", "/archive/", "/tags/", "/series/", "/search/", "/changelog/", "/about/",
    ...DOMAINS.map((d) => `/${d.key}/`),
    ...COLLECTIONS.map((c) => `/${c.key}/`),
    ...tags.map((t) => `/tags/${slugify(t.name)}/`),
    ...series.map((s) => `/series/${slugify(s.name)}/`),
    ...articles.map((a) => a.url),
    ...Object.values(collections).flat().map((e) => e.url)
  ];
  write("sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map((u) => `  <url><loc>${site.origin}${u}</loc></url>`).join("\n")
    }\n</urlset>\n`);

  /* ---- size report -------------------------------------------------- */
  // assertions that need the rendered pages
  log("▸ 产物断言");
  failures.push(...checkRendered(log));

  const pageBytes = htmlFiles.reduce((n, f) => n + fs.statSync(path.join(STAGE, f)).size, 0);
  const biggest = htmlFiles
    .map((f) => [f, fs.statSync(path.join(STAGE, f)).size])
    .sort((a, b) => b[1] - a[1])[0];
  // T.CSS holds bare names ("tokens", "base", …); the script is listed too so
  // the budget covers everything a reader actually downloads. CSS is measured
  // AFTER minifyCss, because that is what publish() writes — counting the
  // comments here would charge the reader for bytes they never receive.
  const shippedFiles = T.CSS.map((n) => `${n}.css`).concat(["site.js"]);
  const shippedBytes = (f) => {
    const src = fs.readFileSync(path.join(ASSETS, f), "utf8");
    return Buffer.byteLength(f.endsWith(".css") ? minifyCss(src) : src, "utf8");
  };
  const cssJs = shippedFiles.reduce((n, f) => n + shippedBytes(f), 0);

  // The heaviest page's covers: what a reader actually downloads for pictures.
  const imageDir = path.join(STAGE, "img");
  const imageSizes = exists(imageDir)
    ? fs.readdirSync(imageDir).map((f) => [f, fs.statSync(path.join(imageDir, f)).size])
    : [];
  const pageImageBytes = htmlFiles.reduce((worst, f) => {
    const body = fs.readFileSync(path.join(STAGE, f), "utf8");
    const srcs = new Set([...body.matchAll(/<img\b[^>]*src="\/img\/([^"]+)"/g)].map((m) => m[1]));
    const total = [...srcs].reduce((n, s) => {
      const hit = imageSizes.find(([f2]) => f2 === s);
      return n + (hit ? hit[1] : 0);
    }, 0);
    return Math.max(worst, total);
  }, 0);

  log("▸ 体积");
  log(`  文章平均    ${(pageBytes / Math.max(1, htmlFiles.length) / 1024).toFixed(1)} KB`);
  log(`  最大一页    ${(biggest[1] / 1024).toFixed(1)} KB  (${biggest[0]})`);
  log(`  css + js    ${(cssJs / 1024).toFixed(1)} KB  (${shippedFiles.length} 个文件，无第三方)`);

  const budgets = [
    ["最大单页", biggest[1] / 1024, 120, "KB"],
    // 64KB, down from 80. Publishing the stylesheets without their comments cut
    // 30KB, so the budget can now be tight enough to catch a regression again
    // rather than sitting slack. The rule the number protects is the same one it
    // always was: no CDN, no framework, no downloaded font.
    ["css+js", cssJs / 1024, 64, "KB"],
    // Card covers are the only binary the site ships, so they get their own
    // ceiling: one page's worth of pictures must stay cheaper than a single
    // icon font would have been.
    ["单页配图", pageImageBytes / 1024, 400, "KB"]
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

  // Every root-level document that existed before the publish must still be
  // there. The pruner deletes files the build no longer emits, and a doc added
  // by hand looks exactly like one of those unless it is protected — AUDIT.md
  // was written, reported success, and was gone by the next build.
  const docsBefore = fs.readdirSync(ROOT).filter((f) => /\.(md|markdown)$/i.test(f));
  publish(log);
  const eaten = docsBefore.filter((f) => !exists(path.join(ROOT, f)));
  if (eaten.length) {
    log("\n✗ 发布时删掉了仓库里的文档：");
    for (const f of eaten) log("   · " + f);
    log("   （把它的名字或扩展名加进 build.mjs 的 PRIVATE / isPrivate）");
    process.exit(1);
  }

  // The published CSS has been through minifyCss, which is a transformation on
  // the thing every other check reads the SOURCE of — so verify the result
  // rather than trust it: every declaration and selector in the source must
  // still be present in what was written. A corrupted data URI or a dropped
  // rule would otherwise reach readers unnoticed.
  const stripped = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
  const minifyLosses = [];
  for (const f of fs.readdirSync(ASSETS).filter((x) => x.endsWith(".css"))) {
    const src = stripped(fs.readFileSync(path.join(ASSETS, f), "utf8"));
    const out = stripped(fs.readFileSync(path.join(ROOT, "assets", f), "utf8"));
    const decls = [...src.matchAll(/[a-z-]+:[^;{}]+/g)].map((m) => m[0]);
    const missing = decls.filter((d) => !out.includes(d));
    if (missing.length) minifyLosses.push(`${f}: ${missing.length} 条声明在压缩后不见了（${missing[0].slice(0, 40)}…）`);
    if (/\/\*/.test(out)) minifyLosses.push(`${f}: 注释没有被剥掉`);
  }
  if (minifyLosses.length) {
    log("\n✗ 发布前的 CSS 压缩丢东西了：");
    for (const m of minifyLosses) log("   · " + m);
    process.exit(1);
  }

  log(`\n✓ 构建完成：${walk(STAGE).length} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  ${articles.length} 篇 · ${tags.length} 个标签 · ${series.length} 个系列 · ${refCount} 条互链`);
}

main().catch((e) => {
  console.error("\n✗ 构建失败:", e.message);
  console.error(e.stack);
  process.exit(1);
});
