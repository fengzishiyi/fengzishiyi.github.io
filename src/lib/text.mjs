/**
 * text.mjs — escaping, slugs, dates and the tag colour.
 *
 * Everything here is pure string work with no knowledge of pages or articles.
 * It survived the previous two rewrites of this site unchanged, which is the
 * only reason it still lives in one file.
 */

/* ── escaping ───────────────────────────────────────────────────────────── */

export const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Strip tags and collapse whitespace — for search text and meta descriptions,
 *  where markup would be wrong. */
export const plain = (html) =>
  String(html == null ? "" : html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/* ── slugs ──────────────────────────────────────────────────────────────── */

/** Slug from any string. CJK is preserved rather than transliterated: a Chinese
 *  filename is a perfectly good URL segment, and transliterating it would make
 *  the address unreadable to the person who has to type it. */
export function slugify(name) {
  return String(name == null ? "" : name)
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/['"’“”]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A tag's page. One function, so a chip and the page it opens cannot disagree. */
export const tagUrl = (name) => `/tags/${encodeURIComponent(name)}/`;
export const seriesUrl = (name) => `/series/${encodeURIComponent(name)}/`;

/* ── dates ──────────────────────────────────────────────────────────────── */

export const dateDots = (d) => String(d || "").replace(/-/g, ".");
export const todayISO = () => new Date().toISOString().slice(0, 10);

/** Human date for prose; the ISO form stays in <time datetime>. */
export function dateLong(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return `${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
}

/** Count the CJK characters in a string — used to keep the reading measure
 *  honest, since `ch` and `max-width` say nothing useful about 汉字. */
export const cjkCount = (s) => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;

/* ── accents ────────────────────────────────────────────────────────────── */

/**
 * Every coloured thing on the site picks one of the nine chip pairs, and the
 * pick has to be the SAME every time or the colour means nothing: a tag that is
 * amber on the index and sky on the article is decoration, not information.
 * `accentFor` hashes a name onto the eight chromatic names, so a tag's colour is
 * stable across builds, pages and machines without storing a colour anywhere.
 */
export const ACCENTS = ["amber", "lime", "orange", "green", "purple", "sky", "rose", "teal"];

/** FNV-1a, 32-bit. Small, well-mixed, and identical on every machine. */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const accentFor = (name) => ACCENTS[hash32(name) % ACCENTS.length];
