/**
 * templates.mjs — every page shape, as pure functions.
 *
 * Layout notes that are not obvious from the markup:
 *
 *  · There is no fixed navbar. On a long-form reading site a sticky chrome bar
 *    is a permanent tax on attention, so the header scrolls away and the reader
 *    gets a compact toolbar that only appears once they start moving — the
 *    theme/size/measure controls have to be reachable, but never in the way.
 *
 *  · Article pages carry one inert <template id="pv-slug"> per outbound
 *    `{{ref:}}`, which is what the hover preview reads. The preview never makes
 *    a request: the fragment it shows was rendered at build time, together with
 *    the page that links to it. A `.ref` whose template is missing fails the
 *    build, because the silent failure is a hover that does nothing at all.
 *
 *  · The article page is a two-column grid: a narrow rail for the outline and
 *    backlinks, and the reading measure beside it. Sidenotes float into the
 *    rail from inside the prose via CSS, so the note text lives in the document
 *    where it belongs and never needs JavaScript to be readable.
 */

import { esc, plain, dateDots, dateLong, accentFor } from "./lib.mjs";
import { sizesFor } from "./images.mjs";
import { DOMAINS, STATUSES, CONFIDENCES, statusByKey, confidenceByKey, domainByKey } from "./taxonomy.mjs";

/* ══════════════════════════════════════════════════════════════════════ */
/* chrome                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

export const CSS = ["tokens", "base", "grid", "prose", "components", "search", "motion"];

/* ══════════════════════════════════════════════════════════════════════ */
/* navigation                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * The nav labels, in order. chester.how runs `Chester · Projects · Writing ·
 * Reading · Hobbies`; Projects is dropped by request, and Tags/About take its
 * place so a text-only site has somewhere to browse by topic.
 *
 * This array is the single source of truth — the build asserts the rendered
 * nav matches it exactly, so a label cannot drift by accident.
 */
export const NAV = [
  { key: "home", href: "/", text: "首页" },
  { key: "writing", href: "/writing/", text: "写作" },
  { key: "reading", href: "/reading/", text: "阅读" },
  { key: "hobbies", href: "/hobbies/", text: "爱好" },
  { key: "tags", href: "/tags/", text: "标签" },
  { key: "about", href: "/about/", text: "关于" }
];

/**
 * The document head, and the one place `data-accent` is written.
 *
 * Every page states which chip pair it is coloured with — a domain's, a
 * collection's, or neutral — and all the coloured CSS reads `--accent-bg` /
 * `--accent-fg` from there. One writer, so a page can never be half-coloured.
 */
export function head(site, { title, desc, canonical, type = "website", jsonld, extraCss = [], headExtra = "", accent = "neutral" }) {
  const full = title === site.title ? title : `${title} — ${site.title}`;
  return `<!doctype html>
<html lang="${esc(site.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(desc || site.tagline)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="#FFFFFF">
<meta name="color-scheme" content="light">
<meta name="author" content="${esc(site.author)}">
<meta property="og:site_name" content="${esc(site.title)}">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${esc(full)}">
<meta property="og:description" content="${esc(desc || site.tagline)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${esc(site.title)}" href="/rss.xml">
${[...CSS, ...extraCss].map((n) => `<link rel="stylesheet" href="/assets/${n}.css">`).join("\n")}
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
${headExtra}
<!-- No analytics, no fonts, no CDN, no third-party script. See /about/ . -->
</head>
<body data-accent="${esc(accent)}">
<a class="skip" href="#main">跳到正文</a>`;
}

/**
 * Sticky frosted nav.
 *
 * The current page is marked by colour plus a blue ring, exactly as chester
 * does it — no moving parts, and nothing that only exists once scripting runs.
 */
export function nav(active) {
  return `
<div class="wrap">
  <nav class="nav" aria-label="主导航">
    <div class="nav__pill" data-nav-pill>
${NAV.map((n) => `      <a class="nav__link" href="${n.href}"${
        active === n.key ? ' aria-current="page"' : ""
      }>${esc(n.text)}</a>`).join("\n")}
    </div>
  </nav>
</div>`;
}

