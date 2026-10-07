/**
 * sitetext.mjs — this site's own writing syntax, on the way into Markdown.
 *
 * Five block forms and three inline forms, all of them brackets around ORDINARY
 * Markdown:
 *
 *   !!! 文字            margin note — a skimmable summary of the next paragraph
 *   !!! note 标题       admonition, with a type and an optional title
 *   +++ [标题]          a foldable block
 *   >>> 引文 — 出处      an epigraph
 *   ::: columns         a list that goes multi-column on wide screens
 *
 *   ^[text]             inline note
 *   ^^[text]            block note
 *   [^key] / [^key]:    keyed citation
 *   {{ref:slug|…}}      a link to another piece on this site
 *
 * They are handled HERE, on the text, rather than as AST visitors, and that is
 * deliberate: every one of them brackets a region of ordinary Markdown, so
 * rewriting the text leaves the body being parsed normally instead of handing a
 * parser a token stream it has to re-derive. The cost is that a block marker
 * must sit on its own line at column zero, which is exactly how it is written.
 * The structural work that IS about the tree — heading anchors, sections,
 * section backlinks, link classes — happens in markdown.mjs on the AST.
 *
 * Half of these forms used to live in content.mjs and half in render.mjs, and
 * they disagreed: `!!!` was claimed by two passes in two modules, and the
 * margin-note pass ran first and quietly ate every admonition. They are all in
 * one file now, in one order, and the order is the contract.
 */

import { esc, slugify } from "./text.mjs";

/* ══════════════════════════════════════════════════════════════════════ */
/* internal references                                                   */
/* ══════════════════════════════════════════════════════════════════════ */

export const REF_RE = /\{\{ref:([^}|]+)(?:\|([^}|]*))?(?:\|([^}]*))?\}\}/g;

/**
 * A fresh matcher for `{{ref:}}`.
 *
 * Never reuse the module-level regex across nested calls. A global regex carries
 * `lastIndex`, and `String.replace` resets it to 0 when it finishes — so a
 * `replace` performed inside an `exec` loop silently restarts that loop from the
 * top. That is not a wrong answer, it is an infinite one: the build fills memory
 * and dies with a V8 stack dump. Every call site gets its own matcher instead.
 */
export const refRe = () => new RegExp(REF_RE.source, "g");

/** The only anchors a `{{ref:}}` may point at. Heading ids are positional by
 *  design, so this shape is stable across rewordings — see markdown.mjs. */
export const REF_ANCHOR_RE = /^sec-\d+$/;

/**
 * Parse one `{{ref:…}}` occurrence. Four forms, told apart by whether the second
 * field starts with `#`:
 *
 *   {{ref:slug}}                 link text is the target's title
 *   {{ref:slug|显示文字}}         explicit link text
 *   {{ref:slug|#sec-2}}          a section of the target; text is its title
 *   {{ref:slug|#sec-2|显示文字}}  a section, with explicit link text
 *
 * The anchored forms are what make section-level backlinks possible: the target
 * page can then show "cited here" inside the very section being cited instead of
 * only listing the page at the bottom. The renderer and the link graph both go
 * through this one function, so the two can never disagree about what a link is.
 */
export function parseRef(rawSlug, second, third) {
  const target = slugify(rawSlug.trim()) || rawSlug.trim();
  const isAnchor = /^#/.test((second || "").trim());
  const anchor = isAnchor ? second.trim().slice(1) : "";
  const label = (isAnchor ? third : second) || "";
  return { target, anchor, label: label.trim(), anchored: isAnchor };
}

/** One link, rendered. `resolve` returns `{url, title, slug}` or null. */
function linkHtml(link, resolve) {
  const hit = resolve(link.target);
  if (!hit) {
    // An unresolved target is reported by the caller; render the label so the
    // sentence still reads rather than dropping words silently.
    return `<span class="ref-broken" title="找不到：${esc(link.target)}">${esc(link.label || link.target)}</span>`;
  }
  const href = `${hit.url}${link.anchor ? "#" + encodeURIComponent(link.anchor) : ""}`;
  return `<a class="ref" href="${esc(href)}" data-preview="${esc(hit.slug)}">${esc(link.label || hit.title)}</a>`;
}

/** Replace every `{{ref:…}}` in a block of text with its link. */
export function resolveRefs(text, resolve) {
  return text.replace(refRe(), (whole, rawSlug, second, third) =>
    linkHtml(parseRef(rawSlug, second, third), resolve));
}

