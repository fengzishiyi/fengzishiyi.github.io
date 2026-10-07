/**
 * design.mjs — the design contract, as checks.
 *
 * Read from the SOURCES, not the artefacts: the whole design is a handful of
 * numbers in tokens.css and a set of rules about which colour may be used where,
 * and a quiet edit to any of them is a design change. Measuring them on the
 * source is the only way to say which number moved.
 *
 * The previous revision of this file asserted a MONOCHROME system — no shadows,
 * no rounded corners, no gradients, one grayscale palette. chester.how is the
 * opposite: rounded cards, three shadow levels, and colour used as tag
 * decoration. Those assertions are gone, and what replaces them is what matters
 * about this design instead:
 *
 *   · the measured type ramp (weight 300, negative tracking, 16/26 body)
 *   · the light-only commitment — a dark palette must NOT exist
 *   · the card grid stays a grid: every card links inside the site
 *   · the content promises (Chinese measure, inline notes, no third parties)
 */

import fs from "node:fs";
import path from "node:path";
import { CSS, NAV } from "../lib/site.mjs";
import { hexFrom, rgbaFrom, flatten, contrast } from "../lib/colour.mjs";
import { ACCENTS } from "../lib/text.mjs";
import { walk } from "../lib/fsx.mjs";

/** Every hand-written source file that decides how the site looks or behaves.
 *  The evidence for "this rule has a writer" has to be searched for in all of
 *  them, not just the script. */
function sourceBundle(root) {
  const dirs = ["src/lib", "src/components", "src/layouts", "src/pages", "src/scripts"];
  const files = dirs.flatMap((d) => walk(path.join(root, d)));
  return files
    .filter((f) => /\.(mjs|js|astro|ts)$/.test(f))
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");
}