export function foot(site, { prev, next, reading = false } = {}) {
  return `
<footer class="foot">
  <div class="wrap">
    <nav class="foot__nav" aria-label="页脚导航">
${NAV.map((n) => `      <a href="${n.href}">${esc(n.text)}</a>`).join("\n")}
      <a href="/archive/">归档</a>
      <a href="/changelog/">更新</a>
      <a href="/series/">系列</a>
      <a href="/rss.xml">RSS</a>
    </nav>
    <p class="foot__note">
      ${esc(site.title)} · ${esc(site.subtitle)} ·
      <a href="/about/#license">${esc(site.license)}</a> ·
      <span class="meta">© ${new Date().getFullYear()} ${esc(site.author)}</span>
    </p>
    <p class="foot__note">
      正文是纯文本：没有图片、没有公式、没有代码高亮、没有第三方脚本、没有追踪。
    </p>
    ${prev || next ? `<nav class="foot__chrono" aria-label="相邻文章">
      ${next ? `<a rel="prev" href="${esc(next.url)}">← ${esc(next.title)}</a>` : ""}
      ${prev ? `<a rel="next" href="${esc(prev.url)}">${esc(prev.title)} →</a>` : ""}
    </nav>` : ""}
  </div>
</footer>
<script src="/assets/site.js" defer></script>
</body>
</html>`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* cards                                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

/* A thin arrow-up-right, stroked rather than filled — the glyph chester puts in
   the corner of every card. Every card here opens a page inside the site, so it
   is a decoration, not a second link; the stretched title link owns the click. */
const arrowSvg = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 13.5 13.5 6.5"></path><path d="M7.5 6.5h6v6"></path></svg>`;

/** One tag chip. Colour is a decoration, never the only carrier of meaning —
 *  the status name is always printed next to it. */
function chip(label, colour) {
  return `<span class="chip chip--${esc(colour || "neutral")}">${esc(label)}</span>`;
}

/**
 * Render one card.
 *
 * Every card links to a page inside this site — chester.how's cards point at
 * external projects, and that is the part being replaced.
 *
 * The card is NOT one big <a>. Its header carries a link of its own, and an
 * anchor inside an anchor is invalid HTML: the parser closes the outer one, the
 * DOM comes out restructured, and the card breaks its own layout — measured at
 * 883px wide inside a 390px grid, with the overflow hidden by the page. So the
 * card is a plain block holding TWO sibling links: the title link, and an
 * overlay pseudo-element on it that stretches over the whole card so the click
 * target is still the card rather than the words alone.
 */
/** The card grid's cell, with its entrance index.
 *
 *  `--i` drives the staggered fade-in: the index is capped in CSS (six steps)
 *  so a fifty-card grid does not end with a two-second queue. The index is
 *  emitted rather than derived from `:nth-child` because the entrance is per
 *  cell, and a wide card occupies two columns. */
export function card(item, size, index = 0) {
  const category = item.collectionName || item.domainName || "";
  const label = item.collectionName ? (item.statusName || item.kind || "") : (item.kind || "");
  const catHref = item.collection ? `/${item.collection}/` : `/${item.domain}/`;
  // A display-only card — a hobby tile — has nowhere to go, so it gets neither
  // a link nor the arrow that promises one. That is the reference's rule, and a
  // card that looks clickable but is not is worse than a plain one.
  const display = !item.url;

  const head = `<div class="card__head">
        <span>${display
          ? `${esc(category)}${label ? `&nbsp;·&nbsp;${esc(label)}` : ""}`
          : `<a class="card__cat" href="${esc(catHref)}">${esc(category)}</a>${label ? `&nbsp;·&nbsp;${esc(label)}` : ""}`
        }</span>
        ${display ? "" : `<span class="card__arrow">${arrowSvg}</span>`}
      </div>`;

  if (size === "intro") {
    return `<div class="cell cell--intro" style="--i:0">
      <div class="card card--intro">
        <div class="card__inner">
          <div class="card__text">
            ${item.h1 ? `<h1 class="card__h1">${item.h1}</h1>` : ""}
            ${item.introHtml || ""}
          </div>
        </div>
      </div>
    </div>`;
  }

  // Chips only where chester has them. Its Writing cards carry no chips at all —
  // header, title, date, text — while its Reading and Hobbies cards open with
  // coloured ones (READING / READ, FILTER / NOW BREWING). An article's tags used
  // to be printed here in neutral grey, which read as grey-on-grey and was not in
  // the reference; the tags still live on the article itself and on /tags/.
  //
  // A collection card gets its status in the collection's own accent, plus up to
  // two of its tags in the tag's own accent — which is what gives the reference's
  // coffee tiles their two differently-coloured chips, and keeps the rule that a
  // tag is the same colour wherever it appears.
  const chipList = [];
  if (item.collection && item.statusName) chipList.push(chip(item.statusName, item.chip));
  if (item.collection && Array.isArray(item.tags)) {
    for (const t of item.tags.slice(0, 2)) chipList.push(chip(t, accentFor(t)));
  }
  const chips = chipList.length ? `<div class="card__chips">${chipList.join("")}</div>` : "";

  const sub = item.author
    ? `<span class="card__sub">${esc(item.author)}${item.created ? ` · ${esc(item.created.slice(0, 4))}` : ""}</span>`
    : `<span class="card__sub">${esc(item.created || "")}</span>`;

  const bodyText = item.note || item.description || "";
  const body = bodyText ? `<p class="card__body">${esc(bodyText)}</p>` : "";

  const title = display
    ? `<h3 class="card__title">${esc(item.title)}</h3>`
    : `<h3 class="card__title"><a class="card__link stretched" href="${esc(item.url)}">${esc(item.title)}</a></h3>`;

  // ---- picture cards, as chester.how draws them -------------------------
  // Two variants, chosen by `card:` and read through `variantFor`:
  //
  //   card: image           a photograph with the title on it. Its film tiles:
  //                         the picture fills the cell, the category line sits
  //                         on top, and the title is a translucent caption at the
  //                         bottom that gains a dark ground on hover.
  //   card: image_and_text  a photograph BEHIND the text. Its plant tiles: the
  //                         picture covers the cell, the chips and title sit on a
  //                         gradient scrim, and hovering fades the scrim and
  //                         scales the picture so it comes forward.
  //
  // The picture is always `loading="lazy"` with its intrinsic width and height,
  // which is what keeps a grid of covers from reflowing as they arrive. The
  // caption prints the TITLE, not the alt text: an alt is what a screen reader
  // says in place of the picture, and printing it as visible copy both duplicates
  // it and tells a sighted reader something they can already see.
  const variant = variantFor(item);
  const picture = item.picture
    ? `<img class="card__img" src="${esc(item.picture.src)}" srcset="${esc(item.picture.srcset)}"
             sizes="${esc(sizesFor(size))}" width="${item.picture.width}" height="${item.picture.height}"
             alt="${esc(item.picture.alt || "")}" loading="lazy" decoding="async">`
    : "";

  if (variant === "photo") {
    return `<div class="cell cell--${esc(size)}" style="--i:${Math.min(index, 6)}">
    <div class="card card--photo${display ? " card--display" : ""}">
      <div class="card__inner">
        ${picture}
        ${head}
        <p class="card__caption">${esc(item.title)}</p>
      </div>
    </div>
  </div>`;
  }

  if (variant === "scrim") {
    return `<div class="cell cell--${esc(size)}" style="--i:${Math.min(index, 6)}">
    <div class="card card--photo card--scrim${display ? " card--display" : ""}">
      <div class="card__inner">
        ${picture}
        ${head}
        <div class="card__text">
          ${chips}
          ${title}
        </div>
      </div>
    </div>
  </div>`;
  }

  return `<div class="cell cell--${esc(size)}" style="--i:${Math.min(index, 6)}">
    <div class="card${display ? " card--display" : ""}">
      <div class="card__inner">
        ${head}
        <div class="card__text">
          ${chips}
          ${title}
          ${sub}
          ${body}
        </div>
      </div>
    </div>
  </div>`;
}

/** The whole grid. An empty grid says so rather than rendering nothing. */
export function masonry(cards) {
  if (!cards.length) {
    return `<div class="masonry"><p class="masonry__empty">还没有内容。把 .md 放进 _articles/ ，或运行 npm run new。</p></div>`;
  }
  return `<div class="masonry">\n${cards.join("\n")}\n</div>`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* article                                                               */
/* ══════════════════════════════════════════════════════════════════════ */

function metaBlock(a, { revisions }) {
  const status = statusByKey(a.status);
  const conf = confidenceByKey(a.confidence);
  const rows = [
    ["领域", `${a.domainName} · ${a.kind}`],
    ["始作", `<time datetime="${esc(a.created)}">${esc(dateLong(a.created))}</time>`],
    a.modified ? ["改订", `<time datetime="${esc(a.modified)}">${esc(dateLong(a.modified))}</time>`] : null,
    status ? ["状态", `<span class="status status--${esc(a.status)}">${esc(status.name)}</span>`] : null,
    conf ? ["把握", esc(conf.name)] : null,
    a.importance ? ["重要度", `${a.importance} / 10`] : null,
    a.series ? ["系列", `<a href="/series/${esc(a.series)}/">${esc(a.series)}</a>`] : null,
    ["篇幅", `${a.chars} 字`],
    ["修订", revisions && revisions.length ? `第 ${revisions.length} 版` : "—"]
  ].filter(Boolean);

  return `<dl class="meta-block">
${rows.map(([k, v]) => `    <div class="meta-block__row"><dt>${k}</dt><dd>${v}</dd></div>`).join("\n")}
  </dl>`;
}

/** A tag, as a chip in its own fixed colour, and a link to that tag's page.
 *
 *  The colour is a hash of the name, so 纯文本 is the same tint on the tag index,
 *  on the article rail and in the search results — the point of colour here is
 *  that a reader can recognise a tag before reading it, and that only works if
 *  the mapping never moves. See `accentFor` in lib.mjs. */
const tagChip = (t) =>
  `<li><a class="taglink" href="/tags/${encodeURIComponent(t)}/">${chip(t, accentFor(t))}</a></li>`;

/** The tags of an article, as a rail block. They used to sit above the title,
 *  which put four separate elements between the reader and the first sentence. */
function tagsRail(tags) {
  if (!tags || !tags.length) return "";
  return `<section class="railsec" id="tags" aria-labelledby="tags-h">
  <h2 class="rail__h" id="tags-h">标签</h2>
  <ul class="taglist taglist--rail" aria-label="标签">
${tags.map((t) => `    ${tagChip(t)}`).join("\n")}
  </ul>
</section>`;
}

function outline(headings) {
  if (headings.length < 2) return "";
  return `<nav class="outline" aria-label="本篇目录">
    <h2 class="rail__h">目录</h2>
    <ol>
${headings.map((h) => `      <li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join("\n")}
    </ol>
  </nav>`;
}

function backlinksSection(backlinks) {
  if (!backlinks || !backlinks.length) return "";
  return `<section class="railsec" id="backlinks" aria-labelledby="backlinks-h">
  <h2 class="rail__h" id="backlinks-h">反向链接 <span class="meta">${backlinks.length}</span></h2>
  <ul class="backlist">
${backlinks.map((b) => `    <li>
      <a href="${esc(b.fromUrl)}${b.anchor ? "#" + encodeURIComponent(b.anchor) : ""}">${esc(b.fromTitle)}</a>
      <span class="backlist__meta meta">${esc(b.fromKind)}</span>
      ${b.context ? `<p class="backlist__ctx">${esc(b.context)}</p>` : ""}
    </li>`).join("\n")}
  </ul>
</section>`;
}

/**
 * One inert `<template>` per outbound link — the body of the hover preview.
 *
 * The preview is the reason a `{{ref:}}` is worth writing instead of a bare
 * link: the reader can see what a piece is before leaving the sentence they are
 * reading. It is rendered here, at build time, so hovering costs no request and
 * leaks nothing to anyone; gwern fetches the target page live, which is the one
 * part of its preview worth not copying.
 *
 * `<template>` content is inert — not rendered, not announced, not indexed. The
 * one thing that must hold is that every `data-preview="x"` has an `id="pv-x"`,
 * which the build asserts, because a missing template fails as *nothing
 * happening on hover*, which no reader would ever report as a bug.
 */
function previewTemplates(outgoing, bySlug) {
  const seen = new Set();
  const blocks = [];
  for (const l of outgoing || []) {
    if (seen.has(l.to)) continue;
    seen.add(l.to);
    const t = bySlug.get(l.to);
    if (!t) continue;
    blocks.push(`<template id="pv-${esc(t.slug)}">
  <p class="preview__title">${esc(t.title)}</p>
  <p class="preview__meta meta">${esc(t.domainName)} · ${esc(t.kind)} · ${esc(dateDots(t.created))}${
    t.chars ? ` · ${t.chars} 字` : ""}</p>
  <p class="preview__desc">${esc(t.description)}</p>
</template>`);
  }
  return blocks.join("\n");
}

/**
 * "Similar links" — the pieces a reader is most likely to want next.
 *
 * gwern builds these from a neural embedding of the text. There is no model
 * here, so the signal is shared tags (weighted towards rare ones) plus the same
 * series, computed in build.mjs. The reason is named in the list rather than
 * hidden: a suggestion the reader cannot account for is just noise, whereas
 * "系列 · 个人站点的三次改版" is a reason they can accept or reject.
 */
function relatedSection(related) {
  if (!related || !related.length) return "";
  return `<section class="railsec" id="related" aria-labelledby="related-h">
  <h2 class="rail__h" id="related-h">相关 <span class="meta">${related.length}</span></h2>
  <ul class="rellist">
${related.map((r) => `    <li>
      <a href="${esc(r.url)}">${esc(r.title)}</a>
      <span class="rellist__meta meta">${esc(r.why.join(" · "))}</span>
    </li>`).join("\n")}
  </ul>
</section>`;
}

function sourcesSection(outgoing, bySlug) {
  if (!outgoing || !outgoing.length) return "";
  return `<section class="railsec" id="sources" aria-labelledby="sources-h">
  <h2 class="rail__h" id="sources-h">本篇引用 <span class="meta">${outgoing.length}</span></h2>
  <ol class="srclist">
${outgoing.map((l) => {
  const target = bySlug.get(l.to);
  return `    <li><a href="${esc(target ? target.url : "#")}">${esc(l.toTitle)}</a>${
    l.anchor ? ` <span class="meta">§${esc(l.anchor)}</span>` : ""
  }</li>`;
}).join("\n")}
  </ol>
</section>`;
}

/* `notesSection()` used to live here: a rail block listing every footnote, which
   the `data-notes="off"` branch revealed. The notes control was removed, the
   attribute lost its writer, and the block became a permanently hidden copy of
   the notes already in the margin — so it went, along with its CSS. */

/** Citation block: gwern gives every page a permalink and a stable version; a
 *  writer needs to be able to point at their own text, so four formats ship
 *  together and all four are copyable in one click. */
function citationBlock(site, a, revisions) {
  const version = revisions && revisions.length ? revisions[0].hash : "";
  const accessed = new Date().toISOString().slice(0, 10);
  const permalink = `${site.origin}${a.url}`;
  const bibtex = `@misc{${a.slug.replace(/[^a-zA-Z0-9]/g, "") || "entry"}${a.created.slice(0, 4)},
  author = {${site.author}},
  title  = {{${a.title}}},
  year   = {${a.created.slice(0, 4)}},
  note   = {${a.domainName} · ${a.kind}},
  url    = {${permalink}}${version ? `,\n  version = {${version}}` : ""}
}`;
  const chicago = `${site.author}. 「${a.title}」. ${dateLong(a.created)}. ${permalink}.`;
  const gbt = `${site.author}. ${a.title}[EB/OL]. ${a.created}. ${permalink}.`;
  const markdown = `[${a.title}](${permalink}) — ${site.author}，${a.created}`;

  const row = (label, value) => `    <div class="cite__row">
      <span class="cite__label">${label}</span>
      <code class="cite__code">${esc(value)}</code>
      <button type="button" class="cite__copy" data-copy="${esc(value)}">复制</button>
    </div>`;

  return `<section class="railsec" id="cite" aria-labelledby="cite-h">
  <h2 class="rail__h" id="cite-h">引用</h2>
  <p class="cite__perm">永久链接 <a href="${esc(a.url)}" data-permalink>${esc(permalink)}</a>${
    version ? ` <span class="meta">· 修订 ${esc(version)}</span>` : ""
  } <span class="meta">· 访问 ${esc(accessed)}</span></p>
${row("BibTeX", bibtex)}
${row("GB/T 7714", gbt)}
${row("Chicago", chicago)}
${row("Markdown", markdown)}
  <p class="cite__status" role="status" aria-live="polite" data-copy-status></p>
</section>`;
}

function revisionSection(revisions) {
  if (!revisions || !revisions.length) {
    return `<section class="railsec" id="revisions" aria-labelledby="rev-h">
  <h2 class="rail__h" id="rev-h">修订记录</h2>
  <p class="meta">没有可用的 Git 历史。</p>
</section>`;
  }
  return `<section class="railsec" id="revisions" aria-labelledby="rev-h">
  <h2 class="rail__h" id="rev-h">修订记录 <span class="meta">${revisions.length}</span></h2>
  <ol class="revlist">
${revisions.map((r, i) => `    <li>
      <time datetime="${esc(r.date)}">${esc(dateDots(r.date))}</time>
      <code class="revlist__hash" title="${esc(r.hash)}">${esc(r.hash.slice(0, 7))}</code>
      <span class="revlist__msg">${esc(r.subject)}</span>
      ${i === 0 ? `<span class="revlist__now meta">当前</span>` : ""}
    </li>`).join("\n")}
  </ol>
</section>`;
}

export function pageArticle(site, a, ctx) {
  const { revisions, backlinks, outgoing, related, bySlug, notesHtml, headings, prev, next, sectionBacklinks } = ctx;
  const status = statusByKey(a.status);
  const domain = domainByKey(a.domain);

  return `${head(site, {
    title: a.title,
    desc: a.description,
    canonical: `${site.origin}${a.url}`,
    type: "article",
    accent: (domain && domain.accent) || "neutral",
    jsonld: {
      "@context": "https://schema.org",
      "@type": a.domain === "literature" ? "CreativeWork" : "ScholarlyArticle",
      headline: a.title,
      abstract: a.description,
      datePublished: a.created,
      ...(a.modified ? { dateModified: a.modified } : {}),
      inLanguage: site.lang,
      author: { "@type": "Person", name: site.author },
      url: `${site.origin}${a.url}`,
      ...(a.tags.length ? { keywords: a.tags.join(", ") } : {}),
      ...(a.license || site.license ? { license: a.license || site.license } : {})
    }
  })}
${nav("writing")}
<a id="top"></a>
<main id="main" class="wrap wrap--reading article">
  <p class="artback"><a href="/writing/"><span aria-hidden="true">←</span> 写作</a></p>
  <header class="arthead">
    <h1 class="arthead__title">${esc(a.title)}</h1>
    <p class="arthead__meta">
      <a href="/${esc(a.domain)}/">${esc(a.domainName)}</a>
      <span aria-hidden="true"> · </span>${esc(a.kind)}
      <span aria-hidden="true"> · </span><time datetime="${esc(a.created)}">${esc(dateDots(a.created))}</time>
      ${status ? `<span aria-hidden="true"> · </span><span class="status status--${esc(a.status)}">${esc(status.name)}</span>` : ""}
    </p>
    <p class="arthead__desc">${esc(a.description)}</p>
  </header>

  <div class="artbody">
    <div class="artmain prose">
${notesHtml}
    </div>

    <aside class="rail" aria-label="页面工具" data-rail>
${metaBlock(a, { revisions })}
${outline(headings)}
${tagsRail(a.tags)}
${sourcesSection(outgoing, bySlug)}
${backlinksSection(backlinks)}
${relatedSection(related)}
${citationBlock(site, a, revisions)}
${revisionSection(revisions)}
      <p class="railsec lic"><span class="meta">许可</span> ${esc(a.license || site.license)}</p>
    </aside>
  </div>
${previewTemplates(outgoing, bySlug)}
</main>
${foot(site, { prev, next })}`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* index-ish pages                                                       */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * An article as it appears in any list: title, kind, date, description.
 *
 * Mixed lists (a tag page, the archive) hold both articles and collection
 * entries, and the two do not carry the same fields: a book in `_reading` has
 * no `domain` and no `kind`, it has a collection and a status of its own. Both
 * shapes resolve to the same "which list does this belong to, and what is it"
 * line, so ask each shape for its own answer rather than assuming one.
 */
function entry(a, { showDomain = false, index = 0 } = {}) {
  // Collection entries carry `collection`/`collectionName`; articles carry
  // `domain`/`domainName`. Pick whichever this item actually has.
  const owner = a.domain || a.collection || "";
  const ownerName = a.domainName || a.collectionName || "";
  const kind = a.kind || a.statusName || "";
  const statusName = statusByKey(a.status)?.name || a.statusName || a.status;
  return `    <li class="entry" style="--i:${Math.min(index, 6)}">
      <a class="entry__title" href="${esc(a.url)}">${esc(a.title)}</a>
      <p class="entry__meta meta">
        ${showDomain && owner ? `<a href="/${esc(owner)}/">${esc(ownerName)}</a> · ` : ""}${kind ? `${esc(kind)} · ` : ""}<time datetime="${esc(a.created)}">${esc(dateDots(a.created))}</time>
        ${a.status !== "finished" && statusName ? `· <span class="status status--${esc(a.status)}">${esc(statusName)}</span>` : ""}
      </p>
      <p class="entry__desc">${esc(a.description)}</p>
    </li>`;
}

const entryList = (items, opts) => items.length
  ? `<ol class="entries reveal">\n${items.map((a, i) => entry(a, { ...opts, index: i })).join("\n")}\n</ol>`
  : `<p class="empty">这里还没有文章。</p>`;

/**
 * Choose a card footprint: which CELL it occupies.
 *
 * The first card in the grid is always the intro block — a large square holding
 * the site's own description, exactly where chester.how puts its greeting. After
 * that, an explicit `card:` in front matter wins; otherwise the shape follows
 * from what the item IS: poetry and fragments are short so they read well small,
 * books and hobby notes are square, and anything explicitly marked wide gets the
 * 2:1 cell. Variation is the point — a grid of identical squares is a table.
 *
 * Footprint and VARIANT are separate questions, which the picture cards made
 * obvious: `card: image` is a way of drawing the card, not a size, and treating
 * it as one silently gave every cover the wrong variant. `variantFor` below
 * answers the other half.
 */
function sizeFor(item, isFirst) {
  if (isFirst) return "intro";
  if (item.card === "wide") return "wide";
  if (["intro", "wide", "square"].includes(item.card)) return item.card;
  // A cover looks best square unless told otherwise; `image_and_text` needs the
  // height for its scrim, `image` would happily be wide.
  if (item.card === "image_and_text") return "square";
  return "square";
}

/** Which of the three card drawings to use: plain text, a photograph with a
 *  caption on it (`card: image`), or a photograph behind the chips and title
 *  (`card: image_and_text`, the default once an entry has a cover). */
export const variantFor = (item) => {
  if (!item.picture) return "text";
  return item.card === "image" ? "photo" : "scrim";
};

/** Merge writing and the optional collections into one ordered card list. */
export function buildCards(articles, collections, site) {
  const pinned = [];
  const rest = [];

  const push = (item) => (item.pin > 0 ? pinned : rest).push(item);
  for (const a of articles) push(a);
  for (const key of Object.keys(collections)) for (const e of collections[key]) push(e);

  // pinned first by their number, then newest first
  pinned.sort((a, b) => a.pin - b.pin || (a.created < b.created ? 1 : -1));
  rest.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));

  const ordered = pinned.concat(rest);
  // The intro block is also the page's only <h1>. Putting a visible heading
  // elsewhere would fight chester's design, where the greeting IS the top of
  // the page; a visually-hidden <h1> would satisfy the checker and no reader.
  const intro = {
    h1: site.introH1 || site.title,
    introHtml: site.introHtml || `<p class="card__intro">这里是 <span class="accent">${esc(site.title)}</span>，一个写字的地方。</p>`
  };

  const cards = [];
  ordered.forEach((item, i) => {
    cards.push(card(item, sizeFor(item, false), i + 1));   // +1: the intro is cell 0
  });
  cards.unshift(card(intro, "intro"));
  return cards;
}

export function pageHome(site, ctx) {
  const { articles, collections, tags, series, counts } = ctx;
  const cards = buildCards(articles, collections, site);
  const total = articles.length + Object.values(collections).reduce((n, list) => n + list.length, 0);

  return `${head(site, {
    title: site.title,
    desc: site.tagline,
    canonical: `${site.origin}/`,
    jsonld: {
      "@context": "https://schema.org", "@type": "WebSite",
      name: site.title, url: site.origin, inLanguage: site.lang,
      description: site.tagline
    }
  })}
${nav("home")}
<a id="top"></a>
<main id="main" class="wrap">
${masonry(cards)}
  <p class="home__more">
    <a href="/writing/">全部写作（${articles.length}）</a>
    ${collections.reading.length ? ` · <a href="/reading/">阅读（${collections.reading.length}）</a>` : ""}
    ${collections.hobbies.length ? ` · <a href="/hobbies/">爱好（${collections.hobbies.length}）</a>` : ""}
    · <a href="/archive/">归档</a>
    ${tags.length ? ` · <a href="/tags/">标签（${tags.length}）</a>` : ""}
    ${series.length ? ` · <a href="/series/">系列（${series.length}）</a>` : ""}
    <span class="meta">共 ${total} 项</span>
  </p>
</main>
${foot(site)}`;
}

/**
 * `/writing/` — every piece, scattered into one grid.
 *
 * This page used to be three labelled blocks, one per domain, each with its own
 * heading and list. The instruction was that writing does not need to be forced
 * into three groups: it should just be cards. So it is the homepage's grid
 * without the intro tile, and the three domains survive as filters you reach
 * from a tag, an article's own header, or `/archive/`.
 */
export function pageWriting(site, ctx) {
  const { articles, counts } = ctx;
  const cards = articles.map((a, i) => card(a, sizeFor(a, false), i));
  return `${head(site, {
    title: "写作",
    desc: site.writingBlurb || "全部文章。",
    canonical: `${site.origin}/writing/`
  })}
${nav("writing")}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead("写作", esc(site.writingBlurb || "文学、哲学与计算机科学，散在一面墙上。"), `    <p class="meta">${articles.length} 篇 · <a href="/archive/">按时间</a> · <a href="/tags/">按标签</a> · <a href="/series/">系列</a></p>\n`)}
${masonry(cards)}
</main>
${foot(site)}`;
}

/**
 * The header every sub-page wears.
 *
 * The reference sets its section titles at `text-6xl md:text-8xl` — 60px, then
 * 96px — in the lightest weight the serif has, over one grey lead paragraph.
 * That is the whole header: no eyebrow line, no tags, no controls. It is also
 * the clearest statement of the site's hierarchy, because a page title that
 * large needs no decoration to read as one.
 */
function pageHead(title, blurb, extra = "") {
  return `  <header class="pagehead">
    <h1 class="pagehead__title">${title}</h1>
${blurb ? `    <p class="pagehead__desc">${blurb}</p>\n` : ""}${extra}  </header>`;
}

/** A collection index: `/reading/`, `/hobbies/`. Works when empty. */
export function pageCollection(site, c, items, counts, activeKey) {
  // No intro block here — that belongs on the homepage only, so every card is
  // an entry and the grid stays a list.
  const cards = items.map((e, i) => card(e, e.card === "wide" ? "wide" : "square", i));
  return `${head(site, {
    title: c.name,
    desc: c.blurb,
    canonical: `${site.origin}/${c.key}/`,
    accent: c.accent || "neutral"
  })}
${nav(activeKey || c.key)}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead(esc(c.name), esc(c.blurb))}
${items.length ? masonry(cards) : `<p class="empty">还没有条目。在 <code>${esc(c.dir)}/</code> 里放一个 .md 就会出现。</p>`}
</main>
${foot(site)}`;
}

/** One collection entry with a page of its own — i.e. a book. Hobby entries are
 *  display tiles with nothing behind them, so they never reach this function. */
export function pageCollectionEntry(site, c, e, bodyHtml) {
  return `${head(site, {
    title: e.title,
    desc: e.description || e.title,
    canonical: `${site.origin}${e.url}`,
    type: "article",
    accent: c.accent || "neutral",
    jsonld: {
      "@context": "https://schema.org",
      "@type": c.key === "reading" ? "Book" : "CreativeWork",
      name: e.title,
      ...(e.author ? { author: { "@type": "Person", name: e.author } } : {}),
      inLanguage: site.lang
    }
  })}
