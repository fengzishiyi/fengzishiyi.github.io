/**
 * lib.mjs — helpers shared by every build step.
 *
 * Everything here survived the previous two rewrites of this site, which is the
 * only reason it lives in one place: escaping, file walking, edit-distance
 * suggestions, error collection, and the contrast maths. Nothing in this file
 * knows anything about articles or pages.
 */

import fs from "node:fs";
import path from "node:path";

/* ══════════════════════════════════════════════════════════════════════ */
/* text                                                                  */
/* ══════════════════════════════════════════════════════════════════════ */

export const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Strip tags and collapse whitespace — used for search text and meta
 *  descriptions, where markup would be wrong. */
export const plain = (html) =>
  String(html == null ? "" : html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** Slug from any string. CJK is preserved rather than transliterated: a
 *  Chinese filename is a perfectly good URL segment, and transliterating would
 *  make it unreadable to the person who has to type it. */
export function slugify(name) {
  return String(name == null ? "" : name)
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/['"’“”]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const dateDots = (d) => String(d || "").replace(/-/g, ".");

/** Human date for prose, ISO preserved in <time datetime>. */
export function dateLong(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return `${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
}

export const todayISO = () => new Date().toISOString().slice(0, 10);

/* ══════════════════════════════════════════════════════════════════════ */
/* filesystem                                                            */
/* ══════════════════════════════════════════════════════════════════════ */

export const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
export const ensure = (p) => fs.mkdirSync(p, { recursive: true });
export const exists = (p) => fs.existsSync(p);

export function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Read a text file as UTF-8 with any BOM removed.
 *
 *  This is not hypothetical: Notepad and PowerShell's WriteAllText both emit a
 *  BOM, and a BOM silently broke front-matter parsing for an entire session —
 *  the parser requires the file to START with `---`, so every field came back
 *  empty behind a misleading "missing title" error. The caller gets told, so
 *  the cause is visible rather than mysterious. */
export function readText(file) {
  const raw = fs.readFileSync(file, "utf8");
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  return { text: hadBom ? raw.slice(1) : raw, hadBom };
}

export function walkSize(dir) {
  if (!exists(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory()
      ? walkSize(path.join(dir, e.name))
      : fs.statSync(path.join(dir, e.name)).size), 0);
}

export const relative = (root, p) => path.relative(root, p).split(path.sep).join("/");

/* ══════════════════════════════════════════════════════════════════════ */
/* suggestions                                                           */
/* ══════════════════════════════════════════════════════════════════════ */

/** Levenshtein, bounded. Powers every "did you mean" in the build: a mistyped
 *  {{ref:}} slug, an unknown domain, a bad cover path before it. A near-miss
 *  suggestion is worth more than a list of all legal values. */
export function nearMiss(input, candidates, max = 3) {
  const a0 = String(input == null ? "" : input).toLowerCase();
  const dist = (a, b) => {
    if (Math.abs(a.length - b.length) > 4) return 99;
    const previous = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) previous[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let diag = previous[0];
      previous[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = previous[j];
        previous[j] = Math.min(
          previous[j] + 1,
          previous[j - 1] + 1,
          diag + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        diag = tmp;
      }
    }
    return previous[b.length];
  };
  return candidates
    .map((c) => ({ c, d: dist(a0, String(c).toLowerCase()) }))
    .filter((x) => x.d < 4)
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map((x) => x.c);
}

/* ══════════════════════════════════════════════════════════════════════ */
/* problems                                                              */
/* ══════════════════════════════════════════════════════════════════════ */

/** Collects every content problem in one run instead of dying on the first.
 *  A writer fixing one error at a time, six times, is a writer who stops
 *  writing. */
export class Problems {
  constructor() {
    this.items = [];
    this.warnings = [];
  }

  error(file, message) { this.items.push({ file, message }); }
  warn(message) { this.warnings.push(message); }
  get failed() { return this.items.length > 0; }

  report(log, heading = "✗ 内容有问题") {
    if (this.items.length) {
      log("\n" + heading);
      for (const p of this.items) log(`   ${p.file ? p.file + ": " : ""}${p.message}`);
    }
    if (this.warnings.length) {
      log("\n警告（不阻断构建）");
      for (const w of this.warnings) log("   · " + w);
    }
    return this.items.length + this.warnings.length;
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
/* colour                                                                */
/* ══════════════════════════════════════════════════════════════════════ */

export function luminance([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export const over = (top, alpha, base) => top.map((c, i) => c * alpha + base[i] * (1 - alpha));
export const toHex = (rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

/** Read a `--name: #rrggbb` custom property out of a stylesheet so contrast can
 *  be measured on the value that actually renders rather than a guess. */
export function hexFrom(css, name, fallback) {
  const m = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(css);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Count the CJK characters in a string — used to keep the reading measure
 *  honest, since `ch` and `max-width` say nothing useful about 汉字. */
export const cjkCount = (s) => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;
