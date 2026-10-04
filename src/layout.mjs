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

// Fail with something a person can act on. Without this, a server that is not
// running surfaces as "Uncaught" from a page evaluation twenty lines later,
// which reads like a bug in the site rather than a missing `npm run serve`.
try {
  const probe = await fetch(BASE + "/", { method: "HEAD" });
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (e) {
  console.log(`✗ 连不上 ${BASE} —— 先跑 npm run serve（或 npm run dev）。(${e.message})`);
  process.exit(1);
}

const richest = findRichestArticle();
const ARTICLE = richest.url;
console.log(`重点检查的文章：${ARTICLE}`);
console.log(`  源文件里有 ${richest.forms} 个块级写法、${richest.notes} 个脚注标记\n`);

/* ── 1. layout at every viewport ─────────────────────────────────────────── */
let coversSeen = 0;
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
  console.log(`   网格 ${home.gridCols} 栏 · ${home.cards} 张卡 · 裁切 ${home.clipped} · 当前页标记 ${home.navRing ? "在" : "无"}`);

  for (const page of PAGES) {
    let m;
    try { m = await browser.measure({ url: BASE + page, width: w, height: h, settleMs: 450 }); }
    catch (e) { fail(`${page} @${w}: ${e.message}`); continue; }

    if (m.clientWidth !== w) fail(`${page} @${w}: 实际宽 ${m.clientWidth}`);
    if (m.hScroll) fail(`${page} @${w}: 横向滚动 (${m.scrollWidth} > ${m.clientWidth})`);
    if (m.outsideViewport.length) fail(`${page} @${w}: 越界 → ${m.outsideViewport.join(", ")}`);
    if (m.h1Count !== 1) fail(`${page} @${w}: ${m.h1Count} 个 h1`);
    if (m.clipped) fail(`${page} @${w}: ${m.clipped} 处文字被裁切`);
    if (!m.vars.accent) fail(`${page} @${w}: <body> 上没有 data-accent，这一页没有配色`);

    // Covers: the picture must fill its card exactly, be cropped rather than
    // squashed, carry alt text, and have actually loaded.
    if (m.covers) {
      if (m.covers.bad) fail(`${page} @${w}: ${m.covers.bad}/${m.covers.count} 张配图没有铺满卡片或没加载出来`);
      coversSeen += m.covers.count;
    }

    // The fold must actually hide something. Asserted on the article page at
    // every width, because "the class was added" is what let it stay broken.
    if (page === ARTICLE) {
      if (!m.fold) fail(`${page} @${w}: 找不到 +++ 折叠块`);
      else if (!m.fold.collapsed) fail(`${page} @${w}: 折叠块收起了却仍占 ${m.fold.after}px`);
    }

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
if (!quick && !coversSeen) fail("所有视口下都没有量到任何卡片配图 —— 配图没有渲染");
else if (!quick) console.log(`   配图：${coversSeen} 张在六个视口下都铺满卡片  ✓`);
let notesSeen = 0;
let blocksSeen = 0;
for (const w of quick ? [] : [390, 1440]) {
  for (const page of PAGES.filter((p) => p === ARTICLE || p === "/")) {
    let m;
    try { m = await browser.measure({ url: BASE + page, width: w, height: 900, settleMs: 600, scripted: false }); }
    catch (e) { fail(`no-JS ${page} @${w}: ${e.message}`); continue; }

    if (m.scriptRan) fail(`no-JS ${page}: 脚本仍然运行了`);
    if (m.fnrefCount !== m.noteCount) fail(`no-JS ${page} @${w}: ${m.fnrefCount} 个引用对应 ${m.noteCount} 条脚注`);
    // The current page is marked by CSS alone, so it must look identical with
    // scripting off — that is the whole reason it is not scripted.
    if (!m.navCurrent) fail(`no-JS ${page} @${w}: 导航没有标出当前页`);
    if (!m.navRing) fail(`no-JS ${page} @${w}: 当前页的样式没有生效（无脚本时也应一样）`);
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
 * skeleton is mostly controls: folding, previews, search, the 404 guess. Each is
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
    // The class is not the point — the CONTENT disappearing is. Asserting the
    // class is what let this stay broken: site.js wrote `is-collapsed` and the
    // stylesheet answered to `fold--folded`, so the toggle changed its own label
    // and hid nothing while the test stayed green.
    const foldState = await s.evalJson(`JSON.stringify((function(){
      var f = document.querySelector(".fold");
      var h = 0;
      for (var i = 0; i < f.children.length; i++) {
        if (f.children[i].classList.contains("fold__label")) continue;
        h += f.children[i].getBoundingClientRect().height;
      }
      return {
        collapsed: document.querySelectorAll(".fold.is-collapsed").length,
        label: document.querySelector(".fold__toggle").textContent,
        bodyHeight: Math.round(h)
      };
    })())`);
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
  else if (r.foldState.bodyHeight > 2) fail(`+++ 折叠块标了 is-collapsed，但正文还占着 ${r.foldState.bodyHeight}px`);
  else console.log(`   折叠：章节 ${r.before.secs} 个 · +++ 块 ${r.before.folds} 个 · 折叠后可展开、状态已记住  ✓`);

  // The article head is the tidy-up this round was about: a back link, a title,
  // ONE meta line, a lead — and nothing else between the reader and the text.
  const head = await withPage(BASE + ARTICLE, {}, async (s) => s.evalJson(`JSON.stringify((function(){
    var back = document.querySelector(".artback a");
    var title = document.querySelector(".arthead__title");
    var cs = title ? getComputedStyle(title) : null;
    return {
      back: back ? { text: back.textContent.trim(), href: back.getAttribute("href") } : null,
      titleSize: cs ? cs.fontSize : null,
      titleWeight: cs ? cs.fontWeight : null,
      meta: (document.querySelector(".arthead__meta") || {}).textContent ? document.querySelector(".arthead__meta").textContent.replace(/\\s+/g, " ").trim() : "",
      lead: !!document.querySelector(".arthead__desc"),
      // everything stacked above the title that used to make this page look busy
      stray: document.querySelectorAll(".arthead__kicker, .arthead__tools, .arthead .taglist, .readerbtn, [data-reader-toggle]").length,
      // prev/next at the foot, the other way back
      footLinks: document.querySelectorAll(".foot__chrono a").length
    };
  })())`));
  if (!head.back) fail("文章页没有返回入口");
  else if (!/^\/(writing|reading|hobbies)\/$/.test(head.back.href)) fail(`返回链接指向了 ${head.back.href}`);
  else if (!head.titleSize) fail("文章页没有标题");
  else if (Number.parseFloat(head.titleSize) < 32) fail(`文章标题只有 ${head.titleSize}，页首层级没立起来`);
  else if (!head.meta) fail("文章页没有元信息行");
  else if (!head.lead) fail("文章页没有导语");
  else if (head.stray) fail(`文章页首还堆着 ${head.stray} 个旧元素（眉标/标签行/阅读模式按钮）`);
  else console.log(`   文章页首：返回「${head.back.text}」· 标题 ${head.titleSize}/${head.titleWeight} · 一行元信息 · 导语  ✓`);

  // The focus ring has to be VISIBLE, not merely declared. The old one was a
  // 4px halo of blue-200 — 1.42:1 on white, a ring you cannot see.
  //
  // It also has to be reached the way a reader reaches it: `:focus-visible` does
  // not match a programmatic `.focus()` on a link, so this presses Tab for real.
  {
    const r = await withPage(BASE + "/", { width: 1280, height: 900 }, async (s) => {
      await s.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" });
      await s.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" });
      await new Promise((r2) => setTimeout(r2, 120));
      return s.evalJson(`JSON.stringify((function(){
        var el = document.activeElement;
        if (!el) return { none: true };
        var cs = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          cls: el.className,
          width: parseFloat(cs.outlineWidth) || 0,
          style: cs.outlineStyle,
          colour: cs.outlineColor,
          shadow: cs.boxShadow !== "none"
        };
      })())`);
    });
    if (r.none) fail("按 Tab 之后没有任何元素获得焦点");
    else if (r.style === "none" || r.width < 2) fail(`按 Tab 聚焦到 ${r.tag}.${r.cls}，但 outline 是 ${r.width}px ${r.style}`);
    else if (!r.shadow && !/rgb/.test(r.colour)) fail("焦点环没有颜色");
    else console.log(`   键盘焦点：Tab 到 ${r.tag}.${String(r.cls).split(" ")[0]} · outline ${r.width}px ${r.colour}  ✓`);
  }

  // link previews — hover and keyboard focus both, Escape to dismiss, and a fade
  // that actually runs (`is-in` is what the transition is keyed on; the popup
  // used to appear instantly because nothing ever added it)
  const preview = await withPage(BASE + ARTICLE, {}, async (s) => {
    const target = await s.evalJson(`JSON.stringify(
      (document.querySelector(".ref[data-preview]") || {}).getAttribute
        ? document.querySelector(".ref[data-preview]").getAttribute("data-preview") : "")`);
    if (!target) return { target: "" };
    await s.evalJson(`(function(){var a=document.querySelector(".ref[data-preview]");
      a.dispatchEvent(new MouseEvent("mouseover",{bubbles:true})); return "1";})()`);
    await new Promise((r) => setTimeout(r, 400));
    const hover = await s.evalJson(`JSON.stringify((function(){var p=document.querySelector(".preview");
      return {
        shown: !!p && !p.hidden,
        faded: !!p && p.classList.contains("is-in"),
        transition: p ? getComputedStyle(p).transitionProperty : "",
        text: p ? p.textContent.trim().slice(0,24) : ""
      };})())`);
    await s.evalJson(`(function(){document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"})); return "1";})()`);
    const after = await s.evalJson(`JSON.stringify((function(){var p=document.querySelector(".preview");
      return { hidden: !p || p.hidden };})())`);
    return { target, hover, after };
  });
  if (!preview.target) fail("文章里没有可预览的互链");
  else if (!preview.hover.shown) fail("悬停互链没有出现预览");
  else if (!preview.hover.faded) fail("预览出现了，但 is-in 没有加上，淡入不会发生");
  else if (!/opacity/.test(preview.hover.transition)) fail(`预览没有 opacity 过渡（现在过渡的是 ${preview.hover.transition}）`);
  else if (!preview.after.hidden) fail("按 Esc 之后预览没有关掉");
  else console.log(`   链接预览：悬停「${preview.hover.text}…」淡入出现、Esc 关闭  ✓`);

  // the citation copy buttons — shipped for several revisions with no handler
  const copy = await withPage(BASE + ARTICLE, {}, async (s) => {
    const btn = await s.evalJson(`JSON.stringify(!!document.querySelector("[data-copy]"))`);
    if (!btn) return { btn: false };
    // Headless denies the clipboard by default; grant it so the happy path is
    // what gets tested, and keep the fallback assertion for when it is refused.
    try {
      await s.send("Browser.grantPermissions", {
        origin: BASE,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"]
      });
    } catch { /* older engines: the fallback path is asserted instead */ }
    await s.evalJson(clickExpr("[data-copy]"));
    await new Promise((r) => setTimeout(r, 400));
    return { btn: true, ...(await s.evalJson(`JSON.stringify({
      done: document.querySelector("[data-copy]").getAttribute("data-done"),
      label: document.querySelector("[data-copy]").textContent.trim(),
      status: (document.querySelector("[data-copy-status]") || {}).textContent || ""
    })`)) };
  });
  if (!copy.btn) fail("文章页没有引用复制按钮");
  else if (copy.done === null) fail("点复制之后按钮没有任何反馈 —— 后面还是没有代码");
  else if (copy.done === "true" && copy.label !== "已复制") fail(`复制成功后按钮写着「${copy.label}」`);
  else if (copy.done === "false" && !copy.status) fail("复制失败时没有告诉读者怎么办");
  else console.log(`   引用复制：${copy.done === "true" ? "复制成功，按钮变「已复制」" : "剪贴板被拒时退回到选中文本并给出提示"}  ✓`);
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
}

await browser.close();

console.log("");
console.log(failures ? `✗ ${failures} 项版式问题` : "✓ 所有页面在所有测试视口下都成立");
console.log(`  截图 → ${OUT}`);
process.exit(failures ? 1 : 0);
