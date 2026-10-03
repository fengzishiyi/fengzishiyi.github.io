#!/usr/bin/env node
/**
 * build.mjs — the whole site generator, one file, no framework.
 *
 * The site is a MAGAZINE, not a blog plus a gallery:
 *
 *   /              the cover — nameplate, issue line, the featured article
 *   /contents/     the departments page: articles grouped by 栏目
 *   /archive/      every issue, newest first
 *   /articles/<s>/ one article = one spread, with a cover image
 *   /about/        本刊 + colophon
 *
 * Sources:
 *   _site.json      nameplate, tagline, volume start year, default author
 *   _issues/*.json  optional per-issue overrides (label, note, feature)
 *   _articles/*.md  the writing; front matter carries section/cover/etc
 *   _images/*       originals (never published, git-ignored)
 *
 * Everything is staged in .build/ and only swapped into the published tree
 * once the whole run has succeeded, so a failed build can never leave half a
 * site behind — and a failed CONTENT check never overwrites the last good
 * version. The final step re-reads its own CSS and asserts the editorial
 * style rules still hold.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { marked } from "marked";

/* ══════════════════════════════════════════════════════════════════════ */
/* config                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const SRC_IMAGES = path.join(ROOT, "_images");
const SRC_ARTICLES = path.join(ROOT, "_articles");
const SRC_ISSUES = path.join(ROOT, "_issues");
const ASSETS = path.join(HERE, "assets");

const STAGE = path.join(ROOT, ".build");

/** Published paths, wiped and re-emitted on every build. Every directory the
 *  pages are written into MUST appear here, or it is built and then silently
 *  left behind in the staging tree — which is exactly how /about/ once 404'd.
 *  `publish()` re-checks that all of them landed. */
const MANAGED = [
  "images", "assets", "articles", "contents", "archive", "about",
  "index.html", "404.html", "sitemap.xml", "robots.txt", "favicon.svg", ".nojekyll"
];

/** Departments. A fixed vocabulary is what makes a contents page possible —
 *  free-form tags cannot be grouped. Unknown values fail the build. */
const SECTIONS = [
  { key: "专题", note: "长文与主题写作" },
  { key: "作品", note: "图与短记" },
  { key: "随笔", note: "想到哪写到哪" },
  { key: "手记", note: "过程、草稿、失败" }
];

const DEFAULTS = {
  origin: "https://fengzishiyi.github.io",
  title: "枫子十一",
  subtitle: "一个人的杂志",
  tagline: "文章、图画与一些想不清楚的事。",
  lang: "zh-Hans",
  author: "fengzishiyi",
  volumeStartYear: 2026
};

const IMG = {
  webp: { quality: 82, effort: 5 },
  jpg: { quality: 82, progressive: true, mozjpeg: true },
  lqip: { w: 24, quality: 40 },
  /** long-edge caps by role, in CSS px of the largest place they appear */
  cap: { cover: 1600, hero: 1400, inline: 1100, thumb: 720 }
};

const CSS = ["tokens", "base", "spread", "article", "lightbox"];

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

/** Levenshtein, capped — used to suggest the slug a typo meant. */
function nearMiss(input, candidates, max = 3) {
  const dist = (a, b) => {
    if (Math.abs(a.length - b.length) > 4) return 99;
    const prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(
          prev[j] + 1,
          prev[j - 1] + 1,
          diag + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        diag = tmp;
      }
    }
    return prev[b.length];
  };
  return candidates
    .map((c) => ({ c, d: dist(String(input).toLowerCase(), String(c).toLowerCase()) }))
    .filter((x) => x.d < 4)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.c);
}

