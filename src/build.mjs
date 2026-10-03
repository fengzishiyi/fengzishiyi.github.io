#!/usr/bin/env node
/**
 * build.mjs — the whole site generator, one file, no framework.
 *
 *   _images/*            originals (never published, git-ignored)
 *   _articles/*.md       write-ups, one file per article
 *        │
 *        ├─ sharp ────────→ images/derived/*.{webp,jpg}  +  lqip
 *        ├─ marked ───────→ rendered prose
 *        └─ templates ────→ index.html · articles/ · 404.html
 *
 * Everything is staged in .build/ and only swapped into the published tree
 * once the whole run has succeeded, so a failed build can never leave half a
 * site behind. The final step re-reads its own CSS and asserts that none of
 * the editorial style rules were broken.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { marked } from "marked";

/* ══════════════════════════════════════════════════════════════════════ */
/* config                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const SRC_IMAGES = path.join(ROOT, "_images");
const SRC_ARTICLES = path.join(ROOT, "_articles");
const ASSETS = path.join(HERE, "assets");

const STAGE = path.join(ROOT, ".build");

/** Published paths, wiped and re-emitted on every build. Every directory the
 *  pages are written into must appear here, or it is built and then silently
 *  left behind in the staging tree — which is exactly how /about/ once 404'd.
 *  These are mirrored from .build/, so everything here must be written there
 *  first; nothing is special-cased at publish time. */
const MANAGED = [
  "images", "assets", "articles", "about",
  "index.html", "404.html", "sitemap.xml", "robots.txt", "favicon.svg", ".nojekyll"
];

const SITE = {
  origin: "https://fengzishiyi.github.io",
  title: "枫子十一",
  desc: "一个私人文章与图片档案：杂志式排版的长文，和一面一直在流动的图墙。",
  lang: "zh-Hans",
  author: "fengzishiyi"
};

const IMG = {
  sizes: [420, 840],       // 1x / 2x long-edge caps
  webp: { quality: 82, effort: 5 },
  jpg: { quality: 82, progressive: true, mozjpeg: true },
  lqip: { w: 24, quality: 40 }
};

/** Display band height per ratio class, mirroring tokens.css. Used to pick a
 *  derivative that is at least 1.15× the largest on-screen size. */
const CLASS_H = { xxl: 400, xl: 330, lg: 280, md: 240, sm: 180 };
const CLASS_W = { xxl: 196, xl: 260, lg: 280, md: 390, sm: 400 };

/** Drift speed for the wall, in CSS pixels per second. */
const DRIFT_PPS = 40;
const DRIFT_MIN_S = 55;
const DRIFT_MAX_S = 260;
/** Still mode keeps the animation alive but ~28 min long, so frames tile the
 *  full width instead of crowding the left edge. */
const STILL_S = 1700;

/* ══════════════════════════════════════════════════════════════════════ */
/* small helpers                                                         */
/* ══════════════════════════════════════════════════════════════════════ */

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const ensure = (p) => fs.mkdirSync(p, { recursive: true });
const exists = (p) => fs.existsSync(p);
const round = (n, d = 2) => Number(n.toFixed(d));

function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function write(rel, contents) {
  const p = path.join(STAGE, rel);
  ensure(path.dirname(p));
  fs.writeFileSync(p, contents);
  return p;
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".tif", ".tiff"]);

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "") || "image";
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 1. ratio classes                                                      */
/* ══════════════════════════════════════════════════════════════════════ */

/** ratio = width / height. Mirrors the bands documented in the plan. */
function ratioClass(ratio) {
  if (ratio < 0.6) return "xxl";
  if (ratio < 0.85) return "xl";
  if (ratio < 1.15) return "lg";
  if (ratio < 1.85) return "md";
  return "sm";
}