export function checkDesign(root, log) {
  const ASSETS = path.join(root, "src", "assets");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const forScreen = (s) => s.replace(/@media\s+print\s*\{[\s\S]*?\n\}/g, "");

  const css = forScreen(strip(CSS.map((n) => fs.readFileSync(path.join(ASSETS, `${n}.css`), "utf8")).join("\n")));
  const tokens = strip(fs.readFileSync(path.join(ASSETS, "tokens.css"), "utf8"));
  const js = walk(path.join(root, "src", "scripts"))
    .map((f) => strip(fs.readFileSync(f, "utf8"))).join("\n");
  const sources = sourceBundle(root);
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
  // Read out of the stylesheet, because the whole design is these numbers.
  // Values are normalised to px (1rem = 16px) so the comparison does not depend
  // on the unit chosen.
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
  const h1 = rampPx.get("--fs-h1"), h2 = rampPx.get("--fs-h2"), h3 = rampPx.get("--fs-h3");
  if (h1 && h2 && h3) {
    const ranked = h1 > h2 && h2 > h3;
    log(`  ${ranked ? "ok  " : "FAIL"} 标题层级       H1 ${h1} > H2 ${h2} > H3 ${h3}`);
    if (!ranked) failures.push(`标题层级乱了：H1 ${h1} / H2 ${h2} / H3 ${h3}，必须逐级递减`);
  }

  // ---- every referenced custom property must exist ---------------------
  // Same failure mode as above, caught in general: an undefined custom property
  // makes the whole declaration invalid, and the element quietly inherits.
  const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  // Two legitimate exceptions, both set on the element at runtime rather than in
  // a stylesheet: the sidenote offset the script computes, and the entrance index
  // the card component writes per cell.
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
  for (const block of css.match(/(?:^|[\s,])(?:h1|h2|h3|h4)[^{]*\{[^}]*\}/g) || []) {
    const w = /font-weight:\s*(\d+)/.exec(block);
    if (w && w[1] !== "300") failures.push(`标题字重变成了 ${w[1]} —— chester 的排版是 300`);
  }

  // ---- no third-party anything -----------------------------------------
  const thirdParty = /https?:\/\/(?!fengzishiyi\.github\.io)[^\s"'<>)]+\.(?:js|css|woff2?|ttf)/gi;
  const external = (css.match(thirdParty) || []).concat(js.match(thirdParty) || []);
  if (external.length) failures.push(`引用了外部脚本/字体：${[...new Set(external)].slice(0, 3).join(", ")}`);
  if (/@import\s+url\(/i.test(css)) failures.push("CSS 里出现了 @import url()，会引入站外请求");

  // ---- progressive enhancement -----------------------------------------
  // The block forms are emitted by the text pass, so the evidence is that the
  // markup for each still exists in the sources that write it.
  if (!/<aside class="note"/.test(sources)) {
    failures.push("脚注不再是内联 <aside>，关掉 JS 后边注会丢失");
  }
  for (const marker of ['class="admon', 'class="fold', 'class="epigraph', 'class="columns']) {
    if (!sources.includes(marker)) failures.push(`标记不见了：${marker}（关掉 JS 后应仍然可见）`);
  }
  if (!/prefers-reduced-motion/.test(css)) failures.push("没有 prefers-reduced-motion 回退");

  // ---- 中文行宽：30–34 字 ----------------------------------------------
  // Read in `rem`, because rem is the body size wherever the token is used and
  // one rem is therefore one 汉字.
  const measure = /--measure:\s*([\d.]+)rem/.exec(css);
  if (!measure) {
    failures.push("--measure 未定义（或不再是 rem），无法校验中文行宽");
  } else {
    const perLine = parseFloat(measure[1]);
    const ok = perLine >= 29 && perLine <= 35;
    log(`  ${ok ? "ok  " : "FAIL"} 正文行宽 ${perLine.toFixed(1)} 字 (目标 30–34)`);
    if (!ok) failures.push(`正文行宽是 ${perLine.toFixed(1)} 字，超出 30–34 的目标区间`);
  }
  // `ch` is the "0" glyph's width and says nothing about a full-width 汉字, so no
  // text width on this site may be expressed in it.
  const chWidths = [...css.matchAll(/(?:max-)?width:\s*[\d.]+ch/g)].map((m) => m[0]);
  if (chWidths.length) {
    failures.push(`文字宽度又用 ch 来写了：${chWidths.slice(0, 3).join(", ")}（中文该用 rem）`);
  } else {
    log("  ok   宽度单位     没有用 ch 限宽（中文用 rem）");
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
  const chipNames = [...ACCENTS, "neutral"];
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
  if (chipFailures.length) failures.push(`标签配色对比度不足：${chipFailures.slice(0, 4).join(", ")}`);
  else log(`  ok   标签配色      ${chipNames.length} 色 × 2 底色 = ${chipNames.length * 2} 组全部 ≥4.5`);

  // ---- decoration stays decoration -------------------------------------
  // `--ink-faint` measures 3.45:1 — fine for a glyph, not for text. Rather than
  // leave that as a note in a comment, the allowed selectors are listed and
  // anything else using it fails.
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
  // The bug this exists for: the script toggled `is-collapsed` on a fold while
  // the stylesheet answered to `fold--folded`, so the control flipped its own
  // label and hid nothing. Same shape as `.reveal`/`is-shown`, which had a script
  // and no CSS at all. Neither was an error anywhere — a class name is a string,
  // and nothing checks strings. So: every class the script writes must be a
  // selector somewhere, and every `data-` attribute the stylesheet branches on
  // must have a writer.
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

  const dataAttrs = new Set([...css.matchAll(/\[(data-[a-z-]+)/g)].map((m) => m[1]));
  const unwritten = [...dataAttrs].filter((a) => !sources.includes(a) && !js.includes(a));
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
  // They are now spelled `.card--photo` / `.card--scrim`, and the list below keeps
  // the OLD names gone so a half-rename cannot leave two spellings of the same
  // component in the stylesheet.
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
  const navTexts = NAV.map((n) => n.text);
  if (navTexts.join("|") !== "首页|写作|阅读|爱好|标签|关于") {
    failures.push(`导航标签变成了 ${navTexts.join(" / ")}`);
  } else {
    log(`  ok   导航标签  ${navTexts.join(" · ")}`);
  }
  if (navTexts.includes("项目")) failures.push("导航里又出现了「项目」—— 本轮明确要去掉");

  return failures;
}