${nav(c.key)}
<a id="top"></a>
<main id="main" class="wrap wrap--reading">
  <p class="artback"><a href="/${esc(c.key)}/"><span aria-hidden="true">←</span> ${esc(c.name)}</a></p>
  <article>
    <header class="arthead">
      <h1 class="arthead__title">${esc(e.title)}</h1>
      <p class="arthead__meta">${
        [e.statusName ? chip(e.statusName, e.chip) : "",
         e.author ? esc(e.author) : "",
         e.created ? `<time datetime="${esc(e.created)}">${esc(dateDots(e.created))}</time>` : ""
        ].filter(Boolean).join('<span aria-hidden="true"> · </span>')
      }</p>
    </header>
    <div class="prose">
${bodyHtml}
    </div>
  </article>
</main>
${foot(site)}`;
}

export function pageDomain(site, d, articles, counts) {
  const kinds = d.kinds.map((k) => [k, articles.filter((a) => a.kind === k)]);
  const cards = articles.map((a, i) => card(a, sizeFor(a, false), i));
  return `${head(site, {
    title: d.name,
    desc: d.blurb,
    canonical: `${site.origin}/${d.key}/`,
    accent: d.accent || "neutral"
  })}
${nav("writing")}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead(esc(d.name), esc(d.blurb), `    <p class="meta">${articles.length} 篇 · ${kinds.filter(([, v]) => v.length).map(([k, v]) => `${esc(k)} ${v.length}`).join(" · ")}</p>\n`)}
${masonry(cards)}
</main>
${foot(site)}`;
}

export function pageArchive(site, ctx) {
  const { articles, years, counts } = ctx;
  const byYear = new Map();
  for (const a of articles) {
    const y = a.created.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(a);
  }

  return `${head(site, {
    title: "归档",
    desc: "全部文章，按时间、领域、类型与年份。",
    canonical: `${site.origin}/archive/`
  })}