/**
 * The same replacement, as parts instead of HTML.
 *
 * The reference list is built as hast, where a string of HTML is no use: an
 * anchor written into it would be text, not a link. So the citation definitions
 * come back as a list of `{ text }` / `{ link }` runs and the AST plugin turns
 * each into the right node. One parser, two output shapes.
 */
export function resolveRefParts(text, resolve) {
  const parts = [];
  let last = 0;
  const re = refRe();
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const link = parseRef(m[1], m[2], m[3]);
    const hit = resolve(link.target);
    parts.push({ link: { ...link, hit, label: link.label || (hit ? hit.title : link.target) } });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* block forms                                                           */
/* ══════════════════════════════════════════════════════════════════════ */

const ADMONITIONS = {
  note: { name: "附注", glyph: "※" },
  aside: { name: "旁白", glyph: "◇" },
  warn: { name: "注意", glyph: "!" },
  quote: { name: "引文", glyph: "❝" },
  tip: { name: "提示", glyph: "✦" }
};

/**
 * A line that begins — and therefore terminates — one of these blocks.
 *
 * Loosely anchored on purpose. `+++ 标题` is a block fold just as much as the
 * bracketed `+++[标题]` form, and `:::` stands alone. An earlier version
 * demanded a space after every marker in some scanners and not others, so a
 * bare `:::` failed to end the block above it and the two ran together. One
 * pattern, used by every scanner.
 */
const BLOCK_START = /^(?:!!!|\+\+\+|---|>>>|:::)(?:\s|$)/;
const isBlockStart = (line) => BLOCK_START.test(line) || /^#{1,6}\s/.test(line);

/** Gather the body of a block that starts at `i`. */
function gatherBody(lines, i) {
  const body = [];
  let j = i + 1;
  while (j < lines.length && !isBlockStart(lines[j])) {
    body.push(lines[j]);
    j++;
  }
  return { body, end: j - 1 };
}

/**
 * The `!` family: margin notes and admonitions.
 *
 * `!!!` and `!!!note` are the SAME first token, so they are scanned together
 * here and the split is visible: a known type word opens an admonition, anything
 * else is a margin note whose text is the rest of the line.
 */
function replaceBangs(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^!!!\s*([a-zA-Z]+)?\s*(.*)$/.exec(lines[i]);
    if (!m) { out.push(lines[i]); continue; }

    const type = (m[1] || "").toLowerCase();
    const rest = (m[2] || "").trim();

    if (type && Object.prototype.hasOwnProperty.call(ADMONITIONS, type)) {
      const conf = ADMONITIONS[type];
      const { body, end } = gatherBody(lines, i);
      i = end;
      // blank lines around the div, or the parser treats it as inline HTML
      // inside an enclosing paragraph and escapes the whole thing
      out.push("", `<div class="admon admon--${esc(type)}" role="note">`,
        `<p class="admon__title"><span class="admon__glyph" aria-hidden="true">${conf.glyph}</span>${esc(rest || conf.name)}</p>`,
        "", body.join("\n").trim(), "", "</div>", "");
      continue;
    }

    // anything else is a margin note; the type word, if any, is part of its text
    const text = ((m[1] ? m[1] + " " : "") + rest).trim();
    out.push("", `<div class="marginnote">${esc(text)}</div>`, "");
  }
  return out.join("\n");
}

/**
 * `+++[标题]` or `+++ 标题` — a foldable block.
 *
 * Both are BLOCK folds, because a fold with no label and no body would be
 * indistinguishable from a paragraph — if you want a one-line fold, write the
 * line. Folds render OPEN; the toggle is added by script, so a reader without
 * scripting loses nothing.
 */
function replaceFolds(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\+\+\+(?:\[([^\]]*)\]|)\s*(.*)$/.exec(lines[i]);
    if (!m) { out.push(lines[i]); continue; }

    const label = (m[1] !== undefined && m[1] !== null ? m[1] : (m[2] || "")).trim();
    const { body, end } = gatherBody(lines, i);
    i = end;

    out.push("", `<div class="fold">`,
      `<p class="fold__label"><span class="fold__text">${esc(label || "展开")}</span></p>`,
      "", body.join("\n").trim(), "", "</div>", "");
  }
  return out.join("\n");
}

/** `>>> 引文 — 出处` — an epigraph in the serif, indented, no container. */
function replaceEpigraphs(src) {
  return src.replace(/^>>>\s*([\s\S]*?)(?:\n\n|$)/gm, (_, block) => {
    const text = block.trim();
    // an em dash or "--" on the last line carries the attribution
    const m = /^(.*?)\s*(?:——|--|—)\s*(.+)$/s.exec(text);
    const body = m ? m[1].trim() : text;
    const by = m ? m[2].trim() : "";
    return `<div class="epigraph">\n\n> ${body.replace(/\n/g, "\n> ")}\n\n${
      by ? `<p class="epigraph__by">${esc(by)}</p>` : ""
    }\n\n</div>\n\n`;
  });
}

