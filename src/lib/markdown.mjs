/**
 * markdown.mjs — Markdown to HTML for this site, on Astro's own engine.
 *
 * Two layers, and the split is the whole design:
 *
 *  · The TEXT layer (`sitetext.mjs`) rewrites this site's block and inline
 *    markers, because every one of them brackets a region of ordinary Markdown.
 *  · The AST layer is here. Heading ids, sections, their anchors, the per-section
 *    backlinks, link classes, verbatim blocks and the CJK dash rule are all
 *    properties of the TREE, so they are done as hast visitors on the tree that
 *    the Markdown engine built, not by pattern-matching rendered HTML.
 *
 * Three things are site-specific rather than generic Markdown:
 *
 *  1. Stable heading anchors. A Chinese heading slugifies to nothing usable, so
 *     ids are positional (`sec-1`, `sec-2`) and never derived from the text —
 *     which also means editing a heading's wording cannot break a link someone
 *     saved.
 *  2. Section wrappers with a disclosure control, which is the whole of gwern's
 *     "semantic zoom" at the block level: a long piece can be read as headings
 *     alone, then expanded section by section. The control itself is added by
 *     script, so every section is open when scripting is off.
 *  3. Section-level backlinks: a link to `{{ref:x|#sec-3}}` is resolved to the
 *     section it lands in, so a reader finishing a section sees who else cites
 *     that part rather than only which pages cite the whole piece.
 */

import { createSatteriMarkdownProcessor } from "@astrojs/markdown-satteri";
import { esc, plain } from "./text.mjs";
import { prepareBody, resolveRefParts } from "./sitetext.mjs";

/* ══════════════════════════════════════════════════════════════════════ */
/* hast builders                                                         */
/* ══════════════════════════════════════════════════════════════════════ */

const el = (tagName, properties, children) => ({ type: "element", tagName, properties, children });
const text = (value) => ({ type: "text", value });
const raw = (value) => ({ type: "raw", value });
const klass = (name) => ({ className: [name] });

/**
 * The `#` a heading carries, as a RAW node rather than an element.
 *
 * Astro's own heading collector reads a heading's text content, and an element
 * child would put a `#` in front of every title in the outline. A raw node
 * serialises in place and contributes no text, so the heading reads as written
 * and still carries its permalink.
 */
const anchorNode = (id, title) =>
  raw(`<a class="anchor" href="#${id}" aria-label="本节链接：${esc(title)}">#</a>`);

