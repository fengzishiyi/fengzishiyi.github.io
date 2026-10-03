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
 *  · The article page is a two-column grid: a narrow rail for the outline and
 *    backlinks, and the reading measure beside it. Sidenotes float into the
 *    rail from inside the prose via CSS, so the note text lives in the document
 *    where it belongs and never needs JavaScript to be readable.
 */

import { esc, plain, dateDots, dateLong } from "./lib.mjs";
import { DOMAINS, STATUSES, CONFIDENCES, statusByKey, confidenceByKey, domainByKey } from "./taxonomy.mjs";

/* ══════════════════════════════════════════════════════════════════════ */
/* chrome                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

export const CSS = ["tokens", "base", "prose", "components", "search"];

export function head(site, { title, desc, canonical, type = "website", jsonld, extraCss = [] }) {
  const full = title === site.title ? title : `${title} — ${site.title}`;
  return `<!doctype html>
<html lang="${esc(site.lang)}" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(desc || site.tagline)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="#FBFAF9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141413" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
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
<!-- No analytics, no fonts, no CDN, no third-party script. See /about/ . -->
</head>
<body>
<a class="skip" href="#main">跳到正文</a>`;
}

/** Site header. Deliberately small and non-sticky. */
export function mast(site, active, counts) {
  const c = counts || {};
  const nav = [
    ["literature", "/literature/", "文学"],
    ["philosophy", "/philosophy/", "哲学"],
    ["compsci", "/compsci/", "计算机科学"],
    ["tags", "/tags/", "标签"],
    ["archive", "/archive/", "归档"],
    ["search", "/search/", "搜索"]
  ];
  return `
<header class="mast">
  <div class="wrap mast__in">
    <a class="mast__home" href="/">${esc(site.title)}</a>
    <nav class="mast__nav" aria-label="主导航">
${nav.map(([key, href, text]) => {
  const n = c[key] !== undefined ? `<span class="mast__n">${c[key]}</span>` : "";
  return `      <a href="${href}"${active === key ? ' aria-current="page"' : ""}>${text}${n}</a>`;
}).join("\n")}
    </nav>
  </div>
</header>`;
}

/** Reading controls. Only on article pages: size, measure, theme and the
 *  sidenote switch are things you reach for while reading, and putting them on
 *  index pages would be chrome for its own sake.
 *
 *  Hidden until the reader scrolls — `hidden` in the markup, so with scripting
 *  off it never appears and nothing is lost, since these are all enhancements. */
export function toolbar() {
  return `
<div class="toolbar" data-toolbar hidden>
  <div class="wrap toolbar__in">
    <span class="toolbar__title" data-toolbar-title></span>
    <span class="toolbar__group" role="group" aria-label="阅读设置">
      <button type="button" data-size="-1" aria-label="正文缩小">A−</button>
      <button type="button" data-size="1" aria-label="正文放大">A+</button>
      <button type="button" data-measure="-1" aria-label="行宽变窄">窄</button>
      <button type="button" data-measure="1" aria-label="行宽变宽">宽</button>
      <button type="button" data-theme-toggle aria-label="切换明暗主题" aria-pressed="false">主题</button>
      <button type="button" data-notes-toggle aria-label="切换边注显示方式" aria-pressed="true">边注</button>
      <a class="toolbar__top" href="#top" aria-label="回到顶部">↑</a>
    </span>
  </div>
  <div class="progress" data-progress aria-hidden="true"></div>
</div>`;
}

