#!/usr/bin/env node
/**
 * new.mjs — `npm run new -- "标题"` scaffolds an article.
 *
 * The point is to remove every lookup the front matter would otherwise require:
 * the date is today, the department is the first one, and the images that no
 * article has claimed yet are printed as ready-to-paste `cover:` values.
 *
 *   npm run new -- "标题"
 *   npm run new -- "标题" --section 随笔 --cover 99424534-p0
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTICLES = path.join(ROOT, "_articles");
const IMAGES = path.join(ROOT, "_images");

const SECTIONS = ["专题", "作品", "随笔", "手记"];

/* ── args ──────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const title = positional.join(" ").trim();

if (!title) {
  console.log(`用法：npm run new -- "标题" [--section 栏目] [--cover 图片slug]

栏目：${SECTIONS.join(" / ")}`);
  process.exit(1);
}

/* ── helpers ───────────────────────────────────────────────────────────── */

const slugify = (s) =>
  s.toLowerCase().trim()
    .replace(/[^\w\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".tif", ".tiff"]);

/** Which images exist, and which are already spoken for. */
function imageInventory() {
  if (!fs.existsSync(IMAGES)) return { all: [], free: [] };
  const all = fs.readdirSync(IMAGES)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => f.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-"));

  const used = new Set();
  if (fs.existsSync(ARTICLES)) {
    for (const f of fs.readdirSync(ARTICLES).filter((f) => /\.(md|markdown)$/i.test(f))) {
      const raw = fs.readFileSync(path.join(ARTICLES, f), "utf8");
      const m = /^\s*cover\s*:\s*(.+)$/m.exec(raw);
      if (m) used.add(m[1].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return { all, free: all.filter((s) => !used.has(s)) };
}

/* ── write the file ────────────────────────────────────────────────────── */

const today = new Date().toISOString().slice(0, 10);
const slug = slugify(title);
const file = path.join(ARTICLES, `${slug}.md`);

if (fs.existsSync(file)) {
  console.error(`✗ 已经存在：_articles/${slug}.md`);
  console.error(`  换个文件名：npm run new -- "另一个标题"，或直接编辑那一个。`);
  process.exit(1);
}

const { all, free } = imageInventory();
const section = flag("section") || SECTIONS[0];
if (!SECTIONS.includes(section)) {
  console.error(`✗ 栏目 "${section}" 不在列表里。可选：${SECTIONS.join(" / ")}`);
  process.exit(1);
}

const cover = flag("cover") || free[0] || "";
if (cover && !all.includes(cover)) {
  console.error(`✗ 没有这张图："${cover}"。现有：${all.join(", ")}`);
  process.exit(1);
}

fs.mkdirSync(ARTICLES, { recursive: true });
fs.writeFileSync(file, `---
title: ${title}
date: ${today}
section: ${section}
cover: ${cover}
kicker: 
standfirst: 一句话导语，会以衬线斜体显示在标题下方。
lead: 开篇的导言段，会以更大的字号单独排版。删掉这行就会用正文第一段充当。
tags: []
---

在这里开始写。正文就是普通的 markdown。

## 一个小标题

插图用短码（slug 就是 _images/ 里的文件名）：

{{figure:${free[1] || all[1] || all[0] || "图片slug"}|图注，会显示成斜体。}}

整版出血的图：{{bleed:${free[2] || all[2] || all[0] || "图片slug"}|说明。}}

引文（每篇建议最多一条，会横跨正文栏）：

{{quote:一句值得单独排版的话。|出处}}
`, "utf8");

/* ── report, with the ready-to-paste values ────────────────────────────── */

console.log(`✓ 新建 _articles/${slug}.md`);
console.log(`  ${today} · ${section}${cover ? ` · cover: ${cover}` : ""}`);
console.log("");

if (!cover) {
  console.log("⚠ 还没有可用的封面图，所以 cover 是空的（构建会报错直到填上）。");
}

if (free.length > 0) {
  console.log(`还没被用过的图片（${free.length} 张），可以直接粘进 cover: 或 {{figure:}}`);
  const names = free;
  const w = Math.max(...names.map((n) => n.length));
  for (const n of names) {
    const hint = n.includes("-p0") ? n.split("-p0")[0] : "";
    console.log(`  ${n.padEnd(w)}${hint ? `  (作品 ${hint} 的第 1 页)` : ""}`);
  }
} else if (all.length) {
  console.log("所有图片都已经被用作封面了 —— 再加图就丢进 _images/ 重新构建。");
} else {
  console.log("_images/ 还是空的。把图片放进去，构建脚本会自动读尺寸、压缩略图。");
}

console.log("");
console.log("下一步：");
console.log("  npm run dev        # 边写边看，保存即刷新");
console.log("  npm run check:content   # 只看内容有没有问题");
