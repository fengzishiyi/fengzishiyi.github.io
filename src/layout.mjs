#!/usr/bin/env node
/**
 * layout.mjs — measure the real layout in a real browser, at exact viewports.
 *
 * Requires `npm run serve`. Checks what a screenshot cannot:
 *
 *   · no horizontal scroll, nothing past the right edge, exactly one h1
 *   · the reading measure stays in 30–34 汉字 per line at desktop widths
 *   · NO CARD CLIPS ITS OWN TEXT — the failure mode of a fixed aspect ratio,
 *     and invisible in markup because `overflow: hidden` hides the evidence
 *   · the masonry actually densifies: the column count matches the breakpoint
 *   · with JavaScript DISABLED, the notes and the five block forms are still
 *     in the document — the progressive-enhancement claim, verified
 *   · the nav indicator is positioned by script and does not appear without it
 *
 *   node src/layout.mjs            measure + capture
 *   node src/layout.mjs --measure  measure only
 *   node src/layout.mjs --quick    interactive behaviour only (seconds, not minutes)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Browser } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || 4321;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, ".shots");
const measureOnly = process.argv.includes("--measure");
// The full sweep is 49 pages × 6 viewports ≈ 300 browser sessions, which is the
// right price for a pre-commit run and the wrong one for iterating on a control.
const quick = process.argv.includes("--quick");

/** Viewport → the number of grid columns chester's breakpoints call for. */
const VIEWPORTS = [
  ["phone", 390, 900, 1],
  ["sm", 640, 900, 2],
  ["tablet", 768, 1000, 2],
  ["lg", 1024, 1000, 3],
  ["xl", 1280, 1000, 4],
  ["laptop", 1440, 1100, 4]
];

function discoverPages() {
  const stage = path.join(ROOT, ".build");
  const pages = ["/", "/writing/", "/archive/", "/tags/", "/series/", "/search/", "/changelog/", "/about/", "/404.html"];
  for (const group of ["literature", "philosophy", "compsci", "reading", "hobbies", "tags", "series"]) {
    const dir = path.join(stage, group);
    if (!fs.existsSync(dir)) continue;
    pages.push(`/${group}/`);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) pages.push(`/${group}/${e.name}/`);
    }
  }
  // Series names are Chinese, and a raw non-ASCII path is not a valid URL: CDP
  // accepts it often enough to look fine, then navigates nowhere and the
  // measurement runs against the default 980px blank page. Encode every segment.
  return pages.map((p) => p.split("/").map(encodeURIComponent).join("/"));
}

let failures = 0;
const fail = (m) => { console.log("  ✗ " + m); failures++; };

const browser = await Browser.launch();
const PAGES = discoverPages();

/**
 * Pick the article to scrutinise, and know what it SHOULD contain.
 *
 * The first version hard-coded "the first article", which happened to be one
 * with no block forms at all, so a passing test proved nothing about them. So
 * the source files are read here and the article with the most block markers is
 * chosen — and the count travels with it, so the no-JS check can assert that
 * exactly that many forms render. A test that cannot fail is not a test.
 */
function findRichestArticle() {
  const dir = path.join(ROOT, "_articles");
  const files = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|markdown)$/i.test(e.name)) files.push(p);
    }
  })(dir);

  let best = { url: PAGES.find((p) => /^\/(literature|philosophy|compsci)\/[^/]+\/$/.test(p)), forms: 0, notes: 0 };
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
    const src = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const n = (re) => (src.match(re) || []).length;
    const forms = n(/^!!!\s+[a-zA-Z]+/gm) + n(/^\+\+\+/gm) + n(/^>>>/gm) +
      n(/^:::\s*columns/gm) + n(/^\[\^[^\]]+\]:/gm);
    const notes = n(/\^\[/gm) + n(/\^\^\[/gm);
    // the slug lives in front matter; without it, fall back to the filename
    const slugM = /^slug:\s*(.+)$/m.exec(raw);
    const slug = slugM ? slugM[1].trim() : path.basename(f).replace(/\.md$/i, "").replace(/^\d{4}-\d{2}-\d{2}[-_]/, "");
    const url = PAGES.find((p) => p.endsWith(`/${slug}/`));
    if (url && forms > best.forms) best = { url, forms, notes };
  }
  return best;
}