export function foot(site, { prev, next } = {}) {
  return `
<footer class="foot">
  <div class="wrap">
    <nav class="foot__nav" aria-label="页脚导航">
      <a href="/">首页</a>
      <a href="/literature/">文学</a>
      <a href="/philosophy/">哲学</a>
      <a href="/compsci/">计算机科学</a>
      <a href="/tags/">标签</a>
      <a href="/archive/">归档</a>
      <a href="/search/">搜索</a>
      <a href="/series/">系列</a>
      <a href="/changelog/">更新</a>
      <a href="/about/">自述</a>
      <a href="/rss.xml">RSS</a>
    </nav>
    <p class="foot__note">
      ${esc(site.title)} · ${esc(site.subtitle)} ·
      <a href="/about/#license">${esc(site.license)}</a> ·
      <span class="meta">© ${new Date().getFullYear()} ${esc(site.author)}</span>
    </p>
    <p class="foot__note meta">
      纯文本站点：没有图片、没有公式、没有代码高亮、没有第三方脚本、没有追踪。
      用 Markdown 写作，用 Git 存档。
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

function tagList(tags) {
  if (!tags.length) return "";
  return `<ul class="taglist" aria-label="标签">
${tags.map((t) => `      <li><a href="/tags/${encodeURIComponent(t)}/">${esc(t)}</a></li>`).join("\n")}
  </ul>`;
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

function notesSection(notes) {
  if (!notes?.length) return "";
  return `<section class="railsec" id="notes" aria-labelledby="notes-h">
  <h2 class="rail__h" id="notes-h">脚注</h2>
  <ol class="notelist">
${notes.map((n) => `    <li id="${esc(n.id)}list"><span class="meta">[${n.n}]</span> ${esc(plain(n.body))}</li>`).join("\n")}
  </ol>
</section>`;
}

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
  const { revisions, backlinks, outgoing, bySlug, notes, notesHtml, headings, prev, next } = ctx;
  const status = statusByKey(a.status);

  return `${head(site, {
    title: a.title,
    desc: a.description,
    canonical: `${site.origin}${a.url}`,
    type: "article",
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
${mast(site, a.domain, null)}
${toolbar()}
<a id="top"></a>
<main id="main" class="wrap article">
  <header class="arthead">
    <p class="arthead__kicker">
      <a href="/${esc(a.domain)}/">${esc(a.domainName)}</a>
      <span aria-hidden="true"> · </span>${esc(a.kind)}
      ${status ? `<span aria-hidden="true"> · </span><span class="status status--${esc(a.status)}">${esc(status.name)}</span>` : ""}
    </p>
    <h1 class="arthead__title" data-toolbar-title-text="${esc(a.title)}">${esc(a.title)}</h1>
    <p class="arthead__desc">${esc(a.description)}</p>
${tagList(a.tags)}
  </header>

  <div class="artbody">
    <div class="artmain prose">
${notesHtml}
    </div>

    <aside class="rail" aria-label="页面工具">
${metaBlock(a, { revisions })}
${outline(headings)}
${sourcesSection(outgoing, bySlug)}
${backlinksSection(backlinks)}
${citationBlock(site, a, revisions)}
${revisionSection(revisions)}
      <p class="railsec lic"><span class="meta">许可</span> ${esc(a.license || site.license)}</p>
    </aside>
  </div>
</main>
${foot(site, { prev, next })}`;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* index-ish pages                                                       */
/* ══════════════════════════════════════════════════════════════════════ */

/** An article as it appears in any list: title, kind, date, description. */
function entry(a, { showDomain = false } = {}) {
  return `    <li class="entry">
      <a class="entry__title" href="${esc(a.url)}">${esc(a.title)}</a>
      <p class="entry__meta meta">
        ${showDomain ? `<a href="/${esc(a.domain)}/">${esc(a.domainName)}</a> · ` : ""}${esc(a.kind)} ·
        <time datetime="${esc(a.created)}">${esc(dateDots(a.created))}</time>
        ${a.status !== "finished" ? `· <span class="status status--${esc(a.status)}">${esc(statusByKey(a.status)?.name || a.status)}</span>` : ""}
      </p>
      <p class="entry__desc">${esc(a.description)}</p>
    </li>`;
}

const entryList = (items, opts) => items.length
  ? `<ol class="entries reveal">\n${items.map((a) => entry(a, opts)).join("\n")}\n</ol>`
  : `<p class="empty">这里还没有文章。</p>`;

export function pageHome(site, ctx) {
  const { articles, byDomain, tags, series, latest, random, counts } = ctx;

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
${mast(site, "home", counts)}
<a id="top"></a>
<main id="main" class="wrap home">
  <h1 class="home__title">${esc(site.title)}</h1>
  <p class="home__tagline">${esc(site.tagline)}</p>

  <section class="domains" aria-label="三个领域">
${DOMAINS.map((d) => {
  const items = byDomain.get(d.key) || [];
  return `    <article class="domain">
      <h2><a href="/${d.key}/">${esc(d.name)}</a> <span class="meta">${items.length}</span></h2>
      <p class="domain__blurb">${esc(d.blurb)}</p>
      <ul class="domain__kinds">
${d.kinds.map((k) => {
  const n = items.filter((x) => x.kind === k).length;
  return n ? `        <li><span class="meta">${esc(k)}</span> ${n}</li>` : "";
}).filter(Boolean).join("\n")}
      </ul>
    </article>`;
}).join("\n")}
  </section>

  <div class="homecols">
    <section class="homecol" aria-labelledby="latest-h">
      <h2 class="rail__h" id="latest-h">最新更新</h2>
${entryList(latest.slice(0, 8), { showDomain: true })}
      <p class="more"><a href="/archive/">全部 ${articles.length} 篇 →</a></p>
    </section>

    <div class="homecol">
      <section aria-labelledby="random-h">
        <h2 class="rail__h" id="random-h">随便读一篇</h2>
${random ? entryList([random], { showDomain: true }) : `<p class="empty">还没有文章。</p>`}
        <p class="more"><button type="button" class="linkbtn" data-random>换一篇</button></p>
      </section>

      <section aria-labelledby="tags-h">
        <h2 class="rail__h" id="tags-h">标签</h2>
        <ul class="tagcloud">
${tags.slice(0, 24).map((t) => `          <li><a href="/tags/${encodeURIComponent(t.name)}/">${esc(t.name)}</a> <span class="meta">${t.count}</span></li>`).join("\n")}
        </ul>
        <p class="more"><a href="/tags/">全部 ${tags.length} 个标签 →</a></p>
      </section>

      ${series.length ? `<section aria-labelledby="series-h">
        <h2 class="rail__h" id="series-h">系列</h2>
        <ul class="serieslist">
${series.slice(0, 8).map((s) => `          <li><a href="/series/${encodeURIComponent(s.name)}/">${esc(s.name)}</a> <span class="meta">${s.items.length}</span></li>`).join("\n")}
        </ul>
      </section>` : ""}
    </div>
  </div>
</main>
${foot(site)}`;
}

export function pageDomain(site, d, articles, counts) {
  const kinds = d.kinds.map((k) => [k, articles.filter((a) => a.kind === k)]);
  return `${head(site, {
    title: d.name,
    desc: d.blurb,
    canonical: `${site.origin}/${d.key}/`
  })}
${mast(site, d.key, counts)}
<a id="top"></a>
<main id="main" class="wrap">
  <header class="pagehead">
    <h1>${esc(d.name)}</h1>
    <p class="pagehead__desc">${esc(d.blurb)}</p>
    <p class="meta">${articles.length} 篇 · ${kinds.filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.length}`).join(" · ")}</p>
  </header>
${entryList(articles)}
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
${mast(site, "archive", counts)}
<a id="top"></a>
<main id="main" class="wrap">
  <header class="pagehead">
    <h1>归档</h1>
    <p class="pagehead__desc">全部 ${articles.length} 篇。也可以按<a href="/tags/">标签</a>或<a href="/search/">检索</a>找。</p>
  </header>

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
${mast(site, "tags", counts)}
<a id="top"></a>
<main id="main" class="wrap">
  <header class="pagehead">
    <h1>标签</h1>
    <p class="pagehead__desc">跨领域的线索靠标签串起来：同一个想法在文学、哲学与计算机里各长什么样。</p>
  </header>
  <ul class="tagindex">
${tags.map((t) => `    <li>
      <a href="/tags/${encodeURIComponent(t.name)}/">${esc(t.name)}</a>
      <span class="meta">${t.count}</span>
      ${t.blurb ? `<p class="tagindex__blurb">${esc(t.blurb)}</p>` : ""}
    </li>`).join("\n")}
  </ul>
</main>
${foot(site)}`;
}

export function pageTag(site, name, items, backlinks, counts) {
  return `${head(site, {
    title: `标签：${name}`,
    desc: `${items.length} 篇关于「${name}」的文章。`,
    canonical: `${site.origin}/tags/${encodeURIComponent(name)}/`
  })}
${mast(site, "tags", counts)}
<a id="top"></a>
<main id="main" class="wrap">
  <header class="pagehead">
    <h1>#${esc(name)}</h1>
    <p class="pagehead__desc">${items.length} 篇。${items[0] ? esc(items[0].description) : ""}</p>
  </header>
${entryList(items, { showDomain: true })}
${backlinks && backlinks.length ? `  <p class="more"><a href="/search/?tag=${encodeURIComponent(name)}">在全文里检索这个标签 →</a></p>` : ""}
</main>
${foot(site)}`;
}

export function pageSeries(site, name, items, counts) {
  return `${head(site, {
    title: `系列：${name}`,
    desc: `${items.length} 篇的系列。`,
    canonical: `${site.origin}/series/${encodeURIComponent(name)}/`
  })}
${mast(site, "series", counts)}
<a id="top"></a>
<main id="main" class="wrap">
  <header class="pagehead">
    <h1>${esc(name)}</h1>
    <p class="pagehead__desc">${items.length} 篇，按写作时间排列。</p>
  </header>
${entryList([...items].reverse(), { showDomain: true })}
</main>
${foot(site)}`;
}

export function pageSeriesIndex(site, series, counts) {
  return `${head(site, { title: "系列", desc: "成组的文章。", canonical: `${site.origin}/series/` })}
${mast(site, "series", counts)}
<a id="top"></a>
<main id="main" class="wrap">
  <header class="pagehead"><h1>系列</h1>
    <p class="pagehead__desc">同一主题下的多篇。</p></header>
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
${mast(site, "search", counts)}
<a id="top"></a>
<main id="main" class="wrap">
  <header class="pagehead">
    <h1>搜索</h1>
    <p class="pagehead__desc">索引在构建时生成，检索完全在浏览器里完成 —— 没有服务端，也没有请求发出去。</p>
  </header>

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

  <p class="searchstatus" role="status" aria-live="polite" data-search-status></p>
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
${mast(site, "about", counts)}
<a id="top"></a>
<main id="main" class="wrap prose narrow">
  <header class="pagehead">
    <h1>自述</h1>
    <p class="pagehead__desc">个人站点，非商业。</p>
  </header>

  <section id="what">
    <h2 id="s1">这是什么<a class="anchor" href="#s1" aria-label="本节链接">#</a></h2>
    <p>一个写字的地方，按三个领域组织：<a href="/literature/">文学</a>、<a href="/philosophy/">哲学</a>、<a href="/compsci/">计算机科学</a>。以纯文本为主 —— 没有图片、没有公式、没有代码高亮。文字本身是目的。</p>
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
      <li>文章之间双向互链：你说到别人，别人页面上就会出现你。</li>
      <li>排版手法参考 <a href="https://gwern.net/design">gwern.net</a>：元信息块、边注、可折叠章节、语义缩放；但中文字距、行宽与边注规则是重新定的，不照搬拉丁版式。</li>
    </ul>
  </section>

  <section id="a11y">
    <h2 id="s4">无障碍<a class="anchor" href="#s4" aria-label="本节链接">#</a></h2>
    <ul>
      <li>语义化 HTML，每页只有一个一级标题，标题层级不跳级。</li>
      <li>对比度达标：正文与次要文字都过 WCAG AA，明亮与暗色主题分别实测。</li>
      <li>键盘可达：折叠、悬浮预览、搜索、主题切换都能只用键盘操作。</li>
      <li>关闭 JavaScript 后正文、脚注、目录、标签与互链仍然完整可读。</li>
      <li>尊重系统的「减弱动态效果」设置。</li>
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
${mast(site, "changelog", counts)}
<a id="top"></a>
<main id="main" class="wrap">
  <header class="pagehead">
    <h1>更新</h1>
    <p class="pagehead__desc">按写作时间倒序。每篇文章自己的修订记录在文章页右下。</p>
  </header>
${entryList(recent, { showDomain: true })}
</main>
${foot(site)}`;
}

export function page404(site, guess, counts) {
  return `${head(site, { title: "404", desc: "没有这一页。", canonical: `${site.origin}/404.html` })}
${mast(site, "", counts)}
<a id="top"></a>
<main id="main" class="wrap prose narrow">
  <header class="pagehead"><h1>没有这一页</h1></header>
  <p>这个地址下没有内容。${guess ? "不过下面这一篇看起来像你要找的：" : ""}</p>
${guess ? entryList([guess]) : `<p class="meta">可以试试<a href="/search/">搜索</a>，或者从<a href="/archive/">归档</a>里翻。</p>`}
</main>
${foot(site)}`;
}

/** Old magazine URLs, kept alive as redirects. A link someone saved two
 *  redesigns ago should still land somewhere sensible. */
export function pageRedirect(site, from, to, why, counts) {
  return `<!doctype html>
<html lang="${esc(site.lang)}" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>页面已迁移 — ${esc(site.title)}</title>
<meta http-equiv="refresh" content="0; url=${esc(to)}">
<link rel="canonical" href="${esc(site.origin + to)}">
<meta name="robots" content="noindex,follow">
<meta name="color-scheme" content="light dark">
${CSS.map((n) => `<link rel="stylesheet" href="/assets/${n}.css">`).join("\n")}
</head>
<body>
${mast(site, "", counts)}
<main id="main" class="wrap prose narrow">
  <header class="pagehead"><h1>页面已迁移</h1></header>
  <p><code>${esc(from)}</code> 现在在 <a href="${esc(to)}">${esc(to)}</a>。</p>
  <p class="meta">${esc(why)}</p>
</main>
${foot(site)}`;
}

export function favicon(site) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="#FBFAF9"/>
<text x="32" y="45" font-family="Georgia,serif" font-size="38" fill="#1C1C1C" text-anchor="middle">${esc(site.title.slice(0, 1))}</text>
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