${nav("home")}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead("归档", `全部 ${articles.length} 篇。也可以按<a href="/tags/">标签</a>或<a href="/search/">检索</a>找。`)}

  <nav class="filters" aria-label="按领域浏览">
    <span class="filters__label meta">领域</span>
${DOMAINS.map((d) => {
  const n = articles.filter((a) => a.domain === d.key).length;
  return `    <a href="/${d.key}/">${esc(d.name)} <span class="meta">${n}</span></a>`;
}).join("\n")}
  </nav>

  <nav class="filters" aria-label="按类型浏览">
    <span class="filters__label meta">类型</span>
${DOMAINS.flatMap((d) => d.kinds).map((k) => {
  const n = articles.filter((a) => a.kind === k).length;
  return n ? `    <a href="/search/?kind=${encodeURIComponent(k)}">${esc(k)} <span class="meta">${n}</span></a>` : "";
}).filter(Boolean).join("\n")}
  </nav>

${[...byYear.keys()].sort().reverse().map((y) => `  <section class="yearblock">
    <h2 class="rail__h">${y} <span class="meta">${byYear.get(y).length}</span></h2>
${entryList(byYear.get(y), { showDomain: true })}
  </section>`).join("\n")}
</main>
${foot(site)}`;
}

export function pageTags(site, tags, counts) {
  return `${head(site, {
    title: "标签",
    desc: "全部标签及其下的文章。",
    canonical: `${site.origin}/tags/`
  })}