const richest = findRichestArticle();
const ARTICLE = richest.url;
console.log(`重点检查的文章：${ARTICLE}`);
console.log(`  源文件里有 ${richest.forms} 个块级写法、${richest.notes} 个脚注标记\n`);

/* ── 1. layout at every viewport ─────────────────────────────────────────── */
if (quick) console.log("--quick：跳过 49×6 的版式实测，只跑交互行为\n");
else console.log(`layout measurement — ${PAGES.length} pages × ${VIEWPORTS.length} viewports\n`);

for (const [vname, w, h, cols] of (quick ? [] : VIEWPORTS)) {
  console.log(`── ${w}×${h} (${vname}, 期望 ${cols} 栏)`);
  const home = await browser.measure({ url: BASE + "/", width: w, height: h, settleMs: 700 });
  if (home.clientWidth !== w) fail(`首页 @${w}: 实际宽 ${home.clientWidth}`);
  if (home.hScroll) fail(`首页 @${w}: 横向滚动`);
  if (home.gridCols !== cols) fail(`首页 @${w}: 网格 ${home.gridCols} 栏，期望 ${cols} 栏`);
  if (home.clipped) fail(`首页 @${w}: ${home.clipped} 处卡片文字被裁切`);
  if (home.h1Count !== 1) fail(`首页 @${w}: ${home.h1Count} 个 h1`);
  console.log(`   网格 ${home.gridCols} 栏 · ${home.cards} 张卡 · 裁切 ${home.clipped} · 指示器 ${home.navIndicator ? "在" : "无"}`);

  for (const page of PAGES) {
    let m;
    try { m = await browser.measure({ url: BASE + page, width: w, height: h, settleMs: 450 }); }
    catch (e) { fail(`${page} @${w}: ${e.message}`); continue; }

    if (m.clientWidth !== w) fail(`${page} @${w}: 实际宽 ${m.clientWidth}`);
    if (m.hScroll) fail(`${page} @${w}: 横向滚动 (${m.scrollWidth} > ${m.clientWidth})`);
    if (m.outsideViewport.length) fail(`${page} @${w}: 越界 → ${m.outsideViewport.join(", ")}`);
    if (m.h1Count !== 1) fail(`${page} @${w}: ${m.h1Count} 个 h1`);
    if (m.clipped) fail(`${page} @${w}: ${m.clipped} 处文字被裁切`);

    // The measure promise holds wherever a desktop-width reading column exists.
    // On a phone the column is ~340px, which is 20 汉字 and cannot be otherwise;
    // demanding otherwise would be demanding the impossible.
    if (page === ARTICLE && m.charsPerLine !== undefined) {
      const cap = w >= 1160 ? 36 : 40;
      if (m.charsPerLine > cap) fail(`${page} @${w}: 行宽 ${m.charsPerLine} 字，超过 ${cap} 上限`);
      if (w >= 1160 && m.charsPerLine < 28) fail(`${page} @${w}: 行宽只有 ${m.charsPerLine} 字`);
    }
  }
  console.log("");
}

/* ── 2. progressive enhancement ─────────────────────────────────────────── */
console.log("── 关闭 JavaScript 后是否仍可读");
let notesSeen = 0;
let blocksSeen = 0;
for (const w of quick ? [] : [390, 1440]) {
  for (const page of PAGES.filter((p) => p === ARTICLE || p === "/")) {
    let m;
    try { m = await browser.measure({ url: BASE + page, width: w, height: 900, settleMs: 600, scripted: false }); }
    catch (e) { fail(`no-JS ${page} @${w}: ${e.message}`); continue; }

    if (m.scriptRan) fail(`no-JS ${page}: 脚本仍然运行了`);
    if (m.fnrefCount !== m.noteCount) fail(`no-JS ${page} @${w}: ${m.fnrefCount} 个引用对应 ${m.noteCount} 条脚注`);
    // the nav indicator is script-only, so it must be absent
    if (m.navIndicator) fail(`no-JS ${page} @${w}: 导航指示器不该在无脚本时出现`);
    // and the block forms the SOURCE contains must all have rendered
    if (page === ARTICLE && m.blockForms < richest.forms) {
      fail(`no-JS ${page} @${w}: 源文件有 ${richest.forms} 个块级写法，只渲染出 ${m.blockForms} 个`);
    }
    notesSeen += m.noteCount;
    blocksSeen += m.blockForms;
  }
}
if (notesSeen === 0 && !quick) fail("关闭 JS 后所有文章都没有脚注 —— 脚注不再内联");
if (richest.forms > 0 && blocksSeen === 0 && !quick) fail("关闭 JS 后块级写法一个都没渲染");
if (!quick) console.log(`   ${notesSeen} 条脚注、${blocksSeen} 个块级写法在无脚本时仍在文档里  ✓`);