/** `::: columns` … `:::` — a list that goes multi-column on wide screens. */
function replaceColumns(src) {
  return src.replace(
    /^:::[ \t]*columns[^\n]*\n([\s\S]*?)\n:::[ \t]*$/gm,
    (_, inner) => `\n\n<div class="columns">\n\n${inner.trim()}\n\n</div>\n\n`
  );
}

/* ══════════════════════════════════════════════════════════════════════ */
/* inline forms                                                          */
/* ══════════════════════════════════════════════════════════════════════ */

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
 *
 * gwern puts footnotes in the margin as sidenotes on wide screens and falls
 * back to floating footnotes on narrow ones. That fallback is the whole point —
 * the note must be readable when there is no margin — so notes are emitted
 * INLINE in the markup and CSS decides where they land. Emitting them at the end
 * of the document and floating them via script would break with scripting off,
 * which this site forbids.
 *
 *   ^[text]    inline note — a phrase or two
 *   ^^[text]   block note  — may contain paragraphs
 */
function replaceFootnotes(src) {
  let out = "";
  let i = 0;
  let last = 0;
  let n = 0;

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

    n += 1;
    const id = `fn${n}`;
    const body = taken.inner.trim();

    out += src.slice(last, m.index);
    out += isBlock
      ? `\n\n<aside class="note note--block" id="${id}" role="doc-footnote" aria-label="脚注 ${n}"><span class="note__n" aria-hidden="true">${n}</span><div class="note__body">\n\n${body}\n\n</div></aside>\n\n`
      : `<aside class="note" id="${id}" role="doc-footnote" aria-label="脚注 ${n}"><span class="note__n" aria-hidden="true">${n}</span><span class="note__body">${body}</span></aside>`;
    // the superscript reference stays in the text flow
    out += `<sup class="fnref"><a id="fnref${n}" href="#${id}" aria-describedby="${id}">[${n}]</a></sup>`;

    last = taken.end;
    i = taken.end;
  }

  return out + src.slice(last);
}

/**
 * Keyed citations: `[^key]` in the text, `[^key]: reference` in the source.
 *
 * gwern typesets references as subscripts rather than bracketed numbers because
 * they interrupt a sentence far less. The definitions are collected here so the
 * page can emit one compact reference list; the in-text marker becomes a
 * superscript link to its entry. Note the deliberate distinction from `^[text]`,
 * which is a note — bracket-caret is a citation, caret-bracket is a note.
 *
 * The definitions come back unresolved: they may contain `{{ref:…}}`, and the
 * reference list is built as hast, so markdown.mjs resolves them into parts.
 */
function replaceCitations(src) {
  const defs = new Map();
  const order = [];

  let text = src.replace(/^\[\^([^\]]+)\]:[ \t]*(.+)$/gm, (_, key, body) => {
    const k = key.trim();
    if (!defs.has(k)) { defs.set(k, body.trim()); order.push(k); }
    return "";
  });

  const used = [];
  text = text.replace(/\[\^([^\]]+)\]/g, (whole, key) => {
    const k = key.trim();
    if (!defs.has(k)) return whole;      // leave it alone; the check reports it
    let n = used.indexOf(k);
    if (n < 0) { used.push(k); n = used.length - 1; }
    return `<sup class="citeref"><a href="#cite-${esc(slugify(k) || n + 1)}">[${n + 1}]</a></sup>`;
  });

  return {
    text,
    citations: used.map((k) => ({ key: k, id: `cite-${slugify(k)}`, body: defs.get(k) })),
    unused: order.filter((k) => !used.includes(k))
  };
}

/* ══════════════════════════════════════════════════════════════════════ */
/* the pass                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * Run every text-level form. Returns Markdown ready to parse, plus what the
 * citation block needs to be built afterwards.
 *
 * `resolve` is the link graph: `slug → {url, title, slug}` or null.
 */
export function prepareBody(source, resolve) {
  let src = replaceColumns(source);
  src = replaceBangs(src);
  src = replaceFolds(src);
  src = replaceEpigraphs(src);
  src = replaceFootnotes(src);

  const cites = replaceCitations(src);
  // Refs last, so a `{{ref:}}` inside an admonition, a fold or a note is still
  // recognised as a link rather than ending up as literal braces.
  return {
    text: resolveRefs(cites.text, resolve),
    citations: cites.citations,
    unusedCitations: cites.unused
  };
}