${nav("tags")}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead("标签", "跨领域的线索靠标签串起来：同一个想法在文学、哲学与计算机里各长什么样。")}
  <ul class="tagindex">
${tags.map((t) => `    <li>
      <a class="tagindex__name" href="/tags/${encodeURIComponent(t.name)}/">${chip(t.name, accentFor(t.name))}</a>
      <span class="meta">${t.count}</span>
      ${t.blurb ? `<p class="tagindex__blurb">${esc(t.blurb)}</p>` : ""}
    </li>`).join("\n")}
  </ul>
</main>
${foot(site)}`;
}

export function pageTag(site, name, items, backlinks, counts) {
  const cards = items.map((a, i) => card(a, sizeFor(a, false), i));
  return `${head(site, {
    title: `标签：${name}`,
    desc: `${items.length} 篇关于「${name}」的文章。`,
    canonical: `${site.origin}/tags/${encodeURIComponent(name)}/`,
    accent: accentFor(name)
  })}
${nav("tags")}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead(`#${esc(name)}`, `${items.length} 项`, "")}
${masonry(cards)}
${backlinks && backlinks.length ? `  <p class="more"><a href="/search/?tag=${encodeURIComponent(name)}">在全文里检索这个标签 →</a></p>` : ""}
</main>
${foot(site)}`;
}

export function pageSeries(site, name, items, counts) {
  const cards = [...items].reverse().map((a, i) => card(a, sizeFor(a, false), i));
  return `${head(site, {
    title: `系列：${name}`,
    desc: `${items.length} 篇的系列。`,
    canonical: `${site.origin}/series/${encodeURIComponent(name)}/`,
    accent: accentFor(name)
  })}