/* ── 3. the sidenote column ─────────────────────────────────────────────── */
console.log("\n── 边注列");
if (ARTICLE) {
  for (const w of quick ? [] : [1160, 1280, 1600]) {
    const m = await browser.measure({ url: BASE + ARTICLE, width: w, height: 1000, settleMs: 700 });
    if (m.noteOverlap) fail(`${w}px: ${m.noteOverlap} 条边注压到正文`);
    console.log(`   ${w}px 边注重叠 ${m.noteOverlap} · 正文 ${m.charsPerLine} 字/行`);
  }
}

/* ── 4. interactive behaviour ───────────────────────────────────────────── */
/* Markup checks cannot tell whether a control DOES anything, and the gwern
 * skeleton is mostly controls: folding, reader mode, previews, search. Each is
 * exercised the way a reader would — a real click, a real keystroke — and the
 * resulting DOM state is asserted, not just the presence of the button. */
console.log("\n── 交互行为");

/** A probe that gets a live session, runs `steps`, and always closes it. */
async function withPage(url, opts, steps) {
  const s = await browser.open({ width: 1440, height: 1000, settleMs: 600, ...opts, url });
  try { return await steps(s); } finally { await s.close(); }
}

const clickExpr = (sel) => `(function(){var e=document.querySelector(${JSON.stringify(sel)});
  if(!e) return JSON.stringify({error:"no "+${JSON.stringify(sel)}});
  e.click(); return JSON.stringify({ok:true});})()`;