/** "本节被这些地方引用" — placed at the end of the section it belongs to. */
function backlinkBlock(list) {
  if (!list || !list.length) return null;
  return el("div", klass("sectionback"), [
    el("p", klass("sectionback__h"), [text("本节被这些地方引用")]),
    el("ul", klass("sectionback__list"), list.map((b) => el("li", {}, [
      el("a", { href: `${b.fromUrl}${b.anchor ? "#" + encodeURIComponent(b.anchor) : ""}` }, [text(b.fromTitle)]),
      ...(b.context ? [el("span", klass("sectionback__ctx"), [text(b.context)])] : [])
    ])))
  ]);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* plugins                                                               */
/* ══════════════════════════════════════════════════════════════════════ */

/**
 * Sections, positional ids, heading permalinks and section backlinks.
 *
 * Sections NEST: an h3 belongs to the h2 above it, so folding that h2 hides the
 * whole section, subsections included. Emitting them as siblings was the first
 * version, and it meant folding a section left its subsections on screen — which
 * reads as a broken fold, not as a design choice.
 */
function sectionsPlugin({ backlinks, citations }) {
  return {
    name: "site-sections",
    before(root, ctx) {
      const out = [];
      const open = [];   // the sections currently open, outermost first
      let n = 0;

      const closeTo = (level) => {
        while (open.length && open[open.length - 1].level >= level) {
          const s = open.pop();
          const block = backlinkBlock(backlinks.get(s.id));
          if (block) s.node.children.push(block);
        }
      };

      const append = (node) => {
        if (open.length) open[open.length - 1].node.children.push(node);
        else out.push(node);
      };

      for (const child of root.children) {
        const isHeading = child.type === "element" && (child.tagName === "h2" || child.tagName === "h3");
        if (!isHeading) { append(child); continue; }

        const level = Number(child.tagName[1]);
        closeTo(level);
        n += 1;
        const id = `sec-${n}`;
        const title = ctx.textContent(child);
        ctx.setProperty(child, "id", id);
        ctx.prependChild(child, anchorNode(id, title));

        const sec = el("section", { className: [level === 2 ? "sec" : "subsec"], "aria-labelledby": id }, [child]);
        append(sec);
        open.push({ level, id, node: sec });
      }
      closeTo(2);

      const refs = referencesSection(citations);
      if (refs) out.push(refs);

      ctx.replaceNode(root, { type: "root", children: out });
    }
  };
}

/**
 * The reference list, built as nodes because its entries may contain links.
 *
 * A citation definition is ordinary prose that may hold a `{{ref:…}}`, and a
 * reference the reader cannot click is a dead end. So the definition arrives as
 * runs of text and links and each run becomes the node that renders it — no HTML
 * is ever parsed back out of a string.
 */
function referencesSection(citations) {
  if (!citations || !citations.length) return null;
  return el("section", { className: ["sec", "references"], "aria-labelledby": "refs-h" }, [
    el("h2", { id: "refs-h", className: ["references__h"] }, [
      anchorNode("refs-h", ""),
      text("参考")
    ]),
    el("ol", klass("references__list"), citations.map((c) => el("li", { id: c.id }, c.parts.map((p) => (
      p.text !== undefined
        ? text(p.text)
        : p.link.hit
          ? el("a", {
            className: ["ref"],
            href: `${p.link.hit.url}${p.link.anchor ? "#" + encodeURIComponent(p.link.anchor) : ""}`,
            "data-preview": p.link.hit.slug
          }, [text(p.link.label)])
          : el("span", { className: ["ref-broken"], title: `找不到：${p.link.target}` }, [text(p.link.label)])
    )))))
  ]);
}

/**
 * Tag external links by what they point at.
 *
 * gwern.net does this with several hundred hand-tuned regexes and a folder of
 * icons; this is the abbreviated version — four categories, drawn as an inline
 * SVG so nothing is requested, and applied by attribute selector in CSS rather
 * than by rewriting every link.
 *
 * The icon is `aria-hidden` and the information is also carried in the link's
 * `title`, so it is decoration for sighted readers rather than the only signal.
 */
function linkKind(url) {
  if (/\.pdf(?:$|\?)/i.test(url)) return "pdf";
  if (/^https?:\/\/(?:en\.)?wikipedia\.org\//i.test(url)) return "wikipedia";
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(url)) return "doi";
  if (/^https?:\/\/(?:arxiv\.org|www\.arxiv\.org)\//i.test(url)) return "arxiv";
  return "web";
}

const linksPlugin = {
  name: "site-links",
  element: {
    filter: ["a"],
    visit(node, ctx) {
      // A link that already knows what it is — the `<a class="ref">` a
      // `{{ref:}}` becomes — keeps its class. Legitimately internal, but "int"
      // would be a second, weaker name for the same thing.
      const existing = node.properties?.className;
      if (Array.isArray(existing) && existing.length) return;
      const href = String(node.properties?.href ?? "");
      if (/^https?:/i.test(href)) {
        ctx.setProperty(node, "className", ["ext", `ext--${linkKind(href)}`]);
        ctx.setProperty(node, "target", "_blank");
        ctx.setProperty(node, "rel", "noopener noreferrer");
      } else {
        ctx.setProperty(node, "className", ["int"]);
      }
    }
  }
};

/** The site is plain text: no highlighter, and indented verse keeps its leading
 *  whitespace rather than being silently reflowed. */
const verbatimPlugin = {
  name: "site-verbatim",
  element: {
    filter: ["pre"],
    visit(node, ctx) {
      const body = ctx.textContent(node).replace(/\n$/, "");
      ctx.replaceNode(node, el("pre", klass("verbatim"), [text(body)]));
    }
  }
};

const dividerPlugin = {
  name: "site-divider",
  element: {
    filter: ["hr"],
    visit(node, ctx) { ctx.setProperty(node, "className", ["divider"]); }
  }
};

/**
 * Bind an em dash to whatever precedes it, so a line never STARTS with one.
 *
 * Chinese typography forbids a line beginning with —— (it belongs to the clause
 * before it), and CSS cannot enforce this one: the break happens at the space the
 * writer put before the dash, and `line-break: strict` governs CJK character
 * classes, not an ordinary space.
 *
 * Whitespace before the dash becomes a NO-BREAK SPACE, and a dash with no space
 * before it gets a WORD JOINER (U+2060). Either way the only thing that changes
 * is where a line may break: the text still reads, copies and searches as
 * written, which a `<span style="white-space:nowrap">` wrapper would not — that
 * would put markup inside the sentence and inside the search index.
 *
 * Code is left alone: a dash inside a sample is content, not prose.
 */
const dashPlugin = {
  name: "site-dashes",
  text(node, ctx) {
    const parent = ctx.parent(node);
    if (parent && parent.type === "element" && (parent.tagName === "code" || parent.tagName === "pre")) return;
    const value = String(node.value);
    if (!value.includes("——")) return;
    return text(value.replace(/(?<![\u2060])([ \t]*)——/g, (_, space) => (space ? "\u00A0——" : "\u2060——")));
  }
};

/* ══════════════════════════════════════════════════════════════════════ */
/* body                                                                  */
/* ══════════════════════════════════════════════════════════════════════ */

const FEATURES = {
  // The three tables/strikethrough/task-list features are wanted; footnotes are
  // not, because `[^key]` is this site's citation syntax and much be left to
  // sitetext.mjs rather than turned into a footnote section by the engine.
  gfm: { footnotes: false },
  frontmatter: false,
  smartPunctuation: false
};

/**
 * Render one body.
 *
 * `resolve` is the link graph; `backlinks` maps a section id to the links that
 * point at it; `citations` is what `prepareBody` collected.
 */
export async function renderBody(source, { resolve, backlinks = new Map() }) {
  const prepared = prepareBody(source, resolve);

  // Citation definitions are resolved here rather than in sitetext, because the
  // reference list is built as nodes and a string of HTML would be no use in it.
  const citations = prepared.citations.map((c) => ({ ...c, parts: resolveRefParts(c.body, resolve) }));

  const renderer = await createSatteriMarkdownProcessor({
    syntaxHighlight: false,
    features: FEATURES,
    hastPlugins: [sectionsPlugin({ backlinks, citations }), linksPlugin, verbatimPlugin, dividerPlugin, dashPlugin]
  });

  const { code, metadata } = await renderer.render(prepared.text);
  const allHeadings = (metadata.headings || [])
    .map((h) => ({ level: h.depth, id: h.slug, text: h.text }))
    // The reference list is a section for the stylesheet's sake, not part of the
    // outline: it is not a heading the writer wrote.
    .filter((h) => h.id !== "refs-h");

  return {
    html: code,
    headings: allHeadings.filter((h) => h.level === 2),
    allHeadings,
    unusedCitations: prepared.unusedCitations
  };
}

/** A short excerpt around the first occurrence of `needle`, for previews. */
export function excerpt(html, needle, width = 260) {
  const body = plain(html);
  if (!needle) return body.slice(0, width) + (body.length > width ? "…" : "");
  const i = body.toLowerCase().indexOf(String(needle).toLowerCase());
  if (i < 0) return body.slice(0, width) + (body.length > width ? "…" : "");
  const start = Math.max(0, i - 60);
  return (start > 0 ? "…" : "") + body.slice(start, start + width) + "…";
}