${nav("writing")}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead(esc(name), `${items.length} 篇，按写作时间排列。`)}
${masonry(cards)}
</main>
${foot(site)}`;
}

export function pageSeriesIndex(site, series, counts) {
  return `${head(site, { title: "系列", desc: "成组的文章。", canonical: `${site.origin}/series/` })}
${nav("writing")}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead("系列", "同一主题下的多篇。")}
${series.length ? `  <ul class="seriesindex">
${series.map((s) => `    <li><a href="/series/${encodeURIComponent(s.name)}/">${esc(s.name)}</a> <span class="meta">${s.items.length}</span>
      <p class="tagindex__blurb">${esc(s.items[0].description)}</p></li>`).join("\n")}
  </ul>` : `<p class="empty">还没有系列。</p>`}
</main>
${foot(site)}`;
}

export function pageSearch(site, counts) {
  return `${head(site, {
    title: "搜索",
    desc: "全文检索，按领域、类型、标签与年份筛选。",
    canonical: `${site.origin}/search/`,
    extraCss: []
  })}
${nav("home")}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead("搜索", "索引在构建时生成，检索完全在浏览器里完成 —— 没有服务端，也没有请求发出去。")}

  <form class="searchbox" role="search" data-search-form>
    <label class="visually-hidden" for="q">关键词</label>
    <input id="q" name="q" type="search" autocomplete="off" spellcheck="false"
           placeholder="关键词，空格分隔，全部命中才算匹配…" data-search-input>
    <button type="submit">搜索</button>
  </form>

  <div class="searchfilters">
    <label>领域
      <select data-filter="domain">
        <option value="">全部</option>
