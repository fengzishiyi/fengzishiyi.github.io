#!/usr/bin/env node
/**
 * images.mjs — `npm run images`: regenerate the committed card covers.
 *
 *   node src/images.mjs           regenerate what the content asks for
 *   node src/images.mjs --prune   also delete derivatives nothing references
 *
 * This is the ONLY thing that writes to `public/img/`. The site never generates
 * a picture while building: the WebP files are committed, so a fresh clone and CI
 * both build a complete site without the masters, which are gitignored and large.
 *
 * Sharp is imported lazily, from inside the image module, so `npm ci
 * --omit=dev` — which is what the deploy workflow runs — never needs it.
 *
 * Reading the content here is deliberately shallow: front matter only, no
 * Markdown pipeline, no Astro runtime. This is a maintenance command, and it
 * should keep working even when something else in the site is broken.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateFor, WIDTHS, derivativeName, imgDir } from "./lib/images.mjs";
import { walk, relative } from "./lib/fsx.mjs";
import { slugify } from "./lib/text.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `key: value` front matter, as far as this command needs it. */
function frontMatter(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const data = {};
  for (const line of (m ? m[1] : "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return data;
}

const entries = [];
for (const dir of ["_articles", "_reading", "_hobbies"]) {
  for (const file of walk(path.join(ROOT, dir)).filter((f) => /\.(md|markdown)$/i.test(f))) {
    if (!/image\s*:/.test(fs.readFileSync(file, "utf8"))) continue;
    const data = frontMatter(file);
    const base = path.basename(file).replace(/\.(md|markdown)$/i, "");
    const slug = slugify(data.slug || base.replace(/^\d{4}-\d{2}-\d{2}[-_]/, "") || base);
    entries.push({ slug, image: data.image, image_alt: data.image_alt, file: relative(ROOT, file), name: relative(ROOT, file) });
  }
}

if (!entries.length) {
  console.log("没有任何条目写了 image: —— 没有要生成的图。");
  process.exit(0);
}

console.log(`▸ 读取 ${entries.length} 条配图`);
let written = 0;
let reused = 0;
const problems = [];
const used = new Set();

for (const item of entries) {
  const result = await generateFor(item, ROOT);
  if (result.missing || result.unreadable) {
    problems.push(`${item.name}: image: ${item.image} 找不到可读的母图，也没有已生成的衍生图`);
    continue;
  }
  if (result.reused) { reused++; console.log(`  ·  ${item.slug.padEnd(28)} 沿用已有衍生图`); continue; }
  for (const w of WIDTHS) used.add(derivativeName(item.slug, w));
  written += result.written;
  console.log(`  ✓  ${item.slug.padEnd(28)} ${result.widths.join(" / ")}px`);
}

const out = imgDir(ROOT);

/* ── prune ─────────────────────────────────────────────────────────────── */
// A derivative whose entry was deleted is dead weight in the repository and in
// every clone. Pruning is opt-in so that a run without the masters present — a
// fresh checkout — cannot delete the pictures the site depends on.
let pruned = 0;
if (process.argv.includes("--prune")) {
  for (const file of fs.readdirSync(out)) {
    if (!file.endsWith(".webp")) continue;
    const slug = file.replace(/-\d+\.webp$/, "");
    const referenced = entries.some((e) => e.slug === slug);
    if (!referenced) { fs.rmSync(path.join(out, file)); pruned++; console.log(`  −  ${file}（没有条目引用）`); }
  }
}

console.log(`\n${written} 个衍生文件写入 public/img/，${reused} 条沿用已有${pruned ? `，清理 ${pruned} 个` : ""}`);
if (problems.length) {
  console.log("\n✗ 有问题：");
  for (const p of problems) console.log("   · " + p);
  process.exit(1);
}