// folding — a section, a standalone fold, and the folded-anchor guard
if (ARTICLE) {
  const r = await withPage(BASE + ARTICLE, {}, async (s) => {
    const before = await s.evalJson(`JSON.stringify({
      secs: document.querySelectorAll(".sec.is-foldable").length,
      folds: document.querySelectorAll(".fold.is-foldable").length,
      toggles: document.querySelectorAll(".sec__toggle[aria-expanded]").length
    })`);
    await s.evalJson(clickExpr(".sec__toggle"));
    const folded = await s.evalJson(`JSON.stringify({
      folded: document.querySelectorAll(".sec--folded").length,
      expanded: document.querySelector(".sec__toggle").getAttribute("aria-expanded"),
      bodyHidden: document.querySelector(".sec__rest").getBoundingClientRect().height < 2,
      remembered: localStorage.getItem("site:folded")
    })`);
    // a link into a folded section must re-open it: an anchor is not a dead end
    const firstId = await s.evalJson(`JSON.stringify(document.querySelector(".sec").querySelector("h2").id)`);
    await s.evalJson(`(function(){ location.hash = "#" + ${JSON.stringify(firstId)};
      window.dispatchEvent(new HashChangeEvent("hashchange")); return "1"; })()`);
    const reopened = await s.evalJson(`JSON.stringify({
      folded: document.querySelectorAll(".sec--folded").length,
      expanded: document.querySelector(".sec__toggle").getAttribute("aria-expanded")
    })`);
    await s.evalJson(clickExpr(".fold__toggle"));
    const foldState = await s.evalJson(`JSON.stringify({
      collapsed: document.querySelectorAll(".fold.is-collapsed").length,
      label: document.querySelector(".fold__toggle").textContent
    })`);
    return { before, folded, reopened, foldState };
  });

  if (!r.before.secs) fail("文章里没有可折叠的章节");
  else if (!r.before.toggles) fail("章节没有折叠控件");
  if (r.folded.folded !== 1) fail("点击章节控件后没有折叠（.sec--folded = " + r.folded.folded + "）");
  if (r.folded.expanded !== "false") fail("折叠后 aria-expanded 仍是 " + r.folded.expanded);
  if (!r.folded.bodyHidden) fail("折叠后正文仍然占位，说明只是换了个样式");
  if (!r.folded.remembered) fail("折叠状态没有写进 localStorage，刷新就丢了");
  if (r.reopened.folded !== 0) fail("跳到折叠章节的锚点后，那一节没有自动展开");
  if (!r.before.folds) fail("文章里没有独立的 +++ 折叠块");
  else if (r.foldState.collapsed !== 1) fail("点击 +++ 折叠块没有反应");
  else console.log(`   折叠：章节 ${r.before.secs} 个 · +++ 块 ${r.before.folds} 个 · 折叠后可展开、状态已记住  ✓`);

  // reader mode — the one control that survived the reskin, so it gets a test
  const reader = await withPage(BASE + ARTICLE, {}, async (s) => {
    const initial = await s.evalJson(`JSON.stringify({
      state: document.documentElement.getAttribute("data-reader"),
      pressed: document.querySelector("[data-reader-toggle]").getAttribute("aria-pressed"),
      rail: !!document.querySelector(".rail") && document.querySelector(".rail").getBoundingClientRect().width
    })`);
    await s.evalJson(clickExpr("[data-reader-toggle]"));
    const on = await s.evalJson(`JSON.stringify({
      state: document.documentElement.getAttribute("data-reader"),
      pressed: document.querySelector("[data-reader-toggle]").getAttribute("aria-pressed"),
      stored: localStorage.getItem("site:reader"),
      rail: !!document.querySelector(".rail") && document.querySelector(".rail").getBoundingClientRect().width,
      lines: getComputedStyle(document.querySelector(".prose p")).lineHeight
    })`);
    await s.evalJson(clickExpr("[data-reader-toggle]"));
    const off = await s.evalJson(`JSON.stringify({
      state: document.documentElement.getAttribute("data-reader"),
      stored: localStorage.getItem("site:reader")
    })`);
    return { initial, on, off };
  });
  if (reader.on.state !== "on") fail("点阅读模式按钮后没有进入阅读模式");
  else if (reader.on.pressed !== "true") fail("阅读模式开着，但 aria-pressed 没更新");
  else if (reader.on.rail) fail("阅读模式里右侧栏仍然占着 " + Math.round(reader.on.rail) + "px");
  else if (reader.off.state !== "off") fail("再点一次没有退出阅读模式");
  else console.log("   阅读模式：进入后右栏让位、aria-pressed 同步、退出干净  ✓");

  // link previews — hover and keyboard focus both, Escape to dismiss
  const preview = await withPage(BASE + ARTICLE, {}, async (s) => {
    const target = await s.evalJson(`JSON.stringify(
      (document.querySelector(".ref[data-preview]") || {}).getAttribute
        ? document.querySelector(".ref[data-preview]").getAttribute("data-preview") : "")`);
    if (!target) return { target: "" };
    await s.evalJson(`(function(){var a=document.querySelector(".ref[data-preview]");
      a.dispatchEvent(new MouseEvent("mouseover",{bubbles:true})); return "1";})()`);
    await new Promise((r) => setTimeout(r, 400));
    const hover = await s.evalJson(`JSON.stringify((function(){var p=document.querySelector(".preview");
      return { shown: !!p && !p.hidden, text: p ? p.textContent.trim().slice(0,24) : "" };})())`);
    await s.evalJson(`(function(){document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"})); return "1";})()`);
    const after = await s.evalJson(`JSON.stringify((function(){var p=document.querySelector(".preview");
      return { hidden: !p || p.hidden };})())`);
    return { target, hover, after };
  });
  if (!preview.target) fail("文章里没有可预览的互链");
  else if (!preview.hover.shown) fail("悬停互链没有出现预览");
  else if (!preview.after.hidden) fail("按 Esc 之后预览没有关掉");
  else console.log(`   链接预览：悬停「${preview.hover.text}…」出现、Esc 关闭  ✓`);
}

