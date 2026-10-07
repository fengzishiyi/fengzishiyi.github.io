/**
 * fsx.mjs — filesystem helpers, the error collector, and "did you mean".
 *
 * The error collector is the important one: content problems are gathered and
 * reported together rather than thrown one at a time, because a writer fixing
 * one error per run, six times, is a writer who stops writing.
 */

import fs from "node:fs";
import path from "node:path";

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

export function walkSize(dir) {
  if (!exists(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory()
      ? walkSize(path.join(dir, e.name))
      : fs.statSync(path.join(dir, e.name)).size), 0);
}

export const relative = (root, p) => path.relative(root, p).split(path.sep).join("/");

/** Every file under `dir` as a site-relative URL path, e.g. `compsci/x/index.html`. */
export const relativeWalk = (root, dir) =>
  walk(dir).map((f) => relative(root, f)).sort();

/* ── problems ───────────────────────────────────────────────────────────── */

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

/* ── suggestions ────────────────────────────────────────────────────────── */

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
        previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
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
