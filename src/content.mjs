/**
 * content.mjs — turning `_articles/<domain>/*.md` into article records.
 *
 * The article model is deliberately gwern-shaped: a metadata block that states
 * what a piece is and how finished it is, a body that can be read at several
 * depths, and links that are tracked in BOTH directions.
 *
 * Loading happens in two passes. Pass one reads front matter and validates the
 * taxonomy; pass two renders bodies, because `{{ref:}}` targets are not known
 * until every article's slug exists — a forward reference must not fail merely
 * because the target file sorts later.
 */

import fs from "node:fs";
import path from "node:path";
import {
  esc, plain, readText, walk, relative, nearMiss, slugify, todayISO
} from "./lib.mjs";
import {
  DOMAINS, STATUSES, CONFIDENCES, domainByKey, domainKeys, kindsFor,
  statusByKey, confidenceByKey, DEFAULT_STATUS
} from "./taxonomy.mjs";

/* ══════════════════════════════════════════════════════════════════════ */
/* front matter                                                          */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * Front matter parser.
 *
 * Handles the shapes this site actually uses: `key: value`, `key: [a, b]`, and
 * bare list items under a key (for nested lists like a per-article sources
 * block). It is not YAML and does not pretend to be — the day a real YAML
 * parser is needed, this should be replaced rather than extended.
 *
 * Returns `hasBlock` so the caller can distinguish "no front matter" from
 * "front matter present but all fields empty" — those need different errors.
 */
export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, hasBlock: false };

  const data = {};
  let currentKey = null;

  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // continuation of a list: "  - value"
    const listItem = /^\s+[-*]\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(unquote(listItem[1]));
      continue;
    }

    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    currentKey = key;

    if (value === "") {
      data[key] = "";               // may become a list if items follow
    } else if (/^\[.*\]$/.test(value)) {
      data[key] = value.slice(1, -1).split(",")
        .map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }

  return { data, body: text.slice(m[0].length), hasBlock: true };
}