/** Collects content problems so one run reports all of them, not just the first. */
class Problems {
  constructor() { this.items = []; this.warnings = []; }
  error(file, message) { this.items.push({ file, message }); }
  warn(message) { this.warnings.push(message); }
  get failed() { return this.items.length > 0; }
  report(log, heading = "✗ content problems") {
    if (!this.items.length && !this.warnings.length) return;
    if (this.items.length) {
      log("\n" + heading);
      for (const p of this.items) log(`   ${p.file ? p.file + ": " : ""}${p.message}`);
    }
    if (this.warnings.length) {
      log("\n警告");
      for (const w of this.warnings) log("   · " + w);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 1. site + issue model                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

function loadSite() {
  const p = path.join(ROOT, "_site.json");
  if (!exists(p)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) {
    throw new Error(`_site.json is not valid JSON: ${e.message}`);
  }
}

/** Zero-config issues: the year gives the volume, the month gives the number.
 *  2026-02-18 → 第 1 卷 · 第 02 期. Nothing to maintain, nothing to name. */
function deriveIssue(date, site) {
  const [y, m] = String(date).split("-").map(Number);
  const year = Number.isFinite(y) ? y : new Date().getFullYear();
  const month = Number.isFinite(m) ? m : 1;
  const volume = Math.max(1, year - site.volumeStartYear + 1);
  return {
    year, month, volume, number: month,
    id: `${year}-${String(month).padStart(2, "0")}`,
    label: `${year} 年 ${month} 月`,
    title: `第 ${volume} 卷 · 第 ${String(month).padStart(2, "0")} 期`,
    short: `VOL.${volume} / NO.${String(month).padStart(2, "0")}`
  };
}

/** Optional _issues/<id>.json to name an issue or pin its feature. */
function loadIssueOverrides(log) {
  const out = {};
  for (const f of walk(SRC_ISSUES).filter((x) => /\.json$/i.test(x))) {
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      const id = data.id || path.basename(f).replace(/\.json$/i, "");
      out[id] = data;
    } catch (e) {
      log(`  ! ${path.basename(f)} is not valid JSON — ignored (${e.message})`);
    }
  }
  return out;
}

/** Fold articles into issues, newest issue first. */
function groupIssues(articles, site, overrides, problems, log) {
  const byId = new Map();
  for (const a of articles) {
    if (!byId.has(a.issue.id)) byId.set(a.issue.id, { ...a.issue, articles: [] });
    byId.get(a.issue.id).articles.push(a);
  }

  for (const [id, ov] of Object.entries(overrides)) {
    if (!byId.has(id)) { problems.warn(`_issues/${id}.json 对应的期号没有任何文章`); continue; }
    const iss = byId.get(id);
    if (ov.label) iss.label = ov.label;
    if (ov.note) iss.note = ov.note;
    iss.override = ov;
  }

  const issues = [...byId.values()].map((iss) => {
    iss.articles.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const ov = iss.override || {};
    // feature: an explicit pick, else front-matter `feature: true`, else the first
    let feature = iss.articles.find((a) => a.slug === ov.feature)
      || iss.articles.find((a) => a.feature)
      || iss.articles[0];
    if (ov.feature && !iss.articles.some((a) => a.slug === ov.feature)) {
      problems.warn(`_issues/${iss.id}.json 的 feature 指向不存在的文章 "${ov.feature}"，已退回自动选择`);
    }
    iss.feature = feature;
    iss.coverSlug = ov.cover || (feature && feature.cover) || "";
    iss.range = iss.articles.length
      ? `${iss.articles[iss.articles.length - 1].date} — ${iss.articles[0].date}`
      : "";
    return iss;
  });

  issues.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  if (issues.length) log(`  ${issues.length} 期 · 最新 ${issues[0].title}（${issues[0].articles.length} 篇）`);
  return issues;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 2. image pipeline                                                     */
/* ══════════════════════════════════════════════════════════════════════ */

function loadImageMeta() {
  const p = path.join(SRC_IMAGES, "metadata.json");
  if (!exists(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`_images/metadata.json is not valid JSON: ${e.message}`);
  }
}

const ratioClass = (ratio) =>
  ratio < 0.7 ? "tall" : ratio < 1.15 ? "square" : ratio < 1.9 ? "wide" : "pano";

async function buildImages(log) {
  const files = walk(SRC_IMAGES).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
  if (!files.length) throw new Error(`no images found in ${SRC_IMAGES}`);

  const meta = loadImageMeta();
  const pages = {};
  const order = [];
  const orphans = new Set(Object.keys(meta));

  for (const file of files) {
    const base = path.basename(file);
    const stem = base.replace(/\.[a-z0-9]+$/i, "");
    const slug = slugify(stem);
    if (pages[slug]) throw new Error(`two source files produce the slug "${slug}" — rename one (${base})`);
    orphans.delete(slug);
    orphans.delete(stem);

    const md = await sharp(file).metadata();
    if (!md.width || !md.height) throw new Error(`cannot read dimensions of ${base}`);
    const w = md.width;
    const h = md.height;
    const ratio = round(w / h, 4);
    const cls = ratioClass(ratio);

    // A cover is displayed up to ~1600 CSS px wide on a 4K screen, so the cap
    // follows the LONG edge and the small tier is generous enough for retina.
    const longest = Math.max(w, h);
    const cap1x = Math.min(IMG.cap.inline, longest);
    const cap2x = Math.min(IMG.cap.cover, Math.max(cap1x + 40, Math.round(longest * 0.62)));

    const outBase = `images/derived/${slug}`;
    ensure(path.join(STAGE, path.dirname(outBase)));

    const emit = async (cap, ext, tag) => {
      const resize = w >= h ? { width: cap } : { height: cap };
      let pipe = sharp(file).rotate().resize({ ...resize, withoutEnlargement: true });
      pipe = ext === "webp" ? pipe.webp(IMG.webp) : pipe.jpeg(IMG.jpg);
      const p = path.join(STAGE, `${outBase}-${tag}.${ext}`);
      await pipe.toFile(p);
      const m2 = await sharp(p).metadata();
      return { width: m2.width, height: m2.height, bytes: fs.statSync(p).size };
    };

    const d1 = await emit(cap1x, "webp", "1x");
    await emit(cap1x, "jpg", "1x");
    const d2 = await emit(cap2x, "webp", "2x");
    await emit(cap2x, "jpg", "2x");
    await sharp(file).rotate().resize({ width: IMG.lqip.w }).webp({ quality: IMG.lqip.quality })
      .toFile(path.join(STAGE, `${outBase}-lqip.webp`));

    const m = meta[slug] || meta[stem] || {};
    pages[slug] = {
      slug,
      source: path.relative(ROOT, file).split(path.sep).join("/"),
      original: { width: w, height: h, bytes: fs.statSync(file).size, format: md.format },
      width: w, height: h, ratio, class: cls,
      title: m.title || "", creator: m.creator || "", year: m.year || "",
      medium: m.medium || "", source_url: m.source || "", source_label: m.source_label || "来源",
      alt: m.alt || m.title || "",
      lqip: `/images/derived/${slug}-lqip.webp`,
      d1x: `/images/derived/${slug}-1x.webp`,
      d1xJpg: `/images/derived/${slug}-1x.jpg`,
      d2x: `/images/derived/${slug}-2x.webp`,
      d2xJpg: `/images/derived/${slug}-2x.jpg`,
      /** 1x derivative box, for the <img> width/height attributes — reserving
       *  the box before decode is what stops the page shifting as covers load */
      derivW: d1.width, derivH: d1.height,
      width2x: d2.width, height2x: d2.height,
      bytes: d1.bytes + d2.bytes
    };
    order.push(slug);
    log(`  ${base}  ${w}×${h}  r=${ratio}  ${cls}  →  ${d1.width}×${d1.height} / ${d2.width}×${d2.height}`);
  }

  if (orphans.size) log(`  ! metadata.json 里有未知 slug：${[...orphans].join(", ")}`);
  return { pages, order };
}

/** A <picture> for any use. `sizes` keeps the browser honest about which
 *  derivative it needs; width/height reserve the box before decode so covers
 *  never shift the layout as they load.
 *
 *  `interactive` makes the image openable in the viewer: focusable, and
 *  announced as a button with a name. The big derivative is hung on data-2x so
 *  the viewer can ask for the widest copy without a second lookup. */
function picture(p, { cls = "", sizes = "100vw", eager = false, alt = null, interactive = false } = {}) {
  const loading = eager ? "eager" : "lazy";
  const priority = eager ? ' fetchpriority="high"' : "";
  const a = alt === null ? (p.alt || "") : alt;
  const label = [p.title, p.creator].filter(Boolean).join(" · ");
  const act = interactive
    ? ` tabindex="0" role="button" data-2x="${esc(p.d2xJpg)}"${label ? ` data-label="${esc(label)}"` : ""}` +
      ` aria-label="放大查看${a ? "：" + esc(a) : ""}"`
    : "";
  return `<picture>
    <source type="image/webp" sizes="${esc(sizes)}" srcset="${esc(p.d1x)} 1x, ${esc(p.d2x)} 2x">
    <img class="${esc(cls)}" src="${esc(p.d1xJpg)}" srcset="${esc(p.d1xJpg)} 1x, ${esc(p.d2xJpg)} 2x"
         alt="${esc(a)}" width="${p.derivW || ""}" height="${p.derivH || ""}"
         loading="${loading}" decoding="async"${priority}${act}>
  </picture>`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 3. markdown                                                           */
/* ══════════════════════════════════════════════════════════════════════ */

/** Parse YAML-ish front matter.
 *
 *  A leading UTF-8 BOM must be stripped first. Notepad and PowerShell's
 *  WriteAllText both add one, and it silently broke parsing: the regex requires
 *  the file to START with `---`, so a BOM made the whole block invisible and
 *  every field came back empty with a confusing "缺 title" error. */
function parseFrontMatter(raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const data = {};
  if (!m) return { data, body: text, hadBom: raw !== text };
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
  return { data, body: text.slice(m[0].length), hadBom: raw !== text };
}

/** Inline figure inside the measure. */
function figureHtml(p, caption) {
  return `<figure>${picture(p, { sizes: "(min-width: 1000px) 640px, 92vw", interactive: true })}${
    caption ? `<figcaption>${esc(caption)}</figcaption>` : ""
  }</figure>`;
}

/** Full-bleed figure — leaves the measure on both sides.
 *
 *  Emitted as a bare `<div class="fig-bleed">` rather than a `<figure>` so the
 *  page template can hoist it OUT of the reading grid. A full-bleed element
 *  still inside a grid column cannot reach the viewport edge: the negative
 *  margin shifts it but does not widen its area, so it ends up off-centre by
 *  exactly the container's own offset. Hoisting it sidesteps the arithmetic. */
function bleedHtml(p, caption) {
  return `<div class="fig-bleed"><figure>${picture(p, { sizes: "100vw", interactive: true })}${
    caption ? `<figcaption>${esc(caption)}</figcaption>` : ""
  }</figure></div>`;
}

/** Split rendered prose at `<!--BLEED-->` markers so the page template can
 *  interleave full-bleed blocks with the grid-bound prose without ever nesting
 *  them inside it. */
const BLEED_MARK = "<!--BLEED-->";
function splitBleed(html) {
  return String(html).split(BLEED_MARK).map((chunk) => chunk.trim()).filter(Boolean);
}

/** Pull quote: typographic, no container. */
function pullHtml(text, by) {
  return `<aside class="pull"><p class="pull__text">${esc(text)}</p>${
    by ? `<p class="pull__by">${esc(by)}</p>` : ""
  }</aside>`;
}

function renderMarkdown(md, { pages, articleSlug, problems, pullCount }) {
  const headings = [];

  // Shortcodes are expanded on the RAW markdown before parsing, so block-level
  // HTML passes through marked untouched instead of being escaped inside a <p>.
  let src = md.replace(/\{\{(img|figure|bleed|quote):([^}]*)\}\}/g, (whole, kind, rest) => {
    const [slugRaw, ...capParts] = rest.split("|");
    const caption = capParts.join("|").trim();

    if (kind === "quote") {
      pullCount.n += 1;
      if (pullCount.n > 1) {
        problems.warn(`${articleSlug}: 有 ${pullCount.n} 处 {{quote:}} 引文 —— 引文的效力靠稀少，建议每篇最多 1 处`);
      }
      return pullHtml(slugRaw.trim(), caption);
    }

    const slug = slugRaw.trim();
    const p = pages[slug];
    if (!p) {
      const guess = nearMiss(slug, Object.keys(pages));
      problems.error(
        `${articleSlug}.md`,
        `{{${kind}:${slug}}} 找不到这张图。` +
        (guess.length ? `是不是想写：${guess.join(" / ")} ？` : `现有：${Object.keys(pages).slice(0, 6).join(", ")} …`)
      );
      return `<figure class="fig-missing"><figcaption>缺少图片：${esc(slug)}</figcaption></figure>`;
    }
    if (kind === "bleed") return `\n\n${BLEED_MARK}\n${bleedHtml(p, caption)}\n${BLEED_MARK}\n\n`;
    return figureHtml(p, caption);
  });

  const renderer = new marked.Renderer();

  renderer.heading = function (token) {
    const text = this.parser.parseInline(token.tokens);
    const raw = String(token.text || "");
    const latin = raw.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
    const id = latin || `h${token.depth}-${headings.filter((h) => h.level === token.depth).length + 1}`;
    headings.push({ id, text: raw, level: token.depth });
    return `<h${token.depth} id="${esc(id)}">${text}</h${token.depth}>\n`;
  };

  renderer.image = function (token) {
    const { href, title, text } = token;
    return figureHtml({ d1x: href, d1xJpg: href, d2x: href, width: "", height: "" }, text || title);
  };

  renderer.link = function (token) {
    const href = token.href || "";
    const external = /^https?:/i.test(href);
    return `<a class="ulink" href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${this.parser.parseInline(token.tokens)}</a>`;
  };

  const html = marked.parse(src, { renderer, gfm: true, breaks: false });
  return { html, headings };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 4. articles                                                           */
/* ══════════════════════════════════════════════════════════════════════ */

function loadArticles(pages, site, problems, log) {
  const files = walk(SRC_ARTICLES).filter((f) => /\.(md|markdown)$/i.test(f));
  const items = [];
  const slugSeen = new Map();
  const sectionKeys = SECTIONS.map((s) => s.key);
  const today = new Date().toISOString().slice(0, 10);
  const slugs = Object.keys(pages);

  for (const file of files) {
    const name = path.basename(file);
    const raw = fs.readFileSync(file, "utf8");
    const { data, body, hadBom } = parseFrontMatter(raw);
    const base = name.replace(/\.(md|markdown)$/i, "");
    const slug = slugify(data.slug || base);
    const title = (data.title || "").trim();
    const date = (data.date || "").trim() || fs.statSync(file).mtime.toISOString().slice(0, 10);

    // A BOM is stripped automatically, but say so — it usually means the file
    // was written by Notepad or PowerShell, and it is worth knowing.
    if (hadBom) problems.warn(`${name}: 文件带 UTF-8 BOM（记事本常见），已自动忽略`);

    // ---- validation -------------------------------------------------
    if (!title) problems.error(name, "缺 title —— 杂志的每一页都需要一个标题");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      problems.error(name, `date 必须是 YYYY-MM-DD，现在是 “${date}”`);
    } else if (date > today) {
      problems.warn(`${name}: date 是 ${date}，晚于今天`);
    }
    if (slugSeen.has(slug)) {
      problems.error(name, `slug "${slug}" 与 ${slugSeen.get(slug)} 冲突，给其中一篇加 slug: <别的名字>`);
    } else {
      slugSeen.set(slug, name);
    }

    const section = (data.section || "").trim() || SECTIONS[0].key;
    if (!sectionKeys.includes(section)) {
      problems.error(name, `section "${section}" 不是合法栏目。可选：${sectionKeys.join(" / ")}`);
    }

    // cover is the one hard requirement: the model is one article, one image
    let cover = (data.cover || "").trim();
    if (!cover) {
      const free = slugs.filter((s) => !items.some((a) => a.cover === s));
      problems.error(
        name,
        "缺 cover。把图片放进 _images/ 再写 cover: <文件名>\n" +
        `        还没被用过的图：${free.slice(0, 8).join(", ")}${free.length > 8 ? " …" : ""}`
      );
    } else if (!pages[cover]) {
      const guess = nearMiss(cover, slugs);
      problems.error(
        name,
        `cover "${cover}" 找不到这张图。` +
        (guess.length ? `是不是想写：${guess.join(" / ")} ？` : `现有：${slugs.slice(0, 6).join(", ")} …`)
      );
      cover = "";
    }

    const coverImg = cover ? pages[cover] : null;
    const pullCount = { n: 0 };
    const { html, headings } = renderMarkdown(body, { pages, articleSlug: slug, problems, pullCount });
    // prose chunks interleaved with full-bleed blocks; see splitBleed()
    const chunks = splitBleed(html);

    let summary = (data.summary || "").trim();
    if (!summary) {
      const first = /<p>([\s\S]*?)<\/p>/.exec(html);
      summary = first ? first[1].replace(/<[^>]+>/g, "").trim().slice(0, 84) : "";
    }

    const chars = body.replace(/\s+/g, "").length;
    const explicitLead = (data.lead || "").trim();
    items.push({
      slug, title, date, section,
      issue: deriveIssue(date, site),
      tags: data.tags || [],
      summary,
      standfirst: (data.standfirst || "").trim(),
      kicker: (data.kicker || "").trim(),
      author: (data.author || site.author).trim(),
      credits: (data.credits || "").trim(),
      lead: explicitLead,
      cover: cover || "",
      coverImg,
      pull: pullCount.n,
      feature: String(data.feature || "").toLowerCase() === "true",
      minutes: Math.max(1, Math.round(chars / 400)),
      chars,
      html,
      chunks,
      hasLead: Boolean(explicitLead),
      headings: headings.filter((h) => h.level === 2)
    });
    log(`  ${name} → /articles/${slug}/  ${section} · ${chars} 字${cover ? "" : "  ⚠ 无封面"}`);
  }

  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return items;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 5. shared chrome                                                      */
/* ══════════════════════════════════════════════════════════════════════ */

function head(site, { title, desc, canonical, type = "website", jsonld, image }) {
  const full = title === site.title ? title : `${title} — ${site.title}`;
  return `<!doctype html>
<html lang="${site.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(desc || site.tagline)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="#F9F8F6">
<meta name="color-scheme" content="light">
<meta property="og:site_name" content="${esc(site.title)}">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(desc || site.tagline)}">
<meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(site.origin + image)}">` : ""}
<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${CSS.map((n) => `<link rel="stylesheet" href="/assets/${n}.css">`).join("\n")}
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
</head>
<body>
<a class="skip" href="#main">跳到正文</a>`;
}

/** Running masthead. The issue line sits centred on wide screens, like the
 *  running head of a printed page. */
function mast(site, active, issue) {
  const link = (href, text, key) =>
    `<a class="navlink" href="${href}"${active === key ? ' aria-current="page"' : ""}>${text}</a>`;
  return `
<header class="masthead">
  <div class="shell masthead__in">
    <a class="wordmark" href="/">${esc(site.title)}</a>
    ${issue ? `<span class="masthead__issue label" aria-hidden="true">${esc(issue.short)}</span>` : ""}
    <nav class="masthead__nav" aria-label="主导航">
      ${link("/contents/", "目录", "contents")}
      ${link("/archive/", "往期", "archive")}
      ${link("/about/", "本刊", "about")}
    </nav>
  </div>
</header>`;
}

function foot(site, issue) {
  return `
<footer class="colophon">
  <div class="shell">
    <div class="colophon__grid">
      <span class="wordmark">${esc(site.title)}</span>
      <p class="colophon__note">${esc(site.tagline)} 界面为纯单色，颜色全部来自图片。</p>
      <p class="colophon__note">${issue ? esc(issue.title) + " · " : ""}<a class="ulink" href="https://github.com/fengzishiyi/fengzishiyi.github.io">GitHub</a> · <a class="ulink" href="/sitemap.xml">Sitemap</a> · <span class="meta">© ${new Date().getFullYear()} ${esc(site.author)}</span></p>
    </div>
  </div>
</footer>
<script src="/assets/site.js" defer></script>
</body>
</html>`;
}

/** The lightbox is still the accessible presentation of every image: the cover
 *  and each inline figure can be opened full size. */
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

/** Monochrome plate used when an article has no usable cover. Deliberately
 *  plain: it must never look like a design choice. */
function coverPlate(text) {
  return `<div class="cover-plate"><span class="cover-plate__text">${esc(text)}</span></div>`;
}

const dateDots = (d) => String(d).replace(/-/g, ".");

/* ══════════════════════════════════════════════════════════════════════ */
/* 6. pages                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

function pageCover(site, issues, articles) {
  const issue = issues[0];
  const feature = issue && issue.feature;
  const rest = issue ? issue.articles.filter((a) => !feature || a.slug !== feature.slug) : [];

  const nameplate = `<h1 class="nameplate">${esc(site.title)}</h1>`;

  const rail = issue ? `
      <div class="cover__rail">
        <p class="cover__inthis">本期还有</p>
        <ul class="cover__rail-list">
${rest.slice(0, 4).map((a) => `          <li>
            <span class="cover__rail-num" aria-hidden="true">${String(issue.articles.indexOf(a) + 1).padStart(2, "0")}</span>
            <a class="cover__rail-title" href="/articles/${esc(a.slug)}/">${esc(a.title)}</a>
          </li>`).join("\n")}
        </ul>
        <a class="ulink label label--plain cover__rail-more" href="/contents/">全部目录 →</a>
      </div>` : `
      <div class="cover__rail">
        <p class="cover__inthis">还没有文章</p>
        <p class="issue__note">把 <span class="meta">.md</span> 放进 <span class="meta">_articles/</span>，
        或运行 <span class="meta">npm run new -- "标题"</span> 生成一篇草稿。</p>
      </div>`;

  const featureHtml = feature ? `
      <a class="feature" href="/articles/${esc(feature.slug)}/">
        <span class="feature__frame"${feature.coverImg ? ` style="--art:${feature.coverImg.ratio}"` : ""}>${
          feature.coverImg
            ? picture(feature.coverImg, { sizes: "(min-width: 900px) 58vw, 100vw", eager: true })
            : coverPlate("这一篇还没有封面图")
        }</span>
        <p class="feature__kicker">${esc(feature.section)}${feature.kicker ? " · " + esc(feature.kicker) : ""}</p>
        <h2 class="feature__title">${esc(feature.title)}</h2>
        ${feature.standfirst ? `<p class="feature__deck">${esc(feature.standfirst)}</p>` : ""}
        <p class="feature__meta">${esc(dateDots(feature.date))} · ${feature.chars} 字 · 约 ${feature.minutes} 分钟</p>
      </a>` : "";

  return `${head(site, {
    title: site.title,
    desc: site.tagline,
    canonical: `${site.origin}/`,
    image: feature && feature.coverImg ? feature.coverImg.d1x : undefined,
    jsonld: {
      "@context": "https://schema.org", "@type": "WebSite",
      name: site.title, url: site.origin, inLanguage: site.lang
    }
  })}
${mast(site, "cover", issue)}
<main id="main" class="shell cover">
  <div class="cover__masthead">
    <span class="label label--ink">${esc(site.subtitle)}</span>
    ${issue ? `<span class="cover__issue">${esc(issue.title)} · ${esc(issue.label)}</span>` : `<span class="cover__issue">创刊号待定</span>`}
  </div>

  ${nameplate}
  <p class="cover__tagline">${esc(site.tagline)}</p>

  <div class="cover__grid">
${rail}
${featureHtml}
  </div>

  <div class="cover__foot">
    <span class="label">共 ${articles.length} 篇 · ${issues.length} 期</span>
    <span class="label"><a class="ulink" href="/contents/">目录</a> · <a class="ulink" href="/archive/">往期</a></span>
  </div>
</main>
${foot(site, issue)}`;
}

function pageContents(site, issues, articles) {
  const issue = issues[0];
  const grouped = SECTIONS.map((s) => ({
    ...s,
    articles: issue ? issue.articles.filter((a) => a.section === s.key) : []
  })).filter((s) => s.articles.length);

  const bodyHtml = grouped.length ? `<ol class="toc">
${grouped.map((dept, di) => `    <li class="toc__dept">
      <div class="toc__dept-head">
        <span class="toc__dept-num" aria-hidden="true">${String(di + 1).padStart(2, "0")}</span>
        <h2 class="toc__dept-name">${esc(dept.key)}</h2>
        <span class="toc__dept-count label">${dept.articles.length} 篇</span>
      </div>
      <ul class="toc__list">
${dept.articles.map((a, i) => `        <li class="toc__item">
          <a class="toc__link" href="/articles/${esc(a.slug)}/">
            <span class="toc__title">${esc(a.title)}</span>
            <span class="toc__meta"><span class="label">${esc(a.section)}</span><span class="meta">${esc(dateDots(a.date))}</span></span>
            ${a.summary ? `<span class="toc__deck">${esc(a.summary)}</span>` : ""}
          </a>
        </li>`).join("\n")}
      </ul>
    </li>`).join("\n")}
  </ol>` : `<p class="empty">这一期还没有内容。运行 <span class="meta">npm run new -- "标题"</span> 开始第一篇。</p>`;

  return `${head(site, {
    title: "目录",
    desc: issue ? `${issue.title} 目录` : "目录",
    canonical: `${site.origin}/contents/`
  })}
${mast(site, "contents", issue)}
<main id="main" class="shell contents">
  <div class="section-head">
    <h1 class="page-title">目录</h1>
    <span class="label">${issue ? esc(issue.title) : "尚未成刊"} · 共 ${articles.length} 篇</span>
  </div>
  <div style="padding-top:var(--gap-tight)">
    ${bodyHtml}
  </div>
  ${issues.length > 1 ? `<div class="crosslinks"><a class="ulink label label--plain" href="/archive/">查看往期（${issues.length} 期）→</a></div>` : ""}
</main>
${foot(site, issue)}`;
}

function pageArchive(site, issues) {
  const html = issues.length ? issues.map((iss) => `
  <section class="issue" aria-labelledby="iss-${esc(iss.id)}">
    <div class="issue__grid">
      <div>
        <h2 class="issue__label" id="iss-${esc(iss.id)}">${esc(iss.title)}${iss.override && iss.override.label ? ` · ${esc(iss.override.label)}` : ""}</h2>
        <p class="issue__dates">${esc(iss.label)} · ${iss.articles.length} 篇 · ${esc(iss.range)}</p>
        ${iss.note ? `<p class="issue__note">${esc(iss.note)}</p>` : ""}
        ${iss.coverSlug ? `<a class="issue__cover" href="/articles/${esc(iss.feature.slug)}/" aria-label="${esc(iss.feature.title)}">${
          picture(iss.feature.coverImg, { sizes: "(min-width: 860px) 30vw, 100vw" })
        }</a>` : ""}
      </div>
      <ol class="issue__list">
${iss.articles.map((a, i) => `        <li>
          <span class="issue__list-num" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span>
          <a class="issue__list-title" href="/articles/${esc(a.slug)}/">${esc(a.title)}<span class="label"> ${esc(a.section)}</span></a>
        </li>`).join("\n")}
      </ol>
    </div>
  </section>`).join("\n") : `<p class="empty">还没有任何一期。</p>`;

  return `${head(site, {
    title: "往期",
    desc: "所有期号，从最新往前。",
    canonical: `${site.origin}/archive/`
  })}
${mast(site, "archive", issues[0])}
<main id="main" class="shell archive">
  <div class="section-head">
    <h1 class="page-title">往期</h1>
    <span class="label">${issues.length} 期</span>
  </div>
${html}
</main>
${foot(site, issues[0])}`;
}

function pageArticle(site, a, issue, prev, next) {
  const side = [
    `<div class="article__side-block">
      <div class="deflist">
        <div class="deflist__row"><span class="deflist__k">栏目</span><span class="deflist__v">${esc(a.section)}</span></div>
        <div class="deflist__row"><span class="deflist__k">日期</span><span class="deflist__v"><time datetime="${esc(a.date)}">${esc(dateDots(a.date))}</time></span></div>
        <div class="deflist__row"><span class="deflist__k">篇幅</span><span class="deflist__v">${a.chars} 字 · 约 ${a.minutes} 分钟</span></div>
        <div class="deflist__row"><span class="deflist__k">作者</span><span class="deflist__v">${esc(a.author)}</span></div>
      </div>
    </div>`
  ];
  if (a.coverImg && (a.coverImg.title || a.coverImg.creator)) {
    side.push(`<div class="article__side-block">
      <p class="label" style="margin:0 0 8px">封面</p>
      <p class="toc__deck" style="margin:0">${esc([a.coverImg.title, a.coverImg.creator].filter(Boolean).join(" / "))}</p>
    </div>`);
  }
  if (a.credits) {
    side.push(`<div class="article__side-block"><p class="label" style="margin:0 0 8px">署名</p><p class="toc__deck" style="margin:0">${esc(a.credits)}</p></div>`);
  }
  if (a.tags.length) {
    side.push(`<div class="article__side-block"><ul class="tags">${a.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`);
  }
  if (a.headings.length >= 2) {
    side.push(`<div class="article__side-block">
      <p class="label" style="margin:0 0 8px">本篇</p>
      <nav class="tocmini" aria-label="本篇小节">${a.headings.map((h) =>
        `<div class="tocmini__row"><a href="#${esc(h.id)}">${esc(h.text)}</a></div>`).join("")}</nav>
    </div>`);
  }

  const pager = `<nav class="pager" aria-label="文章翻页">
    ${prev ? `<a class="pager__link pager__link--prev" href="/articles/${esc(prev.slug)}/"><span class="pager__arrow">←</span><span>${esc(prev.title)}</span></a>` : "<span></span>"}
    ${next ? `<a class="pager__link" href="/articles/${esc(next.slug)}/"><span>${esc(next.title)}</span><span class="pager__arrow">→</span></a>` : "<span></span>"}
  </nav>
  <div class="crosslinks"><a class="ulink label label--plain" href="/contents/">← 回到目录</a></div>`;

  const tallArt = a.coverImg && a.coverImg.ratio < 1.2;
  /* The reading grid owns the prose; full-bleed blocks are hoisted out of it so
     they can reach the viewport edges (see bleedHtml). The pager goes inside
     the last prose chunk so it stays in the reading column. */
  const openerHtml = tallArt
    ? `<header class="opener opener--paper">
      <span class="opener__fig">${picture(a.coverImg, { sizes: "100vw", eager: true, interactive: true, alt: a.coverImg.alt || a.title })}</span>
      <div class="shell opener__text">
        <p class="opener__kicker">${esc(a.section)}${a.kicker ? " · " + esc(a.kicker) : ""}${
          issue ? ` · ${esc(issue.short)}` : ""}</p>
        <h1 class="opener__title">${esc(a.title)}</h1>
        ${a.standfirst ? `<p class="opener__deck">${esc(a.standfirst)}</p>` : ""}
        <ul class="opener__byline">
          <li>${esc(a.author)}</li>
          <li><time datetime="${esc(a.date)}">${esc(dateDots(a.date))}</time></li>
          <li>${a.chars} 字 · 约 ${a.minutes} 分钟</li>
        </ul>
      </div>
    </header>`
    : `<header class="opener">
      ${a.coverImg
        ? `${picture(a.coverImg, { cls: "opener__img", sizes: "100vw", eager: true, interactive: true, alt: a.coverImg.alt || a.title })}<span class="opener__scrim" aria-hidden="true"></span>`
        : `<span class="opener__scrim" aria-hidden="true" style="height:100%"></span>`}
      <div class="shell opener__text">
        <p class="opener__kicker">${esc(a.section)}${a.kicker ? " · " + esc(a.kicker) : ""}${
          issue ? ` · ${esc(issue.short)}` : ""}</p>
        <h1 class="opener__title">${esc(a.title)}</h1>
        ${a.standfirst ? `<p class="opener__deck">${esc(a.standfirst)}</p>` : ""}
        <ul class="opener__byline">
          <li>${esc(a.author)}</li>
          <li><time datetime="${esc(a.date)}">${esc(dateDots(a.date))}</time></li>
          <li>${a.chars} 字 · 约 ${a.minutes} 分钟</li>
        </ul>
      </div>
    </header>`;
  const bodyHtml = (a.chunks && a.chunks.length ? a.chunks : [`<div class="prose">${a.html}</div>`])
    .map((chunk, i, arr) => {
      const isBleed = chunk.startsWith('<div class="fig-bleed"');
      if (isBleed) return chunk;
      const tail = i === arr.length - 1 ? pager : "";
      return `<div class="shell article__body">
      <div class="article__main prose${a.hasLead ? " prose--has-lead" : ""}">
        ${i === 0 && a.lead ? `<p class="lead">${esc(a.lead)}</p>` : ""}
${chunk}
${tail}
      </div>
      <aside class="article__side">
${side.join("\n")}
      </aside>
    </div>`;
    }).join("\n\n");

  return `${head(site, {
    title: a.title,
    desc: a.summary,
    canonical: `${site.origin}/articles/${a.slug}/`,
    type: "article",
    image: a.coverImg ? a.coverImg.d1x : undefined,
    jsonld: {
      "@context": "https://schema.org", "@type": "Article",
      headline: a.title, datePublished: a.date, inLanguage: site.lang,
      author: { "@type": "Person", name: a.author },
      description: a.summary,
      ...(a.coverImg ? { image: site.origin + a.coverImg.d1x } : {})
    }
  })}
${mast(site, "contents", issue)}
<main id="main" class="article">
  <article>
    ${openerHtml}

${bodyHtml}
  </article>
</main>
${lightboxHtml()}
${foot(site, issue)}`;
}

function pageAbout(site, issues, articles, pages) {
  const n = Object.keys(pages).length;
  return `${head(site, {
    title: "本刊",
    desc: "关于这本杂志，以及它为什么长成现在这样。",
    canonical: `${site.origin}/about/`
  })}
${mast(site, "about", issues[0])}
<main id="main" class="shell article" style="padding-top:calc(var(--nav-h) + 72px)">
  <article>
    <div class="article__body" style="padding-top:0">
      <div class="article__main prose">
        <h1 class="page-title" style="margin-bottom:0.4em">本刊</h1>
        <p class="lead">一本只有一个人的杂志。封面、目录、栏目、跨页，都按印刷刊物的规矩来。</p>
        <p>这里按<strong>期号</strong>组织内容：年份是卷，月份是期。每一期里有若干栏目，每个栏目下是文章。一篇文章就是一页，有自己的封面图、标题、导语与正文。</p>
        <h2 id="how">怎么办刊</h2>
        <p>没有框架，没有构建服务，没有网络字体。一套 Node 脚本把 <code>_images/</code> 里的原图压成 WebP，把 <code>_articles/</code> 里的 markdown 排成页面，然后把结果推到这个仓库的根目录。</p>
        <ul>
          <li>字体：系统衬线体（中文回退到宋体）配系统无衬线体，零网络请求。</li>
          <li>配色：只有暖米色的底和柔和的黑，加上一串黑的不同深度。<em>颜色全部来自图片。</em></li>
          <li>冲击力来自字号落差、不对称栏位与整版出血，不来自阴影、渐变或圆角。</li>
        </ul>
        <h2 id="colophon">版本信息</h2>
        <div class="deflist">
          <div class="deflist__row"><span class="deflist__k">期数</span><span class="deflist__v">${issues.length}</span></div>
          <div class="deflist__row"><span class="deflist__k">文章</span><span class="deflist__v">${articles.length} 篇</span></div>
          <div class="deflist__row"><span class="deflist__k">图片</span><span class="deflist__v">${n} 张</span></div>
          <div class="deflist__row"><span class="deflist__k">创刊</span><span class="deflist__v">${site.volumeStartYear}</span></div>
        </div>
        <p><a class="ulink" href="/contents/">目录</a> · <a class="ulink" href="/archive/">往期</a></p>
      </div>
      <aside class="article__side"></aside>
    </div>
  </article>
</main>
${foot(site, issues[0])}`;
}

function page404(site, issue) {
  return `${head(site, { title: "404", desc: "没有这一页。", canonical: `${site.origin}/404.html` })}
${mast(site, "", issue)}
<main id="main" class="shell" style="padding-top:calc(var(--nav-h) + 140px);padding-bottom:var(--sec-y)">
  <h1 class="display" style="font-size:var(--fs-display);margin:0 0 24px">这一页<br>从来没有过。</h1>
  <p class="cover__tagline">或者它被删掉了。<em>猜不到的话，翻回封面。</em></p>
  <div class="crosslinks" style="margin-top:40px">
    <a class="ulink label label--plain" href="/">封面 →</a>
    <a class="ulink label label--plain" href="/contents/">目录</a>
    <a class="ulink label label--plain" href="/archive/">往期</a>
  </div>
</main>
${foot(site, issue)}`;
}

/** Old /images/ address. The wall is gone, so the URL becomes a redirect —
 *  meta refresh plus a real link, so it works with and without JS, and a
 *  canonical so search engines consolidate onto the archive. */
function pageImageRedirect(site, issue) {
  return `<!doctype html>
<html lang="${site.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>图片来源已改版 — ${esc(site.title)}</title>
<meta http-equiv="refresh" content="0; url=/archive/">
<link rel="canonical" href="${site.origin}/archive/">
<meta name="robots" content="noindex,follow">
${CSS.map((n) => `<link rel="stylesheet" href="/assets/${n}.css">`).join("\n")}
</head>
<body>
${mast(site, "", issue)}
<main id="main" class="shell" style="padding-top:calc(var(--nav-h) + 120px)">
  <h1 class="page-title">图片来源已改版</h1>
  <p class="page-intro__sub">现在没有单独的图片板块了 —— 每张图都归属于它所在的那篇文章。</p>
  <div class="crosslinks" style="margin-top:32px">
    <a class="ulink label label--plain" href="/archive/">去往期 →</a>
    <a class="ulink label label--plain" href="/contents/">目录</a>
  </div>
</main>
${foot(site, issue)}`;
}

function favicon(site) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="#F9F8F6"/>
<text x="32" y="44" font-family="Georgia,serif" font-size="36" fill="#1C1C1C" text-anchor="middle">${esc(site.title.slice(0, 1))}</text>
</svg>`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 7. design-rule assertion                                              */
/* ══════════════════════════════════════════════════════════════════════ */

function luminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function checkDesign(log) {
  // Strip comments first: the rules are documented in prose above the CSS, and
  // an assertion that trips on its own documentation is worse than none.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  // Print is the one place pure black on white is right.
  const forScreen = (s) => s.replace(/@media\s+print\s*\{[\s\S]*?\n\}/g, "");
  const css = forScreen(strip(CSS.map((n) => fs.readFileSync(path.join(ASSETS, `${n}.css`), "utf8")).join("\n")));
  const js = strip(fs.readFileSync(path.join(ASSETS, "site.js"), "utf8"));
  const self = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const failures = [];

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

  // Heading rules must be serif. The selector must be matched as a real
  // heading selector — bare `h2` after a combinator or paren — or the pattern
  // trips on class names that merely contain it (`.issue__label`).
  for (const block of css.match(/(?:^|[\s,>+~(])(?:h[1-6])(?:[^{]*?)\{[^}]*\}/g) || []) {
    if (/font-family/.test(block) && !/serif/.test(block)) {
      failures.push(`a heading sets a non-serif family: ${block.slice(0, 70).replace(/\s+/g, " ")}…`);
    }
  }

  // Contrast, measured on the values that actually render (pre-composited hex).
  const hex = (name, fallback) => {
    const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(css);
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const paper = hex("paper", [0xf9, 0xf8, 0xf6]);
  for (const [name, comp, need] of [
    ["body  --ink-80", hex("ink-80", [0x49, 0x49, 0x48]), 4.5],
    ["label --ink-60", hex("ink-60", [0x6a, 0x6a, 0x69]), 4.5],
    ["decor --ink-40", hex("ink-40", [0xb0, 0xb0, 0xae]), 0]
  ]) {
    const r = contrast(comp, paper);
    const ok = r >= need;
    log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(14)} ${r.toFixed(2)}:1${need ? `  (AA needs ${need})` : "  (decorative)"}`);
    if (!ok) failures.push(`${name} measures ${r.toFixed(2)}:1, below WCAG AA`);
  }

  // Structural — the magazine's bones, asserted so a later edit cannot quietly
  // flatten the design back into a blog.
  if (!/--fs-nameplate/.test(css)) failures.push("the nameplate scale token is missing — the cover loses its impact");
  if (!/\.nameplate\s*\{[^}]*var\(--fs-nameplate\)/.test(css)) failures.push("the nameplate no longer uses the display scale token");
  if (!/\.opener__title\s*\{[^}]*var\(--fs-display\)/.test(css)) failures.push("the article opener title no longer uses the display scale");
  if (!/\(100vw - 100%\) \/ -2/.test(css)) failures.push("the full-bleed offset recipe is missing");
  if (!/prefers-reduced-motion/.test(css)) failures.push("no prefers-reduced-motion fallback");
  if (!/aria-pressed/.test(js)) failures.push("the lightbox zoom toggle has no aria-pressed state");
  if (self.indexOf('class="opener"') === -1) failures.push("the article opener markup is gone");
  if (self.indexOf("http-equiv=\"refresh\"") === -1) failures.push("the /images/ redirect page is gone");

  // Editorial hierarchy: display and body must stay far apart. If someone
  // later sets the title to body size, the page stops reading as a magazine.
  const fsOf = (name) => {
    const m = new RegExp(`--${name}:\\s*clamp\\(([^,]+),`).exec(css);
    if (!m) return NaN;
    return parseFloat(m[1]) * 16;   // rem → px
  };
  const display = fsOf("fs-display");
  const body = /--fs-body:\s*([\d.]+)rem/.exec(css);
  if (Number.isFinite(display) && body) {
    const ratio = display / (parseFloat(body[1]) * 16);
    const ok = ratio >= 2;
    log(`  ${ok ? "ok  " : "FAIL"} display/body ratio ${ratio.toFixed(1)}× (editorial needs ≥2)`);
    if (!ok) failures.push(`display/body ratio is only ${ratio.toFixed(1)}× — too flat to read as editorial`);
  }

  return failures;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 8. publish                                                            */
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

/** Paths the build never touches — sources and config live alongside the output
 *  in the published root, so the prune pass must know to leave them alone. */
const PRIVATE = new Set([
  ".git", ".github", "node_modules", ".build", ".shots", "src", "_articles", "_images", "_issues",
  "package.json", "package-lock.json", "README.md", "DESIGN-NOTES.md", "LICENSE"
]);
const isPrivate = (name) => PRIVATE.has(name) || name.startsWith("_") || name.startsWith(".");

/** Delete anything in the published root that the build no longer emits.
 *
 *  Without this, a renamed or deleted asset survives for ever: publish() only
 *  writes and mirrors, so `assets/wall.css` kept being served long after the
 *  image wall it styled was removed. Only files are considered for deletion —
 *  a deleted directory needs no explicit handling here. */
function prunePublished(log) {
  let removed = 0;
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (isPrivate(e.name)) continue;
    if (!e.isFile()) continue;
    if (exists(path.join(STAGE, e.name))) continue;
    fs.rmSync(path.join(ROOT, e.name), { force: true });
    log(`  pruned      ${e.name}（构建已不再产出）`);
    removed++;
  }
  return removed;
}

function publish(log) {
  // Assets are authored, not generated, so they are re-read from src/ on every
  // build. They are ALSO copied into the stage, so `serve` can present the stage
  // alone and what you preview is byte-identical to what gets published.
  const stageAssets = path.join(STAGE, "assets");
  // wipe first: a renamed stylesheet must not survive in the stage either
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
    if (rel === "assets") continue;      // handled above
    const src = path.join(STAGE, rel);
    const dst = path.join(ROOT, rel);
    if (!exists(src)) { rm(dst); continue; }
    if (fs.statSync(src).isDirectory()) mirrorDir(src, dst);
    else { ensure(path.dirname(dst)); fs.copyFileSync(src, dst); }
  }

  const missing = MANAGED.filter((r) => !exists(path.join(ROOT, r)));
  if (missing.length) throw new Error(`publish left these unpublished: ${missing.join(", ")}`);

  const removed = prunePublished(log);
  log(`  published → repo root (${MANAGED.length} paths verified${removed ? `, ${removed} stale file(s) pruned` : ""})`);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* 9. main                                                               */
/* ══════════════════════════════════════════════════════════════════════ */

async function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check-only");
  const contentOnly = argv.includes("--content-only");
  const log = (s) => console.log(s);

  if (argv.includes("--clean")) {
    rm(STAGE);
    for (const rel of MANAGED) rm(path.join(ROOT, rel));
    log("cleaned");
    if (!checkOnly && !contentOnly) return;
  }

  const t0 = Date.now();
  const site = loadSite();

  log("▸ 图片");
  rm(STAGE);
  ensure(STAGE);
  const { pages, order } = await buildImages(log);

  const problems = new Problems();

  log("▸ 文章");
  const articles = loadArticles(pages, site, problems, log);

  log("▸ 期号");
  const issues = groupIssues(articles, site, loadIssueOverrides(log), problems, log);

  const urls = ["/", "/contents/", "/archive/", "/about/", ...articles.map((a) => `/articles/${a.slug}/`)];

  if (contentOnly) {
    problems.report(log, "✗ 内容有问题");
    log(problems.failed ? "" : "\n✓ 内容检查通过");
    process.exit(problems.failed ? 1 : 0);
  }

  log("▸ 生成页面");
  write("index.html", pageCover(site, issues, articles));
  write("contents/index.html", pageContents(site, issues, articles));
  write("archive/index.html", pageArchive(site, issues));
  articles.forEach((a, i) => {
    const iss = issues.find((x) => x.articles.includes(a)) || null;
    write(path.join("articles", a.slug, "index.html"),
      pageArticle(site, a, iss, articles[i + 1] || null, articles[i - 1] || null));
  });
  write("about/index.html", pageAbout(site, issues, articles, pages));
  write("404.html", page404(site, issues[0]));
  write("images/index.html", pageImageRedirect(site, issues[0]));
  write("favicon.svg", favicon(site));
  write(".nojekyll", "");

  write("sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map((u) => `  <url><loc>${site.origin}${u}</loc></url>`).join("\n")
    }\n</urlset>\n`);
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${site.origin}/sitemap.xml\n`);

  write("images/manifest.json", JSON.stringify({
    site,
    order,
    issues: issues.map((i) => ({ id: i.id, title: i.title, label: i.label, count: i.articles.length })),
    articles: articles.map((a) => ({
      slug: a.slug, title: a.title, section: a.section, date: a.date,
      cover: a.cover, coverLqip: a.coverImg ? a.coverImg.lqip : "", coverAlt: a.coverImg ? a.coverImg.alt : ""
    })),
    pages
  }, null, 2) + "\n");

  log("▸ 风格断言");
  const failures = checkDesign(log);

  if (checkOnly) {
    problems.report(log, "✗ 内容有问题");
    log(failures.length ? `\n✗ ${failures.length} 项风格断言失败` : "\n✓ 风格断言通过");
    process.exit(failures.length || problems.failed ? 1 : 0);
  }

  problems.report(log, "✗ 内容有问题");

  const imgBytes = Object.values(pages).reduce((n, p) => n + p.bytes, 0);
  log("▸ 体积");
  log(`  原图        ${(Object.values(pages).reduce((n, p) => n + p.original.bytes, 0) / 1048576).toFixed(1)} MB`);
  log(`  产物图      ${(imgBytes / 1048576).toFixed(2)} MB`);
  const shipped = ["tokens.css", "base.css", "spread.css", "article.css", "lightbox.css", "site.js"];
  log(`  css + js    ${(shipped.reduce((n, f) => n + fs.statSync(path.join(ASSETS, f)).size, 0) / 1024).toFixed(1)} KB`);

  if (failures.length || problems.failed) {
    log("\n✗ 构建未发布任何文件（上一版仍然在线）：");
    failures.forEach((f) => log("   · " + f));
    process.exit(1);
  }

  publish(log);

  const files = walk(STAGE).length;
  log(`\n✓ 构建完成：${files} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  ${issues.length} 期 · ${articles.length} 篇 · ${Object.keys(pages).length} 张图`);
}

main().catch((e) => {
  console.error("\n✗ 构建失败:", e.message);
  process.exit(1);
});
