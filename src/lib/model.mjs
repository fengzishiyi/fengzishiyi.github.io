/**
 * model.mjs — THE content model. Every derived fact about the site is computed
 * here, once, and every page reads it.
 *
 * Before the migration this work was spread across build.mjs and each page
 * template: the outline was collected in one place, the tag list in another, the
 * "similar links" rail in a third, and the search index in a fourth — all of them
 * re-deriving the same slug/url/kind facts from the same records. A single model
 * removes the possibility of two pages disagreeing about what a thing is, and it
 * is why moving to components did not mean re-implementing the site.
 *
 * What it produces, in dependency order:
 *
 *   records        front matter, validated by the collection schema
 *   link graph     {{ref:}} in both directions, with the sentence it sits in
 *   bodies         rendered HTML, headings, section backlinks
 *   taxonomy       tags, series, counts
 *   derivations    related pieces, card covers, search index, feed
 *
 * The model is memoised: one computation per build, shared by every page.
 */

import path from "node:path";
import { getCollection } from "astro:content";

import { loadSite } from "./site.mjs";
import { DOMAINS, COLLECTIONS, collectionByKey, domainByKey, statusByKey,
  confidenceByKey, statusOf, kindsFor } from "./taxonomy.mjs";
import { slugify, plain } from "./text.mjs";
import { Problems, nearMiss } from "./fsx.mjs";
import { revisionsFor } from "./revisions.mjs";
import { cardJson, findMaster, WIDTHS, derivativeName } from "./images.mjs";
import { renderBody } from "./markdown.mjs";
import { refRe, parseRef, REF_ANCHOR_RE } from "./sitetext.mjs";

const ROOT = process.cwd();
const ARTICLE_EXT = /\.(md|markdown)$/i;

/* ══════════════════════════════════════════════════════════════════════ */
/* records                                                               */
/* ══════════════════════════════════════════════════════════════════════ */

/** The file behind an entry, as an absolute path. */
const fileOf = (entry) => path.join(ROOT, String(entry.filePath || "").replaceAll("/", path.sep));

/** The entry's path relative to the project root, with forward slashes. */
const relOf = (entry) => String(entry.filePath || "").replaceAll("\\", "/");

/**
 * The entry's file name.
 *
 * NOT `entry.id`: the glob loader takes an entry's id from a `slug:` field when
 * the front matter has one, so an article with `slug: why-plain-text` has the id
 * `why-plain-text` and its directory is nowhere in it. The domain has to come
 * from the path the file actually sits at, which is `filePath`.
 */
const baseOf = (entry) => relOf(entry).split("/").pop() || "";

/** The first directory under `_articles/`, i.e. the domain the file lives in. */
function dirDomainOf(entry) {
  const parts = relOf(entry).split("/");
  return parts.length > 2 ? parts[1] : "";
}

/**
 * An entry's slug: explicit `slug:` if there is one, otherwise the file name
 * with a leading date removed — the date is metadata, not part of the address.
 */
function slugOf(entry, base) {
  const explicit = String(entry.data.slug || "").trim();
  if (explicit) return slugify(explicit.replace(/^\/+|\/+$/g, "").split("/").pop());
  const name = base.replace(ARTICLE_EXT, "").replace(/^\d{4}-\d{2}-\d{2}[-_]/, "");
  return slugify(name) || slugify(base);
}