const unquote = (s) => String(s).replace(/^["']|["']$/g, "").trim();

/** Booleans written as `true`/`yes`/`1` in front matter. */
const truthy = (v) => /^(true|yes|1|on)$/i.test(String(v || "").trim());

/* ══════════════════════════════════════════════════════════════════════ */
/* footnotes / sidenotes                                                 */
/* ══════════════════════════════════════════════════════════════════════ */
/*
 * gwern puts footnotes in the margin as sidenotes on wide screens and falls
 * back to floating footnotes on narrow ones. That fallback is the whole
 * point — the note must be readable when there is no margin — so notes are
 * emitted INLINE in the markup and CSS decides where they land. Emitting them
 * at the end of the document and floating them via JS would break with
 * scripting off, which this site forbids.
 *
 * Two forms:
 *   ^[text]    inline note — a phrase or two
 *   ^^[text]   block note  — may contain paragraphs
 */

const MARKER_RE = /(\^\^\[|\^\[)/g;

/** Split a bracket body respecting nesting, so ^[a [b] c] survives. */
function takeBracket(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return { inner: text.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Replace every footnote marker with an inline `<aside>`, numbering as it goes.
 * Runs BEFORE marked, so the note body is itself rendered as Markdown.
 *
 * Registers each note so the page can also emit a plain end-of-article list of
 * every note for print and for readers with sidenotes switched off.
 */
export function replaceFootnotes(src, notes) {
  let out = "";
  let i = 0;
  let last = 0;

  while (i < src.length) {
    MARKER_RE.lastIndex = i;
    const m = MARKER_RE.exec(src);
    if (!m) break;

    const isBlock = m[1] === "^^[";
    const openIndex = m.index + m[1].length - 1;
    const taken = takeBracket(src, openIndex);
    if (!taken) { i = m.index + m[1].length; continue; }

    // A marker must start a token, or `x^[y]` would fire inside a word.
    const before = src[m.index - 1];
    if (before && /[A-Za-z0-9\u4e00-\u9fff]/.test(before)) { i = openIndex; continue; }

    const n = notes.length + 1;
    const id = `fn${n}`;
    const refId = `fnref${n}`;
    const marker = String(n);

    notes.push({ n, id, refId, body: taken.inner.trim(), block: isBlock });

    out += src.slice(last, m.index);
    out += isBlock
      ? `\n\n<aside class="note note--block" id="${id}" role="doc-footnote" aria-label="脚注 ${marker}"><span class="note__n" aria-hidden="true">${marker}</span><div class="note__body">\n\n${taken.inner.trim()}\n\n</div></aside>\n\n`
      : `<aside class="note" id="${id}" role="doc-footnote" aria-label="脚注 ${marker}"><span class="note__n" aria-hidden="true">${marker}</span><span class="note__body">${taken.inner.trim()}</span></aside>`;

    // the superscript reference stays in the text flow
    out += `<sup class="fnref"><a id="${refId}" href="#${id}" aria-describedby="${id}">[${marker}]</a></sup>`;

    last = taken.end;
    i = taken.end;
  }

  out += src.slice(last);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* margin notes ("段旁概括")                                              */
/* ══════════════════════════════════════════════════════════════════════ */
/*
 * gwern sets a short phrase in the margin beside a paragraph so the page can be
 * skimmed. In CJK the margin is the wrong place: a narrow column would squeeze
 * the 30–34-character reading measure, and 汉字 have no lowercase/smallcap
 * contrast to lean on. So the summary is set as a small line ABOVE the
 * paragraph — same skimming benefit, no measure damage.
 *
 * Syntax:  !!! 概括文字        on its own line, applies to the next paragraph
 */
export function replaceMarginNotes(src) {
  return src.replace(/^[ \t]*!!!\s*(.+)$/gm, (_, text) =>
    `\n\n<div class="marginnote">${esc(text.trim())}</div>\n\n`);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* internal references                                                   */
/* ══════════════════════════════════════════════════════════════════════ */

export const REF_RE = /\{\{ref:([^}|]+)(?:\|([^}]*))?\}\}/g;

/** Parse `{{ref:slug|label}}` into placeholders, recording each link so the
 *  reverse index can be built. Resolution happens in pass two. */
export function extractRefs(src, articleSlug) {
  const links = [];
  const text = src.replace(REF_RE, (_, rawSlug, label) => {
    const target = slugify(rawSlug.trim()) || rawSlug.trim();
    const anchor = label && /^#/.test(label.trim()) ? label.trim().slice(1) : "";
    links.push({ target, anchor, label: (label || "").replace(/^#/, "").trim(), from: articleSlug });
    return `\u0000REF${links.length - 1}\u0000`;
  });
  return { text, links };
}

/** Put resolved links back into the rendered HTML. */
export function restoreRefs(html, links, resolve) {
  return html.replace(/\u0000REF(\d+)\u0000/g, (_, n) => {
    const link = links[Number(n)];
    if (!link) return "";
    const hit = resolve(link.target);
    if (!hit) {
      // unresolved targets are reported by the caller; render the label so the
      // sentence still reads rather than dropping words silently
      return `<span class="ref-broken" title="找不到：${esc(link.target)}">${esc(link.label || link.target)}</span>`;
    }
    const href = `${hit.url}${link.anchor ? "#" + encodeURIComponent(link.anchor) : ""}`;
    const text = link.label || hit.title;
    return `<a class="ref" href="${esc(href)}" data-preview="${esc(hit.slug)}">${esc(text)}</a>`;
  });
}

/* ══════════════════════════════════════════════════════════════════════ */
/* loading                                                               */
/* ══════════════════════════════════════════════════════════════════════ */

const ARTICLE_EXT = /\.(md|markdown)$/i;

/** What sentence a link sits in — the context that makes a backlink useful
 *  rather than a bare list of titles. Semantic linefeeds (one sentence per
 *  line, the convention this site writes in) make this exact rather than
 *  approximate.
 *
 *  `{{ref:slug|label}}` collapses to its LABEL, not to nothing: dropping it
 *  leaves the sentence without its subject. With no explicit label the target's
 *  own title reads as the natural stand-in, which is why the caller passes it. */
function contextForLine(text, label) {
  const cleaned = plain(String(text)
    .replace(/\{\{ref:[^}|]*(?:\|([^}]*))?\}\}/g, (_, cap) => (cap || label || ""))
    .replace(/!{3}\s*/g, "")               // margin-note marker
    .replace(/\^\^?\[[^\]]*\]/g, "")       // footnote bodies are not context
    .replace(/[*_`>#]/g, ""))
    .trim();
  return cleaned.length > 160 ? cleaned.slice(0, 157) + "…" : cleaned;
}

/**
 * Pass one: read every article's front matter and validate it against the
 * taxonomy. Returns records WITHOUT rendered HTML.
 */
export function loadSources(root, problems, log) {
  const dir = path.join(root, "_articles");
  const files = walk(dir).filter((f) => ARTICLE_EXT.test(f));
  const records = [];
  const seenSlugs = new Map();

  for (const file of files) {
    const name = relative(root, file);
    const { text, hadBom } = readText(file);
    if (hadBom) problems.warn(`${name}: 文件带 UTF-8 BOM（记事本常见），已自动忽略`);

    const { data, body, hasBlock } = parseFrontMatter(text);
    if (!hasBlock) {
      problems.error(name, "没有 front matter。文件必须以 --- 开头，第一段是 title/domain/kind 等字段。");
      continue;
    }

    // ---- domain: declared in front matter AND implied by the folder ----
    const dirDomain = path.relative(dir, file).split(path.sep)[0];
    const declaredDomain = String(data.domain || "").trim();
    const domain = declaredDomain || dirDomain;
    if (!domainByKey(domain)) {
      const guess = nearMiss(domain, domainKeys());
      problems.error(name,
        `domain "${domain}" 不是合法领域。可选：${domainKeys().join(" / ")}` +
        (guess.length ? `\n        是不是想写：${guess.join(" / ")} ？` : ""));
      continue;
    }
    if (declaredDomain && dirDomain !== declaredDomain) {
      problems.error(name,
        `domain 写的是 "${declaredDomain}"，但文件在 ${dirDomain}/ 目录下。两处必须一致；` +
        `建议把文件移到 _articles/${declaredDomain}/，或删掉 domain 字段让它跟随目录。`);
      continue;
    }

    // ---- kind: must belong to this domain ----
    const kind = String(data.kind || "").trim();
    const legalKinds = kindsFor(domain);
    if (!kind) {
      problems.error(name, `缺 kind。${domainByKey(domain).name}领域的可选类型：${legalKinds.join(" / ")}`);
      continue;
    }
    if (!legalKinds.includes(kind)) {
      const guess = nearMiss(kind, legalKinds);
      problems.error(name,
        `kind "${kind}" 不属于${domainByKey(domain).name}领域。可选：${legalKinds.join(" / ")}` +
        (guess.length ? `\n        是不是想写：${guess.join(" / ")} ？` : ""));
      continue;
    }

    // ---- title / description / date ----
    const title = String(data.title || "").trim();
    if (!title) problems.error(name, "缺 title。");

    const description = String(data.description || "").trim();
    if (!description) {
      problems.error(name, "缺 description。它是元信息块、搜索索引与悬浮预览的来源，一到三句话。");
    }

    const created = String(data.created || "").trim() || fs.statSync(file).mtime.toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(created)) {
      problems.error(name, `created 必须是 YYYY-MM-DD，现在是 "${created}"`);
    } else if (created > todayISO()) {
      problems.warn(`${name}: created 是 ${created}，晚于今天`);
    }

    const modified = String(data.modified || "").trim();
    if (modified && !/^\d{4}-\d{2}-\d{2}$/.test(modified)) {
      problems.error(name, `modified 必须是 YYYY-MM-DD，现在是 "${modified}"`);
    }

    // ---- status / confidence ----
    const status = String(data.status || "").trim() || DEFAULT_STATUS;
    if (!statusByKey(status)) {
      problems.error(name,
        `status "${status}" 不认识。可选：${STATUSES.map((s) => s.key).join(" / ")}`);
    }
    const confidence = String(data.confidence || "").trim();
    if (confidence && !confidenceByKey(confidence)) {
      problems.error(name,
        `confidence "${confidence}" 不认识。可选：${CONFIDENCES.map((c) => c.key).join(" / ")}`);
    }

    let importance = 0;
    if (data.importance !== undefined && String(data.importance).trim() !== "") {
      importance = Number(data.importance);
      if (!Number.isFinite(importance) || importance < 0 || importance > 10) {
        problems.error(name, `importance 必须是 0–10 的数字，现在是 "${data.importance}"`);
        importance = 0;
      }
    }

    // ---- slug: explicit or derived; explicitly frozen once published ----
    const base = path.basename(file).replace(ARTICLE_EXT, "");
    // leading date in the filename is metadata, not part of the URL
    const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}[-_]/, "");
    const explicit = String(data.slug || "").trim();
    let slug;
    if (explicit) {
      slug = explicit.replace(/^\/+|\/+$/g, "").split("/").pop();
      slug = slugify(slug);
    } else {
      slug = slugify(withoutDate) || slugify(base);
    }
    if (!slug) {
      problems.error(name, "无法生成 slug。请显式写 slug: <名字>。");
      continue;
    }
    if (seenSlugs.has(slug)) {
      problems.error(name, `slug "${slug}" 与 ${seenSlugs.get(slug)} 冲突。给其中一篇写 slug: <别的名字>。`);
      continue;
    }
    seenSlugs.set(slug, name);

    const url = `/${domain}/${slug}/`;

    records.push({
      slug,
      url,
      file,
      name,
      domain,
      domainName: domainByKey(domain).name,
      kind,
      title,
      description,
      created,
      modified: modified || "",
      status,
      confidence,
      importance,
      tags: (Array.isArray(data.tags) ? data.tags : []).filter(Boolean),
      series: String(data.series || "").trim(),
      license: String(data.license || "").trim(),
      source: String(data.source || "").trim(),     // 「写作地点」/「献给」等自由字段
      body,
      chars: body.replace(/\s+/g, "").length
    });
  }

  log(`  ${records.length} 篇`);
  return records;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* link graph                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * Build the forward and reverse link graphs.
 *
 * Forward links (this page cites) and backlinks (other pages citing this one)
 * are the same data read in two directions, so they are collected once. Each
 * entry keeps the anchor it points at and the sentence it sits in — a backlink
 * without context is a bare title list, and the context is what makes it worth
 * showing at all.
 */
export function buildLinkGraph(records, problems) {
  const bySlug = new Map(records.map((r) => [r.slug, r]));
  const byTag = new Map();
  for (const r of records) {
    for (const t of r.tags) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(r.slug);
    }
  }

  const outgoing = new Map(records.map((r) => [r.slug, []]));
  const backlinks = new Map(records.map((r) => [r.slug, []]));

  for (const r of records) {
    const lines = r.body.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      REF_RE.lastIndex = 0;
      let m;
      while ((m = REF_RE.exec(line))) {
        const target = slugify(m[1].trim()) || m[1].trim();
        const label = (m[2] || "").replace(/^#/, "").trim();
        const anchor = m[2] && /^#/.test(m[2].trim()) ? m[2].trim().slice(1) : "";

        const hit = bySlug.get(target);
        if (!hit) {
          const guess = nearMiss(target, [...bySlug.keys()]);
          problems.error(r.name,
            `{{ref:${target}}} 找不到这篇文章。` +
            (guess.length ? `是不是想写：${guess.join(" / ")} ？` : "用 npm run check:links 可以看到全部可用 slug。"));
          continue;
        }
        if (hit.slug === r.slug) {
          problems.warn(`${r.name}: {{ref:${target}}} 指向自己，已忽略`);
          continue;
        }
        if (/^#/.test(m[2] || "")) {
          problems.warn(`${r.name}: {{ref:${target}}} 用了 # 前缀写法，现在直接写 {{ref:${target}}} 即可`);
        }

        outgoing.get(r.slug).push({
          to: hit.slug, toUrl: hit.url, toTitle: hit.title,
          anchor, label, context: contextForLine(line, hit.title), line: index + 1
        });
        backlinks.get(hit.slug).push({
          from: r.slug, fromUrl: r.url, fromTitle: r.title,
          fromDomain: r.domain, fromKind: r.kind,
          anchor, label, context: contextForLine(line, hit.title)
        });
      }
    }
  }

  // stable order: newest first, so a backlink list leads with the current work
  const byDate = new Map(records.map((r) => [r.slug, r.created]));
  for (const list of backlinks.values()) {
    list.sort((a, b) => (byDate.get(a.from) < byDate.get(b.from) ? 1 : -1));
  }

  return { bySlug, byTag, outgoing, backlinks };
}