${DOMAINS.map((d) => `        <option value="${esc(d.key)}">${esc(d.name)}</option>`).join("\n")}
      </select>
    </label>
    <label>类型
      <select data-filter="kind">
        <option value="">全部</option>
${DOMAINS.flatMap((d) => d.kinds).map((k) => `        <option value="${esc(k)}">${esc(k)}</option>`).join("\n")}
      </select>
    </label>
    <label>标签
      <select data-filter="tag"><option value="">全部</option></select>
    </label>
    <label>年份
      <select data-filter="year"><option value="">全部</option></select>
    </label>
  </div>

  <p class="searchstatus" role="status" aria-live="polite" data-search-status>
    <span class="searchstatus__text">载入索引后就能检索。</span>
  </p>
  <ol class="entries searchresults" data-search-results></ol>
  <noscript>
    <p class="empty">搜索需要 JavaScript。没有它也能用：<a href="/tags/">按标签</a>或<a href="/archive/">按时间</a>浏览全部文章。</p>
  </noscript>
</main>
${foot(site)}`;
}

export function pageAbout(site, ctx) {
  const { articles, counts, tags } = ctx;
  return `${head(site, {
    title: "自述",
    desc: "关于这个站点，以及它为什么长成现在这样。",
    canonical: `${site.origin}/about/`
  })}