function articleRecord(entry, problems) {
  const data = entry.data;
  const name = entry.filePath;
  const dirDomain = dirDomainOf(entry);
  const domain = String(data.domain || "").trim() || dirDomain;
  const slug = slugOf(entry, baseOf(entry));

  if (!slug) problems.error(name, "无法生成 slug。请显式写 slug: <名字>。");
  if (domainByKey(domain) && dirDomain !== domain) {
    problems.error(name,
      `domain 写的是 "${domain}"，但文件在 _articles/${dirDomain}/ 目录下。两处必须一致；`
      + `建议把文件移到 _articles/${domain}/，或删掉 domain 字段让它跟随目录。`);
  }
  const kinds = kindsFor(domain);
  const kind = String(data.kind || "").trim();
  if (kinds.length && !kinds.includes(kind)) {
    const guess = nearMiss(kind, kinds);
    problems.error(name,
      `kind "${kind}" 不属于${domainByKey(domain)?.name || domain}领域。可选：${kinds.join(" / ")}`
      + (guess.length ? `\n        是不是想写：${guess.join(" / ")} ？` : ""));
  }
  if (data.status && !statusByKey(data.status)) {
    problems.error(name, `status "${data.status}" 不认识。可选：draft / notes / in-progress / finished / abandoned`);
  }
  if (data.confidence && !confidenceByKey(data.confidence)) {
    problems.error(name, `confidence "${data.confidence}" 不认识。可选：high / likely / possible / unlikely / unsure`);
  }
  if (data.image && !String(data.image_alt || "").trim()) {
    problems.error(name, "写了 image: 就必须写 image_alt:（一句话描述这张图）");
  }
  if (!data.image && data.image_alt) {
    problems.warn(`${name}: 写了 image_alt 但没有 image，这一行不会有任何效果`);
  }
  if (data.image && data.card && !["image", "image_and_text"].includes(data.card)) {
    problems.error(name, `card "${data.card}" 与 image 不搭。带图的卡片请用 card: image 或 card: image_and_text。`);
  }
  if (String(data.created) > new Date().toISOString().slice(0, 10)) {
    problems.warn(`${name}: created 是 ${data.created}，晚于今天`);
  }

  const body = entry.body || "";
  return {
    kind: "article",
    slug,
    url: `/${domain}/${slug}/`,
    file: fileOf(entry),
    name,
    entry,
    domain,
    domainName: domainByKey(domain)?.name || domain,
    kindName: kind,
    title: data.title,
    description: data.description,
    created: String(data.created),
    modified: data.modified ? String(data.modified) : "",
    status: String(data.status || "").trim() || "notes",
    confidence: String(data.confidence || "").trim(),
    importance: Number(data.importance) || 0,
    tags: (data.tags || []).filter(Boolean),
    series: String(data.series || "").trim(),
    license: String(data.license || "").trim(),
    source: String(data.source || "").trim(),
    card: String(data.card || "").trim().toLowerCase(),
    pin: Number(data.pin) || 0,
    image: String(data.image || "").trim(),
    imageAlt: String(data.image_alt || "").trim(),
    body,
    chars: body.replace(/\s+/g, "").length
  };
}