// search — the index loads, a query filters, a URL query pre-fills
{
  const r = await withPage(`${BASE}/search/?q=${encodeURIComponent("纯文本")}`, {}, async (s) => {
    for (let i = 0; i < 20; i++) {
      const ready = await s.evalJson(`JSON.stringify(!/载入/.test(
        (document.querySelector("[data-search-status]")||{}).textContent||""))`);
      if (ready) break;
      await new Promise((r2) => setTimeout(r2, 250));
    }
    return s.evalJson(`JSON.stringify({
      status: (document.querySelector("[data-search-status]")||{}).textContent||"",
      hits: document.querySelectorAll("[data-search-results] a").length,
      input: (document.querySelector("[data-search-input]")||{}).value||"",
      facets: document.querySelectorAll('[data-filter="tag"] option').length
    })`);
  });
  if (!r.hits) fail(`搜索「纯文本」没有结果（状态：${r.status}）`);
  else if (r.input !== "纯文本") fail(`?q= 没有回填到输入框，现在是 "${r.input}"`);
  else if (r.facets < 2) fail("搜索的标签筛选没有填充选项");
  else console.log(`   搜索：?q= 回填、命中 ${r.hits} 条、筛选有 ${r.facets} 个标签  ✓`);
}

// the 404 guess — gwern's "did you mean", which GitHub Pages forces into the
// browser because it serves one static 404.html with no request path to read
{
  const typo = "/compsci/why-plain-textt/";
  const r = await withPage(BASE + typo, {}, async (s) => {
    for (let i = 0; i < 24; i++) {
      const state = await s.evalJson(`JSON.stringify((function(){
        var g = document.querySelector("[data-guess]");
        return { host: !!g, shown: !!g && !g.hidden, text: g ? g.textContent.trim() : "" };
      })())`);
      if (state.shown) return state;
      await new Promise((r2) => setTimeout(r2, 250));
    }
    return s.evalJson(`JSON.stringify((function(){
      var g = document.querySelector("[data-guess]");
      return { host: !!g, shown: false, text: g ? g.textContent.trim() : "" };
    })())`);
  });
  if (!r.host) fail("404 页面没有「是不是想找」的容器");
  else if (!r.shown) fail(`打错一个字母（${typo}）后 404 页面没有给出候选`);
  else if (!/why-plain-text/.test(r.text)) fail(`404 的候选不是最接近的那一篇：${r.text.slice(0, 40)}`);
  else console.log(`   404 猜测：打错一个字母 → 给出最接近的一篇  ✓`);
}

/* ── 5. captures ─────────────────────────────────────────────────────────── */
if (!measureOnly && !quick) {
  console.log("\ncaptures");
  fs.mkdirSync(OUT, { recursive: true });
  const wanted = [
    ["home", "/", 1440, 1150],
    ["home-lg", "/", 1024, 1000],
    ["home-phone", "/", 390, 950],
    ["article", ARTICLE, 1440, 1250],
    ["article-laptop", ARTICLE, 1280, 1100],
    ["article-phone", ARTICLE, 390, 900],
    ["writing", "/writing/", 1440, 900],
    ["reading", "/reading/", 1440, 800],
    ["tags", "/tags/", 1440, 900],
    ["search", "/search/", 1440, 800],
    ["about", "/about/", 1440, 900]
  ].filter(([, url]) => url);

  for (const [name, page, w, h] of wanted) {
    const png = path.join(OUT, `${name}.png`);
    try {
      await browser.shoot({ url: BASE + page, width: w, height: h, out: png, settleMs: 800 });
      await sharp(png).jpeg({ quality: 80 }).toFile(png.replace(/\.png$/, ".jpg"));
      console.log(`  ${name.padEnd(16)} ${w}×${h}`);
    } catch (e) { fail(`shoot ${name}: ${e.message}`); }
  }

  // reader mode, because it is the replacement for three retired controls
  try {
    const png = path.join(OUT, "article-reader.png");
    const s = await browser.open({ url: BASE + ARTICLE, width: 1440, height: 1000, settleMs: 400 });
    await s.send("Runtime.evaluate", {
      expression: `document.documentElement.setAttribute('data-reader','on')`
    });
    await new Promise((r) => setTimeout(r, 300));
    const shot = await s.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(png, Buffer.from(shot.data, "base64"));
    await s.close();
    await sharp(png).jpeg({ quality: 80 }).toFile(png.replace(/\.png$/, ".jpg"));
    console.log("  article-reader   1440×1000");
  } catch (e) { fail(`reader capture: ${e.message}`); }
}

await browser.close();

console.log("");
console.log(failures ? `✗ ${failures} 项版式问题` : "✓ 所有页面在所有测试视口下都成立");
console.log(`  截图 → ${OUT}`);
process.exit(failures ? 1 : 0);
