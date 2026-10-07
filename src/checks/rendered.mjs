/**
 * rendered.mjs — assertions that can only run once the pages exist.
 *
 * These read the ARTEFACT, in `dist/`. An earlier version of this file
 * pattern-matched a variable name inside the template module, so renaming a local
 * variable failed the build while the output was perfectly correct — an assertion
 * coupled to how the code is written rather than to what it produces. Everything
 * here inspects the generated HTML instead.
 *
 * `log` is how the run reports what it saw, not only what it did not like: a
 * check that prints nothing when it passes cannot be distinguished from one that
 * never ran.
 */

import fs from "node:fs";
import path from "node:path";
import { exists, walk, relative } from "../lib/fsx.mjs";
import { DOMAINS, COLLECTIONS } from "../lib/taxonomy.mjs";

/** The index pages that must wear the shared header and a grid (or say they are
 *  empty), rather than the old per-domain blocks. */
function indexPages(dist) {
  return [
    "writing/index.html",
    ...DOMAINS.map((d) => `${d.key}/index.html`),
    ...COLLECTIONS.map((c) => `${c.key}/index.html`)
  ].filter((rel) => exists(path.join(dist, rel)));
}

export function checkRendered(dist, log) {
  const failures = [];
  const homePath = path.join(dist, "index.html");
  if (!exists(homePath)) return ["dist/index.html 不存在 —— 先运行 npm run build"];

  const home = fs.readFileSync(homePath, "utf8");

  // ---- cards must point inside the site --------------------------------
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
  // scan cannot run on into the footer's links; and each card is split on the next
  // card, so a window cannot span two siblings. Without both, this reports nesting
  // that is not there — it did, twice.
  const grid = /<div class="masonry">([\s\S]*?)<\/div>\s*<p class="home__more"/.exec(home);
  const cards = grid ? grid[1].split(/(?=<div class="cell )/).slice(1) : [];
  const nested = cards.filter((b) => /<a [^>]*class="card__link[^"]*"[^>]*>[\s\S]*?<a\b/.test(b));
  if (nested.length) {
    failures.push(`卡片里出现了嵌套的 <a>（${nested.length} 张），会导致浏览器重构 DOM 并破坏版式`);
  } else {
    log(`  ok   卡片结构      ${cards.length} 张均无嵌套 <a>`);
  }

  // ---- the grid must actually be a grid --------------------------------
  const cells = (home.match(/class="cell cell--(intro|wide|square)"/g) || []);
  const kinds = new Set(cells.map((c) => /cell--(\w+)/.exec(c)[1]));
  if (!cells.length) failures.push("首页没有 masonry 网格");
  else log(`  ok   网格          ${cells.length} 格 (${[...kinds].join(" / ")})`);
  if (!kinds.has("intro")) failures.push("首页缺少 intro 大卡");

  // ---- the section pages are grids too ---------------------------------
  // They used to be three labelled blocks with entry lists, which is what the
  // instruction "writing does not need to be forced into three groups, just
  // scatter it into cards" was about. Every one of them now wears the same header
  // and the same grid — or, when the collection behind it is empty, the sentence
  // that says so. An empty collection has no grid to show, and demanding one
  // would make a legitimately empty section into a build failure.
  const notGrid = [];
  for (const rel of indexPages(dist)) {
    const body = fs.readFileSync(path.join(dist, rel), "utf8");
    const hasGrid = /<div class="masonry">/.test(body);
    const hasEmpty = /<div class="masonry"><p class="masonry__empty">/.test(body) || /<p class="empty">/.test(body);
    if (!hasGrid && !hasEmpty) notGrid.push(`${rel} 既没有砖石网格也没有空态说明`);
    if (!/class="pagehead__title"/.test(body)) notGrid.push(`${rel} 没有页首大标题`);
    if (/class="secblock"/.test(body)) notGrid.push(`${rel} 还留着按领域分组的旧结构`);
  }
  if (notGrid.length) failures.push(`分区页不一致：${notGrid.slice(0, 3).join("；")}`);
  else log(`  ok   分区页        ${indexPages(dist).length} 个分区页都是网格 + 页首标题`);

  // ---- hobby cards are display tiles -----------------------------------
  // A card that looks clickable but is not is worse than one that plainly is not,
  // so this is checked in both directions: the hobby grid must have no card links,
  // and the reading grid must still have them.
  const hobbyPage = path.join(dist, "hobbies/index.html");
  if (exists(hobbyPage)) {
    const body = fs.readFileSync(hobbyPage, "utf8");
    // Scanned over `<main>`, not over the grid: the grid slice has to guess where
    // it ends, and a guess that missed reported zero tiles on a page that had one.
    // The nav and footer are outside `<main>`, so no link of theirs leaks in.
    const main = /<main\b[^>]*>([\s\S]*)<\/main>/.exec(body);
    const inside = main ? main[1] : body;
    const links = (inside.match(/<a\b/g) || []).length;
    const arrows = (inside.match(/class="card__arrow"/g) || []).length;
    // `card--display` is added to whichever drawing the tile uses, so photo tiles
    // count too — the first version matched only the plain-text class string and
    // reported zero tiles on a page that had one.
    const tiles = (inside.match(/card--display/g) || []).length;
    if (links) failures.push(`爱好卡片里出现了 ${links} 个链接 —— 它们是只展示的卡片`);
    else if (arrows) failures.push(`爱好卡片里出现了 ${arrows} 个 ↗ —— 没有链接就不该有箭头`);
    else log(`  ok   爱好卡片      ${tiles} 张只展示：无链接、无箭头`);
  }

  // ---- and they have no pages of their own -----------------------------
  const strayHobbyPages = walk(dist).filter((f) => /[\\/]hobbies[\\/][^\\/]+[\\/]index\.html$/.test(f));
  if (strayHobbyPages.length) {
    failures.push(`爱好条目不该有自己的页面：${strayHobbyPages.slice(0, 2).map((f) => relative(dist, f)).join(", ")}`);
  } else {
    log("  ok   爱好条目     没有生成页面，与只展示的卡片一致");
  }

  // ---- every page, one at a time ---------------------------------------
  let worst = 0;
  const themed = [];
  const orphans = [];
  const selfLinks = [];
  const nesting = [];
  const bareHeads = [];
  const badImages = [];
  let cardImages = 0;
  let imageBytes = 0;

  for (const f of walk(dist).filter((x) => x.endsWith(".html"))) {
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
      const file = relative(dist, f);
      if (!src.startsWith("/img/")) badImages.push(`${file}: 图片不是站内的（${src.slice(0, 40)}）`);
      else {
        const onDisk = path.join(dist, src.replace(/^\//, ""));
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
      bareHeads.push(relative(dist, f));
    }

    // exactly one h1 per page
    const n = (body.match(/<h1\b/g) || []).length;
    if (n !== 1) {
      worst++;
      if (worst <= 3) failures.push(`${relative(dist, f)} 有 ${n} 个 h1，应为 1`);
    }

    // The redirect stubs hand-rolled their own <head> for two generations and kept
    // a data-theme="auto" in it long after the theme was retired. Every page goes
    // through the shell now, which emits `color-scheme: light` and no attribute.
    if (/data-theme|prefers-color-scheme/.test(body)) themed.push(relative(dist, f));

    // A hover preview reads `#pv-<slug>`. When that template is missing the
    // preview does not break loudly — hovering simply does nothing, which reads as
    // "this link has no preview" and would never be reported.
    for (const m of body.matchAll(/data-preview="([^"]+)"/g)) {
      if (!body.includes(`id="pv-${m[1]}"`)) orphans.push(`${relative(dist, f)} → ${m[1]}`);
    }

    // "Similar links" is derived, so it can suggest the page the reader is already
    // on, or an address that does not exist.
    const rel = relative(dist, f);
    const selfUrl = rel.endsWith("/index.html") ? `/${rel.slice(0, -"index.html".length)}` : `/${rel}`;
    for (const m of body.matchAll(/<ul class="rellist">([\s\S]*?)<\/ul>/g)) {
      for (const h of m[1].matchAll(/href="([^"]+)"/g)) {
        if (!h[1].startsWith("/")) selfLinks.push(`${rel} → ${h[1]}（不是站内链接）`);
        else if (h[1] === selfUrl) selfLinks.push(`${rel} 把自己列进了「相关」`);
      }
      if (!/rellist__meta/.test(m[1])) selfLinks.push(`${rel} 的「相关」没有写明理由`);
    }

    // A subsection must sit INSIDE the section above it, or folding that section
    // leaves its subsections on screen. Every <section> counts, not just
    // .sec/.subsec — the references block has its own section.
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
  if (bareHeads.length) failures.push(`这些页面的页首没有用 .pagehead__title：${[...new Set(bareHeads)].slice(0, 4).join(", ")}`);
  else log("  ok   页首         每个 .pagehead 都用统一的标题组件");
  if (themed.length) failures.push(`这些页面的 HTML 里还带着主题属性：${themed.slice(0, 3).join(", ")}`);
  else log("  ok   只有亮色     没有页面带 data-theme 或 color-scheme 分支");
  if (orphans.length) failures.push(`这些互链没有对应的预览片段：${[...new Set(orphans)].slice(0, 3).join("；")}`);
  else log("  ok   预览片段     每个 data-preview 都有对应的 <template>");
  if (selfLinks.length) failures.push(`「相关」有问题：${[...new Set(selfLinks)].slice(0, 3).join("；")}`);
  else log("  ok   相关链接     站内、不指向自己、且写明了理由");
  if (nesting.length) failures.push(`章节嵌套有问题：${[...new Set(nesting)].slice(0, 3).join("；")}`);
  else log("  ok   章节嵌套     小节都嵌在所属章节内，标签配对");
  if (badImages.length) badImages.slice(0, 4).forEach((b) => failures.push(`配图问题：${b}`));
  else if (cardImages) log(`  ok   卡片配图     ${cardImages} 张全部站内、有 alt、有宽高、懒加载（合计 ${(imageBytes / 1024).toFixed(0)}KB）`);
  else log("  ok   卡片配图     当前没有配图（机制已就位）");

  return failures;
}