function collectionRecord(entry, collection, problems) {
  const data = entry.data;
  const name = entry.filePath;
  const base = baseOf(entry);
  const slug = slugOf(entry, base);
  if (!slug) problems.error(name, "无法生成 slug，请显式写 slug:。");

  const status = statusOf(collection.key, data.status);
  if (data.status && !status) {
    problems.error(name,
      `status "${data.status}" 不属于${collection.name}。可选：${collection.statuses.map((s) => s.key).join(" / ")}`);
  }
  if (data.image && !String(data.image_alt || "").trim()) {
    problems.error(name, "写了 image: 就必须写 image_alt:（一句话描述这张图）");
  }
  if (data.image && data.card && !["image", "image_and_text"].includes(data.card)) {
    problems.error(name, `card "${data.card}" 与 image 不搭。带图的卡片请用 card: image 或 card: image_and_text。`);
  }

  const body = entry.body || "";
  return {
    kind: "collection",
    collection: collection.key,
    collectionName: collection.name,
    // whether this collection's entries are pages at all — see taxonomy.mjs
    linked: collection.linked !== false,
    slug,
    url: collection.linked === false ? "" : `/${collection.key}/${slug}/`,
    file: fileOf(entry),
    name,
    entry,
    title: data.title,
    author: String(data.author || "").trim(),
    note: String(data.note || "").trim(),
    description: String(data.description || "").trim() || String(data.note || "").trim(),
    created: String(data.created),
    status: status ? status.key : "",
    statusName: status ? status.name : "",
    chip: (status && status.chip) || collection.chip,
    tags: (data.tags || []).filter(Boolean),
    card: String(data.card || "").trim().toLowerCase(),
    pin: Number(data.pin) || 0,
    image: String(data.image || "").trim(),
    imageAlt: String(data.image_alt || "").trim(),
    body,
    chars: body.replace(/\s+/g, "").length
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* the link graph                                                        */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * What sentence a link sits in — the context that makes a backlink useful rather
 * than a bare list of titles. Semantic linefeeds (one sentence per line, the
 * convention this site writes in) make this exact rather than approximate.
 *
 * `{{ref:slug|label}}` collapses to its LABEL, not to nothing: dropping it leaves
 * the sentence without its subject. With no explicit label the target's own title
 * reads as the natural stand-in. Every form of the marker collapses the same way,
 * so `#sec-1|…` can never leak into a quoted sentence.
 */
function contextForLine(line, label) {
  const cleaned = plain(String(line)
    .replace(refRe(), (whole, rawSlug, second, third) => {
      const ref = parseRef(rawSlug, second, third);
      return ref.label || label || "";
    })
    .replace(/!{3}\s*/g, "")               // margin-note marker
    .replace(/\^\^?\[[^\]]*\]/g, "")       // note bodies are not context
    .replace(/[*_`>#]/g, ""))
    .trim();
  return cleaned.length > 160 ? cleaned.slice(0, 157) + "…" : cleaned;
}

function buildLinkGraph(articles, bySlug, problems) {
  const outgoing = new Map(articles.map((a) => [a.slug, []]));
  const backlinks = new Map(articles.map((a) => [a.slug, []]));

  for (const a of articles) {
    for (const [index, line] of a.body.split(/\r?\n/).entries()) {
      const re = refRe();
      let m;
      while ((m = re.exec(line))) {
        const ref = parseRef(m[1], m[2], m[3]);
        const hit = bySlug.get(ref.target);
        if (!hit) {
          const guess = nearMiss(ref.target, [...bySlug.keys()]);
          problems.error(a.name, `{{ref:${ref.target}}} 找不到这篇文章。`
            + (guess.length ? `是不是想写：${guess.join(" / ")} ？` : "用 npm run check:links 可以看到全部可用 slug。"));
          continue;
        }
        if (hit.slug === a.slug) {
          problems.warn(`${a.name}: {{ref:${ref.target}}} 指向自己，已忽略`);
          continue;
        }
        // A malformed anchor still links, but it silently drops the reader at the
        // top of the page and never produces a section backlink — exactly the
        // kind of quiet failure the anchor check also guards against.
        if (ref.anchored && !REF_ANCHOR_RE.test(ref.anchor)) {
          problems.error(a.name,
            `{{ref:${ref.target}|#${ref.anchor}}} 的锚点应该是 sec-数字，例如 {{ref:${ref.target}|#sec-2}}。`);
          continue;
        }
        outgoing.get(a.slug).push({
          to: hit.slug, toUrl: hit.url, toTitle: hit.title,
          anchor: ref.anchor, label: ref.label, context: contextForLine(line, hit.title), line: index + 1
        });
        backlinks.get(hit.slug).push({
          from: a.slug, fromUrl: a.url, fromTitle: a.title,
          fromDomain: a.domain, fromKind: a.kindName,
          anchor: ref.anchor, label: ref.label, context: contextForLine(line, hit.title)
        });
      }
    }
  }

  // stable order: newest first, so a backlink list leads with the current work
  const byDate = new Map(articles.map((a) => [a.slug, a.created]));
  for (const list of backlinks.values()) {
    list.sort((a, b) => (byDate.get(a.from) < byDate.get(b.from) ? 1 : -1));
  }
  return { outgoing, backlinks };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* derived collections                                                   */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * Tags span BOTH content kinds.
 *
 * They were originally collected from articles alone, so a tag on a reading or
 * hobby entry rendered as a chip that linked to a tag page the build never
 * created — 404s that only the smoke suite (which walks every href) caught. A tag
 * is a property of the collection, not of one content type.
 */
function collectTags(articles, collections) {
  const map = new Map();
  for (const item of [...articles, ...Object.values(collections).flat()]) {
    for (const tag of item.tags || []) {
      if (!map.has(tag)) map.set(tag, []);
      map.get(tag).push(item);
    }
  }
  return [...map].map(([name, items]) => ({
    name,
    items: items.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0)),
    count: items.length,
    // A tag with only one piece under it has nothing to summarise: printing that
    // piece's own description under the tag just repeats a sentence the reader is
    // about to see again.
    blurb: items.length > 1 ? (items[0].description || items[0].title) : ""
  })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

function collectSeries(articles) {
  const map = new Map();
  for (const item of articles) {
    if (!item.series) continue;
    if (!map.has(item.series)) map.set(item.series, []);
    map.get(item.series).push(item);
  }
  return [...map].map(([name, items]) => ({
    name, items: items.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0))
  })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * "Similar links" — the pieces a reader is most likely to want next.
 *
 * gwern builds these from a neural embedding of the text. There is no model here,
 * so the signal is shared tags weighted by how rare they are, plus the same
 * series. A tag used twice says far more about two pieces than one used twenty
 * times, and a raw overlap count would mostly surface whichever tag happens to be
 * most popular. Links that are already explicit `{{ref:}}` pairs are dropped: the
 * reader sees those in 本篇引用 / 反向链接, and repeating them here would make the
 * rail look fuller without saying anything new.
 */
function relatedFor(articles, outgoing, backlinks) {
  const tagCount = new Map();
  for (const a of articles) for (const t of a.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);

  const related = new Map();
  for (const a of articles) {
    const explicit = new Set([
      ...(outgoing.get(a.slug) || []).map((l) => l.to),
      ...(backlinks.get(a.slug) || []).map((b) => b.from)
    ]);
    const scored = articles.flatMap((b) => {
      if (b.slug === a.slug || explicit.has(b.slug)) return [];
      const shared = b.tags.filter((t) => a.tags.includes(t));
      const sameSeries = Boolean(a.series && a.series === b.series);
      if (!shared.length && !sameSeries) return [];
      return [{
        item: b,
        score: shared.reduce((sum, tag) => sum + 1 / (tagCount.get(tag) + 1), 0) + (sameSeries ? 2 : 0),
        why: sameSeries ? [`系列 · ${a.series}`, ...shared] : shared
      }];
    });
    scored.sort((x, y) => y.score - x.score || y.item.created.localeCompare(x.item.created));
    related.set(a.slug, scored.slice(0, 4).map(({ item, why }) => ({
      url: item.url, title: item.title, domainName: item.domainName, kind: item.kindName, why
    })));
  }
  return related;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* the model                                                             */
/* ══════════════════════════════════════════════════════════════════════ */

async function createModel() {
  const problems = new Problems();
  const [rawArticles, rawReading, rawHobbies] = await Promise.all([
    getCollection("articles"), getCollection("reading"), getCollection("hobbies")
  ]);

  if (!rawArticles.length) {
    throw new Error("没有找到任何文章。_articles/ 下需要有 <领域>/ 目录与 .md 文件。");
  }

  const articles = rawArticles.map((e) => articleRecord(e, problems));
  const collections = {};
  for (const c of COLLECTIONS) {
    const raw = c.key === "reading" ? rawReading : rawHobbies;
    collections[c.key] = raw.map((e) => collectionRecord(e, c, problems))
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  // ---- slugs are one namespace -----------------------------------------
  const seenSlug = new Map();
  for (const item of [...articles, ...Object.values(collections).flat()]) {
    if (seenSlug.has(item.slug)) {
      problems.error(item.name,
        `slug "${item.slug}" 与 ${seenSlug.get(item.slug)} 冲突。给其中一篇写 slug: <别的名字>。`);
    } else {
      seenSlug.set(item.slug, item.name);
    }
  }

  if (problems.failed) fail(problems);

  const bySlug = new Map(articles.map((a) => [a.slug, a]));
  const { outgoing, backlinks } = buildLinkGraph(articles, bySlug, problems);

  // ---- render ----------------------------------------------------------
  // One pass, sequentially: `resolve` is the whole link graph, which is only
  // known once every article's slug exists, and a forward reference must not
  // fail merely because the target file sorts later.
  const resolve = (slug) => {
    const hit = bySlug.get(slug);
    return hit ? { url: hit.url, title: hit.title, slug: hit.slug } : null;
  };

  for (const a of articles) {
    // Only anchored backlinks can be placed inside a section; the page-level list
    // below the article still carries everything.
    const perSection = new Map();
    for (const b of backlinks.get(a.slug) || []) {
      if (!b.anchor) continue;
      if (!perSection.has(b.anchor)) perSection.set(b.anchor, []);
      perSection.get(b.anchor).push(b);
    }
    const rendered = await renderBody(a.body, { resolve, backlinks: perSection });
    a.html = rendered.html;
    a.headings = rendered.headings;
    a.allHeadings = rendered.allHeadings;
    a.revisions = revisionsFor(ROOT, a.file);
    if (rendered.unusedCitations.length) {
      problems.warn(`${a.name}: 这些引用定义了但正文里没用到 —— ${rendered.unusedCitations.join(", ")}`);
    }
  }

  for (const list of Object.values(collections)) {
    for (const item of list) {
      const rendered = await renderBody(item.body, { resolve });
      item.html = rendered.html;
      item.headings = rendered.headings;
    }
  }

  // ---- anchored refs must land somewhere -------------------------------
  // A `{{ref:x|#sec-2}}` whose anchor does not exist still returns 200, so the
  // link checker would not notice: the reader lands at the top of the page and
  // the section backlink never appears. Check the fragment against the target's
  // real headings while both are still in hand.
  for (const a of articles) {
    for (const o of outgoing.get(a.slug) || []) {
      if (!o.anchor) continue;
      const ids = (bySlug.get(o.to)?.allHeadings || []).map((h) => h.id);
      if (!ids.includes(o.anchor)) {
        const secs = ids.filter((id) => /^sec-\d+$/.test(id));
        problems.error(a.name,
          `{{ref:${o.to}|#${o.anchor}}} 指向的章节不存在。`
          + `${o.to} 现有章节：${secs.length ? secs.join(" / ") : "（没有编号章节）"}`);
      }
    }
  }

  // ---- card covers -----------------------------------------------------
  // The derivatives are committed under public/img/, so this only reads. A
  // missing one is a content error rather than a silent gap in the grid.
  for (const item of [...articles, ...Object.values(collections).flat()]) {
    item.picture = item.image ? cardJson(item.slug, item.imageAlt, ROOT) : null;
    if (item.image && !item.picture) {
      const master = findMaster(item.image, item.file.slice(ROOT.length + 1), ROOT);
      problems.error(item.name, master
        ? `image: ${item.image} 找到了母图，但没有衍生图。运行 npm run images 生成 ${WIDTHS.map((w) => derivativeName(item.slug, w)).join(" / ")}。`
        : `image: ${item.image} 找不到，也没有已生成的衍生图。放在条目旁边或 _images/，然后运行 npm run images。`);
    }
  }

  articles.sort((a, b) => b.created.localeCompare(a.created));

  // ---- everything else -------------------------------------------------
  const site = loadSite(ROOT);
  const tags = collectTags(articles, collections);
  const series = collectSeries(articles);
  const byDomain = new Map(DOMAINS.map((d) => [d.key, articles.filter((a) => a.domain === d.key)]));
  const counts = Object.fromEntries(DOMAINS.map((d) => [d.key, byDomain.get(d.key).length]));
  Object.assign(counts, { tags: tags.length, archive: articles.length, search: articles.length });

  const related = relatedFor(articles, outgoing, backlinks);

  const searchIndex = articles.map((a) => ({
    slug: a.slug, url: a.url, title: a.title, description: a.description,
    domain: a.domain, domainName: a.domainName, kind: a.kindName,
    year: a.created.slice(0, 4), date: a.created, tags: a.tags,
    status: a.status, chars: a.chars,
    // notes and refs are included: a note often carries the detail someone is
    // searching for
    text: plain(a.html).slice(0, 20000)
  }));

  if (problems.failed) fail(problems);
  problems.report(console.warn, "内容警告（不阻断构建）");

  const noLinks = articles.filter((a) =>
    !(outgoing.get(a.slug) || []).length && !(backlinks.get(a.slug) || []).length);
  if (noLinks.length) {
    console.warn(`   · ${noLinks.length} 篇文章既没有引用别人，也没有被别人引用：${noLinks.map((a) => a.slug).join(", ")}`);
  }

  return {
    root: ROOT, site, problems,
    articles, collections, bySlug,
    outgoing, backlinks, related,
    tags, series, counts, byDomain,
    searchIndex,
    sections: sectionIndex(byDomain, collections),
    articleRedirects: articles.map((a) => ({ from: `/articles/${a.slug}/`, to: a.url }))
  };
}

/**
 * Every address that lists a grid: `/writing/`, the three domains, and the
 * collections. One list, so the index routes and the checks that walk them
 * cannot drift apart.
 */
function sectionIndex(byDomain, collections) {
  const out = [];
  for (const d of DOMAINS) {
    out.push({ type: "domain", key: d.key, name: d.name, blurb: d.blurb, accent: d.accent, items: byDomain.get(d.key) });
  }
  for (const c of COLLECTIONS) {
    out.push({ type: "collection", key: c.key, name: c.name, blurb: c.blurb, accent: c.accent,
      items: collections[c.key] || [], collection: c });
  }
  return out;
}

function fail(problems) {
  problems.report(console.error, "✗ 内容有问题");
  throw new Error("内容校验未通过，构建中止。");
}

/** `{ slug }` for a dynamic route: a full list of what each section holds. */
export const sectionFor = (model, key) =>
  model.sections.find((s) => s.key === key) || null;

export const collectionFor = (key) => collectionByKey(key);

/* memoised: one computation per build, shared by every page */
let pending;
export function getSiteModel() {
  if (!pending) pending = createModel();
  return pending;
}