${nav("about")}
<a id="top"></a>
<main id="main" class="wrap prose narrow">
${pageHead("自述", "个人站点，非商业。")}

  <section id="what">
    <h2 id="s1">这是什么<a class="anchor" href="#s1" aria-label="本节链接">#</a></h2>
    <p>一个写字的地方，按三个领域组织：<a href="/literature/">文学</a>、<a href="/philosophy/">哲学</a>、<a href="/compsci/">计算机科学</a>。<strong>正文是纯文本</strong>：没有插图、没有公式、没有代码高亮，文字本身是目的。卡片可以配一张封面图 —— 那是版面，不是内容。</p>
    <p>目前有 ${articles.length} 篇文章、${tags.length} 个标签。</p>
  </section>

  <section id="not">
    <h2 id="s2">这里没有什么<a class="anchor" href="#s2" aria-label="本节链接">#</a></h2>
    <p>没有广告、赞助、会员、付费墙、捐赠、推广链接；没有评论、点赞、分享、关注；不需要注册，没有推送；没有任何追踪分析，没有 A/B 测试，没有 SEO 营销。页面不加载第三方脚本，不请求外部字体。</p>
  </section>

  <section id="how">
    <h2 id="s3">怎么做的<a class="anchor" href="#s3" aria-label="本节链接">#</a></h2>
    <ul>
      <li>用 Markdown 写作，用 Git 存档，静态生成后托管在 GitHub Pages 上。</li>
      <li>每个页面都有稳定的永久链接与一份从 Git 提交自动生成的修订记录。</li>
      <li>文章之间双向互链：你说到别人，别人页面上就会出现你；引用可以落到具体某一节，那一节里就会出现「本节被这些地方引用」。</li>
      <li>悬停站内互链会浮出目标那一篇的标题与摘要，片段在构建期就生成好，不发出任何请求。</li>
      <li>排版手法参考 <a href="https://gwern.net/design">gwern.net</a>：元信息块、边注、可折叠章节、语义缩放、双向链接；但中文字距、行宽与边注规则是重新定的，不照搬拉丁版式。</li>
      <li>外观参考 <a href="https://chester.how/">chester.how</a>：砖石网格、卡片尺寸、字体刻度、标签配色，以及卡片封面图的两种画法（照片压标题、照片衬底）都照它的做法来。字体不下载，用系统字体栈 —— 字号与字距一致，字形由你的机器决定。</li>
      <li>封面图在构建期缩成三档 WebP 并写好宽高与懒加载，图片存放在本站自己的 <code>/img/</code> 下 —— 不经过任何图床，也不发出第三方请求。</li>
    </ul>
  </section>

  <section id="a11y">
    <h2 id="s4">无障碍<a class="anchor" href="#s4" aria-label="本节链接">#</a></h2>
    <ul>
      <li>语义化 HTML，每页只有一个一级标题，标题层级不跳级。</li>
      <li>对比度达标：正文 21.0:1、卡片正文 9.9:1、次要文字 4.3:1，都过 WCAG AA。全站只有一套亮色配色，因此只有一组数字需要守。</li>
      <li>键盘可达：折叠、链接预览、搜索、阅读模式都能只用键盘操作。</li>
      <li>关闭 JavaScript 后正文、脚注、目录、标签与互链仍然完整可读。唯一的例外是 404 页面的「是不是想找」—— 那一步需要脚本，无脚本时给出搜索与归档两条退路。</li>
      <li>尊重系统的「减弱动态效果」设置：动效只作用于导航与索引列表，正文里没有任何动画。</li>
    </ul>
  </section>

  <section id="license">
    <h2 id="s5">许可<a class="anchor" href="#s5" aria-label="本节链接">#</a></h2>
    <p>本站文字按 <strong>${esc(site.license)}</strong> 授权。代码部分见 <a href="https://github.com/fengzishiyi/fengzishiyi.github.io">GitHub 仓库</a>（MIT）。</p>
  </section>
</main>
${foot(site)}`;
}

export function pageChangelog(site, ctx) {
  const { articles, counts } = ctx;
  const recent = [...articles].sort((a, b) => (a.created < b.created ? 1 : -1));
  return `${head(site, {
    title: "更新",
    desc: "全站最近写了什么。",
    canonical: `${site.origin}/changelog/`
  })}
${nav("home")}
<a id="top"></a>
<main id="main" class="wrap">
${pageHead("更新", "按写作时间倒序。每篇文章自己的修订记录在文章页下方。")}
${entryList(recent, { showDomain: true })}
</main>
${foot(site)}`;
}

/**
 * The 404 page, with gwern's "did you mean" guess.
 *
 * gwern answers a mistyped address on the SERVER, where the request path is
 * available. GitHub Pages serves this one static file for every missing path and
 * has no server logic, so the guess is made in the reader's browser instead —
 * guess404.js compares the requested path against the published slugs. Without
 * scripting the page still offers search and the archive, which is why the
 * fallback below is never hidden behind the guess.
 */
export function page404(site, counts) {
  return `${head(site, {
    title: "404",
    desc: "没有这一页。",
    canonical: `${site.origin}/404.html`,
    headExtra: `<script src="/assets/guess404.js" defer></script>`
  })}
${nav("")}
<a id="top"></a>
<main id="main" class="wrap prose narrow">
${pageHead("没有这一页", "这个地址下没有内容。")}
  <div class="guess" data-guess hidden></div>
  <p class="meta">可以试试<a href="/search/">搜索</a>，或者从<a href="/archive/">归档</a>里翻。</p>
</main>
${foot(site)}`;
}

/** Old magazine URLs, kept alive as redirects. A link someone saved two
 *  redesigns ago should still land somewhere sensible. */
export function pageRedirect(site, from, to, why, counts) {
  return `${head(site, {
    title: "页面已迁移",
    desc: "这个地址已经迁移到新的位置。",
    canonical: site.origin + to,
    headExtra: `<meta http-equiv="refresh" content="0; url=${esc(to)}">
<meta name="robots" content="noindex,follow">`
  })}
${nav("")}
<a id="top"></a>
<main id="main" class="wrap prose narrow">
${pageHead("页面已迁移", `${esc(why)}`)}
  <p><code>${esc(from)}</code> 现在在 <a href="${esc(to)}">${esc(to)}</a>。</p>
</main>
${foot(site)}`;
}

export function favicon(site) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="#FFFFFF"/>
<text x="32" y="45" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif" font-size="38" font-weight="300" fill="#000000" text-anchor="middle">${esc(site.title.slice(0, 1))}</text>
</svg>`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* feeds                                                                 */
/* ══════════════════════════════════════════════════════════════════════ */

export function rss(site, articles) {
  const items = articles.slice(0, 30).map((a) => `    <item>
      <title>${esc(a.title)}</title>
      <link>${esc(site.origin + a.url)}</link>
      <guid isPermaLink="true">${esc(site.origin + a.url)}</guid>
      <pubDate>${new Date(a.created + "T00:00:00Z").toUTCString()}</pubDate>
      <category>${esc(a.domainName)} · ${esc(a.kind)}</category>
      <description>${esc(a.description)}</description>
    </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(site.title)}</title>
    <link>${esc(site.origin + "/")}</link>
    <description>${esc(site.tagline)}</description>
    <language>${esc(site.lang)}</language>
    <atom:link href="${esc(site.origin)}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}