/** Long-edge cap → the resize instruction that puts the long edge at `cap`. */
function resizeFor(w, h, cap) {
  return w >= h ? { width: cap } : { height: cap };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 2. image pipeline                                                     */
/* ══════════════════════════════════════════════════════════════════════ */

function loadMetadata() {
  const p = path.join(SRC_IMAGES, "metadata.json");
  if (!exists(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`_images/metadata.json is not valid JSON: ${e.message}`);
  }
}

function loadRowsConfig() {
  const p = path.join(SRC_IMAGES, "rows.json");
  if (!exists(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`_images/rows.json is not valid JSON: ${e.message}`);
  }
}

async function buildImages(log) {
  const files = walk(SRC_IMAGES).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
  if (!files.length) throw new Error(`no images found in ${SRC_IMAGES}`);

  const meta = loadMetadata();
  const pages = {};
  const orderAll = [];
  const extraOrphans = new Set(Object.keys(meta));

  for (const file of files) {
    const base = path.basename(file);
    const stem = base.replace(/\.[a-z0-9]+$/i, "");
    const slug = slugify(stem);
    if (pages[slug]) {
      throw new Error(`two source files produce the slug "${slug}" — rename one (${base})`);
    }
    extraOrphans.delete(slug);
    extraOrphans.delete(stem);

    const original = sharp(file);
    const md = await original.metadata();
    if (!md.width || !md.height) throw new Error(`cannot read dimensions of ${base}`);

    const w = md.width;
    const h = md.height;
    const ratio = round(w / h, 4);
    const cls = ratioClass(ratio);
    // long-edge caps: 1x a touch above the on-screen size, 2x for retina
    const longest = CLASS_H[cls] * Math.max(1, ratio);
    const cap1x = Math.min(1400, Math.max(320, Math.round((longest * 1.15) / 40) * 40));
    const cap2x = Math.min(1600, Math.max(cap1x + 40, Math.round((longest * 2.2) / 40) * 40));

    const outBase = `images/derived/${slug}`;
    const dir = path.join(STAGE, path.dirname(outBase));
    ensure(dir);

    const emit = async (cap, ext) => {
      const r = resizeFor(w, h, cap);
      let pipe = sharp(file).rotate().resize({ ...r, withoutEnlargement: true });
      pipe = ext === "webp" ? pipe.webp(IMG.webp) : pipe.jpeg(IMG.jpg);
      const p = path.join(STAGE, `${outBase}-${cap === cap1x ? "1x" : "2x"}.${ext}`);
      await pipe.toFile(p);
      const { width, height } = await sharp(p).metadata();
      return { width, height, bytes: fs.statSync(p).size };
    };

    const d1x = await emit(cap1x, "webp");
    await emit(cap1x, "jpg");
    const d2x = await emit(cap2x, "webp");
    await emit(cap2x, "jpg");

    // LQIP: a 24px blur, kept as its own file so the HTML stays small
    await sharp(file).rotate().resize({ width: IMG.lqip.w })
      .webp({ quality: IMG.lqip.quality })
      .toFile(path.join(STAGE, `${outBase}-lqip.webp`));

    const m = meta[slug] || meta[stem] || {};
    pages[slug] = {
      slug,
      source: path.relative(ROOT, file).split(path.sep).join("/"),
      original: { width: w, height: h, bytes: fs.statSync(file).size, format: md.format },
      width: w,
      height: h,
      ratio,
      class: cls,
      title: m.title || "",
      creator: m.creator || "",
      year: m.year || "",
      medium: m.medium || "",
      source_url: m.source || "",
      source_label: m.source_label || "来源",
      alt: m.alt || m.title || "",
      lqip: `/images/derived/${slug}-lqip.webp`,
      d1x: `/images/derived/${slug}-1x.webp`,
      d1xJpg: `/images/derived/${slug}-1x.jpg`,
      d2x: `/images/derived/${slug}-2x.webp`,
      d2xJpg: `/images/derived/${slug}-2x.jpg`,
      bytes: [1, 2].flatMap((n) =>
        ["webp", "jpg"].map((f) => fs.statSync(path.join(STAGE, `${outBase}-${n}x.${f}`)).size))
    };
    orderAll.push(slug);
    log(`  ${base}  ${w}×${h}  r=${ratio}  ${cls}  →  1x ${d1x.width}×${d1x.height} / 2x ${d2x.width}×${d2x.height}`);
  }

  if (extraOrphans.size) {
    log(`  ! metadata.json mentions unknown slugs: ${[...extraOrphans].join(", ")}`);
  }

  return { pages, orderAll };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 3. row layout                                                         */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * Curate the wall into a few rows of ~6 frames, mixing ratio bands so the
 * wall never reads as a broken grid. A configured _images/rows.json wins;
 * otherwise images are dealt out so no row repeats a band twice in a row and
 * the three 2:3 frames of one set stay adjacent.
 */
function computeRows(pages, orderAll) {
  const configured = loadRowsConfig();
  if (Array.isArray(configured) && configured.length) {
    const seen = new Set();
    return configured.map((row, i) => {
      const slugs = (row.slugs || row).filter((s) => {
        if (!pages[s]) {
          console.warn(`  ! rows.json references unknown slug "${s}" — skipped`);
          return false;
        }
        return true;
      });
      slugs.forEach((s) => seen.add(s));
      return { index: i, direction: row.direction || (i % 2 ? "reverse" : "normal"), slugs };
    }).map((row, i) => {
      if (row.slugs.length) return row;
      const fill = orderAll.filter((s) => !seen.has(s));
      return { ...row, slugs: fill.slice(0, 6).map((s) => (seen.add(s), s)) };
    });
  }

  // deterministic curation: sort wide→tall, deal in a rotating order so each
  // band is distributed rather than clumped into one row. Two rows of seven
  // keeps each pass wide enough that two passes cover a 2560px viewport.
  const byClass = { xxl: [], xl: [], lg: [], md: [], sm: [] };
  for (const slug of orderAll) byClass[pages[slug].class].push(slug);

  const ROWS = 2;
  const buckets = Object.keys(byClass).filter((k) => byClass[k].length);
  const rows = Array.from({ length: ROWS }, () => []);
  let r = 0;
  for (const band of buckets) {
    for (const slug of byClass[band]) {
      rows[r % ROWS].push(slug);
      r += 1;
    }
  }
  return rows.map((slugs, i) => ({
    index: i,
    direction: i % 2 ? "reverse" : "normal",
    slugs
  })).filter((row) => row.slugs.length);
}

/**
 * How many times the tile sequence repeats per pass, how far the track travels
 * per lap, and that each repeats exactly — the seamless-loop maths.
 *
 * Worked out at the limit rather than by intuition, because the naive version
 * is subtly wrong. With `copies` passes travelled and `copies + 1` emitted, the
 * track is `(copies + 1)·pass` wide and ends a lap with its right edge at
 *
 *     (copies + 1)·pass − copies·pass  =  pass
 *
 * — i.e. exactly one pass from the origin, independent of `copies`. A hole can
 * only be prevented if that is at least the viewport, so the real requirement
 * is on the PASS, not on the number of copies:
 *
 *     pass ≥ viewport          ← a hard floor
 *
 * Since one pass is a single pass over the tiles, a small collection can never
 * satisfy it. The fix is to repeat the whole SEQUENCE inside one pass until it
 * is wide enough. Only then do copies do their job, which is simply to make the
 * lap longer: `copies = 1` is already enough to backfill the wrap, because the
 * emitting of `copies + 1` passes is what provides the spare.
 *
 * Getting this wrong walks the track off its own end and opens a hole that
 * sweeps slowly across mid-screen — the classic broken marquee.
 *
 * @returns {{sequenceRepeats:number, passWidth:number, sequenceWidth:number,
 *            copies:number, emitted:number, travel:number, track:number,
 *            reach:number, covered:boolean}}
 */
function wallProject(sequenceWidth, gutter, viewport) {
  // 1. widen one pass by repeating the sequence until it can cover the target
  const sequenceRepeats = Math.max(1, Math.ceil(viewport / sequenceWidth));
  const passWidth = sequenceRepeats * sequenceWidth;

  // 2. one lap is a single pass; pass+1 passes are emitted so the wrap is backed
  const copies = Math.max(1, Math.floor(viewport / passWidth));
  const emitted = copies + 1;
  const travel = copies * passWidth;
  const track = emitted * passWidth - gutter;      // last tile has no trailing gap
  const reach = track - travel;                    // right edge at full drift
  return {
    sequenceRepeats, passWidth, sequenceWidth, copies, emitted, travel, track, reach,
    covered: reach + gutter >= viewport
  };
}

/** A row is sound when its pass is wide enough to keep the strip covered at
 *  every plausible width, and when it is not carrying more loop scaffolding
 *  than content. */
function validateRows(rows, pages, log) {
  const problems = [];
  const warnings = [];
  const WIDEST = 2560;   // a 4K display at 2× lands at 1920; this clears it
  const MAX_REPEATS = 4;
  for (const row of rows) {
    // real tile widths, not nominal per-class widths: an image's own ratio
    // decides its box, and the loop maths must use the numbers the browser
    // will actually lay out
    let seq = 0;
    for (const s of row.slugs) seq += tileBox(pages[s]).w + 16;
    row.sequenceWidth = seq;
    row.proj = wallProject(seq, 16, WIDEST);
    if (!row.proj.covered) {
      problems.push(`row ${row.index + 1}: at full drift the strip stops at ${Math.round(row.proj.reach)}px, short of ${WIDEST}px`);
    }
    if (row.proj.sequenceRepeats > MAX_REPEATS) {
      warnings.push(
        `row ${row.index + 1}: a pass repeats the sequence ${row.proj.sequenceRepeats}× ` +
        `(one pass-over is ${Math.round(seq)}px) — more images would reduce the repeating`
      );
    }
    const dupes = row.slugs.filter((s, i) => row.slugs.indexOf(s) !== i);
    if (dupes.length) problems.push(`row ${row.index + 1} repeats ${[...new Set(dupes)].join(", ")}`);
  }
  const seen = new Set(rows.flatMap((r) => r.slugs));
  const missing = Object.keys(pages).filter((s) => !seen.has(s));
  if (missing.length) warnings.push(`not placed on the wall: ${missing.join(", ")}`);
  problems.forEach((p) => log("  ✗ " + p));
  warnings.forEach((p) => log("  ! " + p));
  return problems;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 4. wall markup                                                        */
/* ══════════════════════════════════════════════════════════════════════ */

/** A tile's on-screen box, in CSS pixels. Height is the band; width follows
 *  from the image's own ratio, so each frame keeps its proportion and the wall
 *  reads as a collage instead of a culled grid. */
function tileBox(p) {
  return { h: CLASS_H[p.class], w: Math.round(CLASS_H[p.class] * p.ratio) };
}

/**
 * A wall tile. The wall is a moving collage with no captions, so it is exposed
 * to assistive tech as a single decorative image rather than as dozens of
 * unlabelled controls: every tile is aria-hidden and unfocusable, and the
 * accessible presentation of the same set lives in the viewer (full alt text,
 * captions, keyboard stepping). Repeated passes carry `dup` so the markup
 * shows which frames are the loop's spares rather than real content.
 */
function tileHtml(p, { eager = false, seq = 0, dup = "" } = {}) {
  const loading = eager ? "eager" : "lazy";
  const priority = eager ? ' fetchpriority="high"' : "";
  const box = tileBox(p);
  return `
        <button class="wall-tile t-${p.class}" type="button" data-slug="${esc(p.slug)}" data-seq="${seq}"${dup}
                style="--th:${box.h}px; --tw:${box.w}px"
                tabindex="-1" aria-hidden="true">
          <span class="tile-frame">
            <img class="tile-lqip" src="${esc(p.lqip)}" alt="" width="${box.w}" height="${box.h}" aria-hidden="true" decoding="async">
            <picture>
              <source type="image/webp" srcset="${esc(p.d1x)} 1x, ${esc(p.d2x)} 2x">
              <img src="${esc(p.d1xJpg)}" srcset="${esc(p.d1xJpg)} 1x, ${esc(p.d2xJpg)} 2x"
                   alt="" width="${box.w}" height="${box.h}"
                   loading="${loading}" decoding="async"${priority}>
            </picture>
          </span>
        </button>`;
}

function wallHtml(rows, pages) {
  return rows.map((row) => {
    const proj = row.proj;
    // A "pass" is the sequence laid end to end `sequenceRepeats` times, widened
    // until one pass can cover the target viewport. `emitted` passes are then
    // written out; drifting by `copies` of them lands the last pass exactly
    // where the first began. Copies after the first are pulled out of the tab
    // order and hidden from assistive tech, so a keyboard user meets each frame
    // once — and the wall is aria-hidden anyway.
    let passes = "";
    for (let c = 0; c < proj.emitted; c++) {
      for (let r = 0; r < proj.sequenceRepeats; r++) {
        const passIndex = c * proj.sequenceRepeats + r;
        const dup = passIndex > 0 ? ` data-dup="${passIndex}"` : "";
        passes += row.slugs
          .map((s, i) => tileHtml(pages[s], {
            eager: row.index === 0 && passIndex === 0 && i < 3,
            seq: passIndex * row.slugs.length + i,
            dup
          }))
          .join("");
      }
    }
    // constant -speed: a lap advances by exactly one pass
    const dur = Math.round(proj.passWidth / DRIFT_PPS);
    const first = pages[row.slugs[0]];
    return `
    <div class="wall-row" data-dir="${row.direction}" data-passes="${proj.emitted}" data-repeats="${proj.sequenceRepeats}"
         style="--travel:${proj.travel}px; --wall-dur:${dur}s; --row-lqip:url('${esc(first.lqip)}')">
      <div class="wall-track">${passes}</div>
    </div>`;
  }).join("\n");
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 5. templates                                                          */
/* ══════════════════════════════════════════════════════════════════════ */

const CSS = ["tokens", "base", "wall", "article", "lightbox"];

function head({ title, desc, canonical, type = "website", jsonld }) {
  const full = title === SITE.title ? title : `${title} — ${SITE.title}`;
  return `<!doctype html>
<html lang="${SITE.lang}" data-motion="on">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(desc || SITE.desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="#F9F8F6">
<meta name="color-scheme" content="light">
<meta property="og:site_name" content="${esc(SITE.title)}">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(desc || SITE.desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${CSS.map((n) => `<link rel="stylesheet" href="/assets/${n}.css">`).join("\n")}
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
</head>
<body>
<a class="skip" href="#main">跳到正文</a>`;
}

function mast(active) {
  const link = (href, text, key) =>
    `<a class="navlink" href="${href}"${active === key ? ' aria-current="page"' : ""}>${text}</a>`;
  return `
<header class="masthead">
  <div class="shell masthead__in">
    <a class="wordmark" href="/">${esc(SITE.title)}</a>
    <nav class="masthead__nav" aria-label="主导航">
      ${link("/images/", "图片", "images")}
      ${link("/articles/", "文章", "articles")}
      ${link("/about/", "关于", "about")}
      <button class="motion" type="button" data-motion-toggle aria-pressed="true">
        <span data-motion-text>流动</span>
      </button>
    </nav>
  </div>
</header>`;
}

function foot() {
  return `
<footer class="colophon">
  <div class="shell">
    <div class="colophon__grid">
      <span class="wordmark">${esc(SITE.title)}</span>
      <p class="colophon__note">文章与图片档案。界面为纯单色，画面是页面上唯一带颜色的东西。</p>
      <p class="colophon__note"><a class="ulink" href="https://github.com/fengzishiyi/fengzishiyi.github.io">GitHub</a> · <a class="ulink" href="/sitemap.xml">Sitemap</a> · <span class="meta">© ${new Date().getFullYear()} ${esc(SITE.author)}</span></p>
    </div>
  </div>
</footer>
<script src="/assets/site.js" defer></script>
</body>
</html>`;
}

function lightboxHtml() {
  return `
<div class="lb" data-lightbox data-open="false" role="dialog" aria-modal="true" aria-label="图片查看器">
  <div class="lb__top">
    <span class="lb__count" aria-live="polite" aria-atomic="true"></span>
    <span>
      <button class="lb__btn lb__zoom" type="button" data-lb-zoom aria-pressed="false">放大</button>
      <button class="lb__btn" type="button" data-lb-close>关闭</button>
    </span>
  </div>
  <div class="lb__stage">
    <button class="lb__step lb__step--prev" type="button" data-lb-prev aria-label="上一张">←</button>
    <figure class="lb__figure"><img class="lb__img" alt="" decoding="async"><span class="lb__spinner" aria-hidden="true"></span></figure>
    <button class="lb__step lb__step--next" type="button" data-lb-next aria-label="下一张">→</button>
  </div>
  <div class="lb__bar">
    <h2 class="lb__title"></h2>
    <ul class="lb__facts"></ul>
  </div>
</div>`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 6. articles                                                          */
/* ══════════════════════════════════════════════════════════════════════ */

function parseFrontMatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const data = {};
  if (!m) return { data, body: raw };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let [, k, v] = kv;
    v = v.trim();
    if (/^\[.*\]$/.test(v)) {
      data[k] = v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      data[k] = v.replace(/^["']|["']$/g, "");
    }
  }
  return { data, body: raw.slice(m[0].length) };
}

function renderMarkdown(md, { pages, articleSlug }) {
  const headings = [];
  const renderer = new marked.Renderer();

  renderer.heading = function (token) {
    const text = this.parser.parseInline(token.tokens);
    // A Chinese heading slugifies to nothing usable, so CJK anchors get
    // positional ids (h2-1, h2-2 …) while Latin ones keep their words.
    const raw = String(token.text || "");
    const latin = raw.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
    const id = latin || `h${token.depth}-${headings.filter((h) => h.level === token.depth).length + 1}`;
    headings.push({ id, text: raw, level: token.depth });
    return `<h${token.depth} id="${esc(id)}">${text}</h${token.depth}>\n`;
  };

  renderer.image = function (token) {
    const { href, title, text } = token;
    return `<figure><img src="${esc(href)}" alt="${esc(text || "")}" loading="lazy" decoding="async">${
      text || title ? `<figcaption>${esc(text || title)}</figcaption>` : ""
    }</figure>\n`;
  };

  renderer.link = function (token) {
    const href = token.href || "";
    const external = /^https?:/i.test(href);
    return `<a class="ulink" href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${this.parser.parseInline(token.tokens)}</a>`;
  };

  let html = marked.parse(md, { renderer, gfm: true, breaks: false });

  // shortcodes: {{img:slug}} / {{figure:slug|caption}}
  html = html.replace(/\{\{(img|figure):([^}|]+)(?:\|([^}]*))?\}\}/g, (_, kind, slugRaw, caption) => {
    const slug = slugRaw.trim();
    const p = pages[slug];
    if (!p) {
      console.warn(`  ! ${articleSlug}: shortcode references unknown image "${slug}"`);
      return `<figure><img alt="" class="missing"><figcaption>缺少图片：${esc(slug)}</figcaption></figure>`;
    }
    if (kind === "img") {
      return `<figure><img src="${esc(p.d1x)}" alt="${esc(p.alt)}" width="${p.width}" height="${p.height}" loading="lazy" decoding="async"></figure>`;
    }
    return `<figure><img src="${esc(p.d1x)}" alt="${esc(p.alt)}" width="${p.width}" height="${p.height}" loading="lazy" decoding="async">${
      caption ? `<figcaption>${esc(caption.trim())}</figcaption>` : ""
    }</figure>`;
  });

  return { html, headings };
}

function loadArticles(pages, log) {
  const files = walk(SRC_ARTICLES).filter((f) => /\.(md|markdown)$/i.test(f));
  const items = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const { data, body } = parseFrontMatter(raw);
    const base = path.basename(file).replace(/\.(md|markdown)$/i, "");
    const slug = slugify(data.slug || base);
    const title = data.title || base.replace(/[-_]/g, " ");
    const date = data.date || fs.statSync(file).mtime.toISOString().slice(0, 10);

    const { html, headings } = renderMarkdown(body, { pages, articleSlug: slug });

    // standfirst falls back to the first paragraph, trimmed to a sentence
    let summary = data.summary || "";
    if (!summary) {
      const first = /<p>([\s\S]*?)<\/p>/.exec(html);
      summary = first ? first[1].replace(/<[^>]+>/g, "").trim().slice(0, 84) : "";
    }

    const words = body.replace(/\s+/g, "").length;
    items.push({
      slug,
      title,
      date,
      tags: data.tags || [],
      summary,
      standfirst: data.standfirst || "",
      kicker: data.kicker || "",
      cover: data.cover || "",
      minutes: Math.max(1, Math.round(words / 400)),
      words,
      html,
      headings: headings.filter((h) => h.level === 2),
      bodyChars: body.length
    });
    log(`  ${path.basename(file)} → /articles/${slug}/  (${words} 字)`);
  }

  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return items;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 7. pages                                                             */
/* ══════════════════════════════════════════════════════════════════════ */

function pageHome(pages, rows, articles) {
  const latest = articles.slice(0, 3);
  const latestHtml = latest.length
    ? `<ul class="artlist">
${latest.map((a, i) => `        <li class="artlist__item"><a class="artlist__link" href="/articles/${esc(a.slug)}/">
          <span class="artlist__num" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span>
          <span class="artlist__date"><time datetime="${esc(a.date)}">${esc(a.date.replace(/-/g, "."))}</time></span>
          <h3 class="artlist__title">${esc(a.title)}</h3>
          <p class="artlist__sum">${esc(a.summary)}</p>
        </a></li>`).join("\n")}
      </ul>
      <div class="crosslinks"><a class="ulink label label--plain" href="/articles/">全部文章 →</a></div>`
    : `<p class="empty">还没有文章。</p>`;

  return `${head({
    title: SITE.title,
    desc: SITE.desc,
    canonical: `${SITE.origin}/`,
    jsonld: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE.title,
      url: SITE.origin,
      inLanguage: SITE.lang
    }
  })}
${mast("home")}
<main id="main">
  <section class="shell intro">
    <h1 class="intro__title">一面一直在流动的图墙，<br>和一本慢慢翻的杂志。</h1>
    <p class="intro__sub">上面是画面，下面是文字。<em>画面不写标题，文字不喊口号。</em></p>
  </section>

  <section class="wall" aria-label="图片墙" data-tiles="${Object.keys(pages).length}">
${wallHtml(rows, pages)}
  </section>

  <section class="shell section" aria-labelledby="latest-h">
    <div class="section-head"><h2 class="section-head__title" id="latest-h">最近写的</h2><a class="ulink label label--plain" href="/articles/">文章索引</a></div>
    ${latestHtml}
  </section>
</main>
${lightboxHtml()}
${foot()}`;
}

function pageWall(rows, pages) {
  return `${head({
    title: "图片",
    desc: "一面持续流动的照片墙。画面不标标题，点开才是大图。",
    canonical: `${SITE.origin}/images/`
  })}
${mast("images")}
<main id="main">
  <section class="shell page-intro">
    <h1 class="page-title">图片</h1>
    <p class="page-intro__sub">一直在流动。鼠标移上去停住，点开看大图；右上角可以把它停下来。</p>
  </section>
  <section class="wall" aria-label="图片墙" data-tiles="${Object.keys(pages).length}">
${wallHtml(rows, pages)}
  </section>
</main>
${lightboxHtml()}
${foot()}`;
}

function pageArticleIndex(articles) {
  const list = articles.length
    ? `<ul class="artlist">
${articles.map((a, i) => `      <li class="artlist__item"><a class="artlist__link" href="/articles/${esc(a.slug)}/">
        <span class="artlist__num" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span>
        <span class="artlist__date"><time datetime="${esc(a.date)}">${esc(a.date.replace(/-/g, "."))}</time></span>
        <h2 class="artlist__title">${esc(a.title)}</h2>
        <p class="artlist__sum">${esc(a.summary)}</p>
      </a></li>`).join("\n")}
    </ul>`
    : `<p class="empty">还没有文章。把 .md 放进 _articles/ 再跑一次构建。</p>`;

  return `${head({
    title: "文章",
    desc: "杂志排版的长文存档。",
    canonical: `${SITE.origin}/articles/`
  })}
${mast("articles")}
<main id="main">
  <section class="shell page-intro">
    <h1 class="page-title">文章</h1>
    <p class="page-intro__sub">一篇一页，按时间倒序。<em>${articles.length}</em> 篇。</p>
  </section>
  <section class="shell section" style="padding-top:64px">
    ${list}
  </section>
</main>
${foot()}`;
}

function pageArticle(a, prev, next) {
  const toc = a.headings.length >= 2
    ? `<nav class="speclist" aria-label="本文目录">${a.headings.map((h) =>
        `<div class="speclist__row speclist__row--toc"><a class="ulink speclist__v" href="#${esc(h.id)}">${esc(h.text)}</a></div>`).join("")}</nav>`
    : "";

  const tags = a.tags.length
    ? `<ul class="tags">${a.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
    : "";

  const pager = `<nav class="pager" aria-label="文章翻页">
      ${prev ? `<a class="pager__link pager__link--prev" href="/articles/${esc(prev.slug)}/"><span class="pager__arrow">←</span><span>${esc(prev.title)}</span></a>` : `<span></span>`}
      ${next ? `<a class="pager__link" href="/articles/${esc(next.slug)}/"><span>${esc(next.title)}</span><span class="pager__arrow">→</span></a>` : `<span></span>`}
    </nav>
    <div class="crosslinks"><a class="ulink label label--plain" href="/articles/">← 文章索引</a></div>`;

  return `${head({
    title: a.title,
    desc: a.summary,
    canonical: `${SITE.origin}/articles/${a.slug}/`,
    type: "article",
    jsonld: {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: a.title,
      datePublished: a.date,
      inLanguage: SITE.lang,
      author: { "@type": "Person", name: SITE.author },
      description: a.summary
    }
  })}
${mast("articles")}
<main id="main" class="shell article">
  <div class="article__grid">
    <aside class="article__aside">
      ${a.kicker ? `<p class="label" style="margin:0 0 14px">${esc(a.kicker)}</p>` : ""}
      <h1 class="article__title">${esc(a.title)}</h1>
      ${a.standfirst ? `<p class="article__standfirst">${esc(a.standfirst)}</p>` : ""}
      <div class="speclist">
        <div class="speclist__row"><span class="speclist__k">日期</span><span class="speclist__v"><time datetime="${esc(a.date)}">${esc(a.date)}</time></span></div>
        <div class="speclist__row"><span class="speclist__k">篇幅</span><span class="speclist__v">${a.words} 字 · 约 ${a.minutes} 分钟</span></div>
        <div class="speclist__row"><span class="speclist__k">作者</span><span class="speclist__v">${esc(SITE.author)}</span></div>
      </div>
      ${tags}
      ${toc}
    </aside>
    <div class="prose">
${a.html}
${pager}
    </div>
  </div>
</main>
${foot()}`;
}

function pageAbout(pages, articles) {
  const n = Object.keys(pages).length;
  return `${head({
    title: "关于",
    desc: "关于这个站点，以及它为什么长成现在这样。",
    canonical: `${SITE.origin}/about/`
  })}
${mast("about")}
<main id="main" class="shell article">
  <div class="article__grid">
    <aside class="article__aside">
      <h1 class="article__title">关于</h1>
      <p class="article__standfirst">一个放文章和图片的地方。</p>
      <div class="speclist">
        <div class="speclist__row"><span class="speclist__k">图片</span><span class="speclist__v">${n} 张</span></div>
        <div class="speclist__row"><span class="speclist__k">文章</span><span class="speclist__v">${articles.length} 篇</span></div>
      </div>
    </aside>
    <div class="prose">
      <p>这里是两件事叠在一起：一面一直在流动的图墙，和一份按时间倒序的文章存档。图片不写标题，因为它们在你点开之前不需要解释；文章一页一篇，因为它们值得被慢慢读完。</p>
      <p>界面是纯单色的 —— 只有暖米色的底和柔和的黑。颜色全部来自画面本身，这是刻意的：当界面不去争抢注意力，图片和文字才站得住。</p>
      <h2 id="colophon">Colophon</h2>
      <p>没有框架，没有构建服务，没有网络字体。一套 Node 脚本把 <code>_images/</code> 里的原图压成 WebP，把 <code>_articles/</code> 里的 markdown 排成 HTML，然后把结果推到这个仓库的根目录。</p>
      <ul>
        <li>字体：系统衬线体（中文回退到宋体）配系统无衬线体，零网络请求。</li>
        <li>图墙：CSS 关键帧做无缝循环，<em>没有任何滚动劫持</em>。</li>
        <li>降级：脚本不加载时，图片照样看得到，只是不能放大。</li>
      </ul>
      <p><a class="ulink" href="/articles/">读文章</a> · <a class="ulink" href="/images/">看图片</a></p>
    </div>
  </div>
</main>
${foot()}`;
}

function page404() {
  return `${head({ title: "404", desc: "没有这一页。", canonical: `${SITE.origin}/404.html` })}
${mast("")}
<main id="main" class="shell" style="padding-top:calc(var(--nav-h) + 160px);padding-bottom:var(--sec-y)">
  <h1 class="intro__title">这一页<br>从来没有过。</h1>
  <p class="intro__sub">或者它被删掉了。<em>猜不到的话，回到开头。</em></p>
  <div class="crosslinks" style="margin-top:40px">
    <a class="ulink label label--plain" href="/">回到首页 →</a>
    <a class="ulink label label--plain" href="/articles/">文章索引</a>
    <a class="ulink label label--plain" href="/images/">图片</a>
  </div>
</main>
${foot()}`;
}

function favicon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="#F9F8F6"/>
<text x="32" y="44" font-family="Georgia,serif" font-size="36" fill="#1C1C1C" text-anchor="middle">枫</text>
</svg>`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 8. design-rule assertion                                              */
/* ══════════════════════════════════════════════════════════════════════ */

function luminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
const over = (top, alpha, base) => top.map((c, i) => c * alpha + base[i] * (1 - alpha));
const toHex = (rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

function checkDesign(log) {
  // Strip comments first: the rules are documented in prose above the CSS, and
  // an assertion that trips on its own documentation is worse than none.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  // Print is the one place pure black on white is right, so it is excluded
  // from the palette assertions rather than special-cased inside them.
  const forScreen = (s) => s.replace(/@media\s+print\s*\{[\s\S]*?\n\}/g, "");
  const css = forScreen(strip(CSS.map((n) => fs.readFileSync(path.join(ASSETS, `${n}.css`), "utf8")).join("\n")));
  const js = strip(fs.readFileSync(path.join(ASSETS, "site.js"), "utf8"));
  const failures = [];

  // Messages deliberately name colours rather than quoting hex, so a rule can
  // never be tripped by the checker's own words.
  const FORBIDDEN = [
    [/rounded-(?!none)[a-zA-Z0-9[\]_.-]*/g, "rounded corners are forbidden (rounded-none only)"],
    [/shadow-[a-zA-Z0-9-]+/g, "shadows are forbidden"],
    [/border-[248]\b/g, "borders thicker than 1px are forbidden"],
    [/bg-gradient-|linear-gradient|radial-gradient/g, "gradients are forbidden"],
    [/#e63946/gi, "the kit's red accent is forbidden — the 禁止项 list outranks the token dictionary"],
    [/#0a0a0a|#000000|#000\b/gi, "a pure black was found — the palette uses the soft black only"],
    [/#fafafa|#ffffff|#fff\b/gi, "a cold white was found — the palette uses the warm cream only"],
    [/font-black|font-weight:\s*(?:[6-9]00|bold|bolder)/g, "heavy weights are forbidden — headings stay at 400"]
  ];
  for (const [re, msg] of FORBIDDEN) {
    const hits = (css.match(re) || []).concat(js.match(re) || []);
    if (hits.length) failures.push(msg + ` → ${[...new Set(hits)].slice(0, 4).join(", ")}`);
  }

  // every rule that sets a heading family must set a serif one
  for (const block of css.match(/\bh[1-6][^{]*\{[^}]*\}/g) || []) {
    if (/font-family/.test(block) && !/serif/.test(block)) {
      failures.push(`a heading sets a non-serif family: ${block.slice(0, 70).replace(/\s+/g, " ")}…`);
    }
  }

  // Contrast, measured on the values that actually render. The gray tiers are
  // pre-composited hex, so read them out of the stylesheet instead of assuming
  // a foreground alpha (which would report a misleadingly high ratio).
  const hex = (name, fallback) => {
    const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(css);
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const paper = hex("paper", [0xf9, 0xf8, 0xf6]);
  const ink = hex("ink", [0x1c, 0x1c, 0x1c]);
  // print the gray scale the tokens claim, so the comment in tokens.css can be
  // checked against arithmetic rather than taken on trust
  for (const [name, tier] of [["ink-80", 0.8], ["ink-60", 0.6], ["ink-40", 0.4]]) {
    const tokenVal = hex(name, paper);
    log(`  ${name}: token ${toHex(tokenVal)}  vs  ink@${(tier * 100).toFixed(0)}% over paper ${toHex(over(ink, tier, paper))}`);
  }
  const checks = [
    ["body  --ink-80", hex("ink-80", [0x49, 0x49, 0x48]), 4.5],
    ["label --ink-60", hex("ink-60", [0x6a, 0x6a, 0x69]), 4.5],
    ["decor --ink-40", hex("ink-40", [0xb0, 0xb0, 0xae]), 0]   // decorative, never required
  ];
  for (const [name, comp, need] of checks) {
    const r = contrast(comp, paper);
    const ok = r >= need;
    log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(14)} ${r.toFixed(2)}:1${need ? `  (AA needs ${need})` : "  (decorative)"}`);
    if (!ok) failures.push(`${name} measures ${r.toFixed(2)}:1, below WCAG AA`);
  }

  // Structural: the wall's loop maths is split across two files and must agree.
  // These read the build script's own source, so the patterns avoid backslashes
  // and are written with plain string concatenation rather than nested literals.
  const self = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  if (!/var\(--travel/.test(css)) failures.push("the wall drift no longer uses the injected --travel distance");
  if (self.indexOf("--travel:${proj.travel}px") === -1) failures.push("the build no longer injects --travel per row");
  if (!/gap:\s*var\(--gutter\)/.test(css)) failures.push("the wall track must use flex gap, not margins");
  if (!/overflow:\s*hidden/.test(css)) failures.push("wall rows must clip their tracks");
  if (!/prefers-reduced-motion/.test(css)) failures.push("no prefers-reduced-motion fallback");
  if (!/data-motion="off"/.test(css)) failures.push("the still-mode hook is missing");
  if (!/aria-pressed/.test(js)) failures.push("the motion toggle has no aria-pressed state");
  if (self.indexOf('aria-hidden="true"') === -1) failures.push("wall tiles are not hidden from assistive tech");

  // Band geometry is declared twice — as CSS custom properties and as CLASS_H /
  // CLASS_W in this script — so assert they still describe the same bands.
  const tokensCss = strip(fs.readFileSync(path.join(ASSETS, "tokens.css"), "utf8"));
  const bandChecks = [
    ["--tile-xxl-h", CLASS_H.xxl], ["--tile-xl-h", CLASS_H.xl], ["--tile-lg-h", CLASS_H.lg],
    ["--tile-md-h", CLASS_H.md], ["--tile-sm-h", CLASS_H.sm],
    ["--tile-xxl-w", CLASS_W.xxl], ["--tile-xl-w", CLASS_W.xl], ["--tile-lg-w", CLASS_W.lg],
    ["--tile-md-w", CLASS_W.md], ["--tile-sm-w", CLASS_W.sm]
  ];
  for (const [name, expected] of bandChecks) {
    const m = new RegExp(name.replace(/-/g, "\\-") + ":\\s*(\\d+)px").exec(tokensCss);
    if (!m) { failures.push(`${name} is missing from tokens.css`); continue; }
    if (Number(m[1]) !== expected) {
      failures.push(`${name} is ${m[1]}px in CSS but ${expected}px in the build — the bands have drifted`);
    }
  }
  const rowH = /--tile-row-h:\s*(\d+)px/.exec(tokensCss);
  if (!rowH) failures.push("--tile-row-h must be a literal px value equal to the tallest band");
  else if (Number(rowH[1]) < Math.max(...Object.values(CLASS_H))) {
    failures.push(`--tile-row-h (${rowH[1]}px) is shorter than the tallest band (${Math.max(...Object.values(CLASS_H))}px)`);
  }

  return failures;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 9. publish                                                            */
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

function publish(log) {
  // Assets are authored, not generated, so they are copied straight from src/
  // rather than staged — the one thing not mirrored from .build/.
  const assetDst = path.join(ROOT, "assets");
  rm(assetDst);
  ensure(assetDst);
  for (const f of fs.readdirSync(ASSETS)) {
    fs.copyFileSync(path.join(ASSETS, f), path.join(assetDst, f));
  }

  for (const rel of MANAGED) {
    if (rel === "assets") continue;
    const dst = path.join(ROOT, rel);
    const src = path.join(STAGE, rel);
    if (!exists(src)) { rm(dst); continue; }
    if (fs.statSync(src).isDirectory()) mirrorDir(src, dst);
    else { ensure(path.dirname(dst)); fs.copyFileSync(src, dst); }
  }

  const missing = MANAGED.filter((r) => !exists(path.join(ROOT, r)));
  if (missing.length) throw new Error(`publish left these unpublished: ${missing.join(", ")}`);
  log(`  published → repo root (${MANAGED.length} paths, all verified present)`);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 10. main                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

async function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check-only");
  const log = (s) => console.log(s);

  if (argv.includes("--clean")) {
    rm(STAGE);
    for (const rel of MANAGED) rm(path.join(ROOT, rel));
    log("cleaned");
    if (!checkOnly) return;
  }

  const t0 = Date.now();
  log("▸ images");
  rm(STAGE);
  ensure(STAGE);

  const { pages, orderAll } = await buildImages(log);
  const rows = computeRows(pages, orderAll);
  log("▸ wall layout");
  const rowProblems = validateRows(rows, pages, log);
  if (!rowProblems.length) {
    log("  " + rows.map((r) =>
      `row ${r.index + 1}: ${r.slugs.length} frames ×${r.proj.sequenceRepeats} = pass ${Math.round(r.proj.passWidth)}px · ` +
      `${r.proj.emitted} passes · travel ${r.proj.travel}px · reach ${Math.round(r.proj.reach)}px`
    ).join("\n  "));
  }

  log("▸ articles");
  const articles = loadArticles(pages, log);

  log("▸ pages");
  write("index.html", pageHome(pages, rows, articles));
  write("images/index.html", pageWall(rows, pages));
  write("articles/index.html", pageArticleIndex(articles));
  articles.forEach((a, i) => {
    write(path.join("articles", a.slug, "index.html"),
      pageArticle(a, articles[i + 1] || null, articles[i - 1] || null));
  });
  write("about/index.html", pageAbout(pages, articles));
  write("404.html", page404());
  write("favicon.svg", favicon());
  write(".nojekyll", "");

  const urls = ["/", "/images/", "/articles/", "/about/", ...articles.map((a) => `/articles/${a.slug}/`)];
  write("sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map((u) => `  <url><loc>${SITE.origin}${u}</loc></url>`).join("\n")
    }\n</urlset>\n`);
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${SITE.origin}/sitemap.xml\n`);

  const manifest = {
    site: SITE,
    order: orderAll,
    rows: rows.map((r) => ({ index: r.index, direction: r.direction, slugs: r.slugs, dur: null })),
    pages
  };
  write("images/manifest.json", JSON.stringify(manifest, null, 2) + "\n");

  log("▸ design rules");
  const failures = checkDesign(log);

  if (checkOnly) {
    log(failures.length ? `\n✗ ${failures.length} design rule failure(s)` : "\n✓ design rules pass");
    process.exit(failures.length ? 1 : 0);
  }

  const tileBytes = Object.values(pages).reduce((n, p) => n + p.bytes.reduce((a, b) => a + b, 0), 0);
  const dirBytes = (dir) => walk(dir).reduce((n, f) => n + fs.statSync(f).size, 0);

  log("▸ size");
  log(`  originals   ${(Object.values(pages).reduce((n, p) => n + p.original.bytes, 0) / 1048576).toFixed(1)} MB`);
  log(`  derivatives ${(tileBytes / 1048576).toFixed(2)} MB  (webp + jpg, 1x + 2x + lqip)`);
  log(`  css + js    ${((dirBytes(path.join(STAGE, "assets")) + walk(path.join(STAGE)).filter((f) => f.endsWith(".html")).reduce((n, f) => n + fs.statSync(f).size, 0)) / 1024).toFixed(0)} KB`);

  if (failures.length) {
    log("\n✗ design rule failures — nothing was published:");
    failures.forEach((f) => log("   · " + f));
    process.exit(1);
  }

  publish(log);

  const files = walk(STAGE).length;
  log(`\n✓ built ${files} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  ${Object.keys(pages).length} images · ${rows.length} wall rows · ${articles.length} articles`);
}

main().catch((e) => {
  console.error("\n✗ build failed:", e.message);
  process.exit(1);
});
