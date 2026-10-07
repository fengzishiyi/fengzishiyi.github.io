#!/usr/bin/env node
/**
 * new.mjs — `npm run new` scaffolds an article in the right domain folder with
 * valid front matter.
 *
 * The taxonomy is the thing most likely to be got wrong by hand: a `kind` that
 * does not belong to its `domain` fails the build, and so does a file sitting in
 * the wrong folder. Neither is hard, but both are easy to forget, and the build
 * error arrives later than the intention. So the tool asks instead.
 *
 *   npm run new                                  interactive
 *   npm run new -- "标题" --domain philosophy --kind 札记
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DOMAINS, CROSS_TAGS, domainByKey } from "./lib/taxonomy.mjs";
import { todayISO, slugify } from "./lib/text.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTICLES = path.join(ROOT, "_articles");

/* ── args ──────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const givenTitle = positional.join(" ").trim();

/* ── prompts ───────────────────────────────────────────────────────────── */

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
const close = () => { try { rl.close(); } catch { /* already closed */ } };

const isTTY = process.stdin.isTTY;

async function choose(prompt, options, preset) {
  if (preset) {
    const hit = options.find((o) => o.key === preset || o.name === preset);
    if (hit) return hit;
    console.error(`✗ "${preset}" 不是合法选项。可选：${options.map((o) => `${o.key}(${o.name})`).join(" / ")}`);
    process.exit(1);
  }
  if (!isTTY) {
    console.error(`✗ 非交互环境请显式指定：${prompt}（${options.map((o) => o.key).join(" / ")}）`);
    process.exit(1);
  }
  console.log(`\n${prompt}`);
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o.name}${o.key !== o.name ? ` (${o.key})` : ""}`));
  for (;;) {
    const raw = await ask(`输入序号 [1-${options.length}]：`);
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
    const byName = options.find((o) => o.key === raw || o.name === raw);
    if (byName) return byName;
    console.log("  请再试一次。");
  }
}

/* ── existing slugs, to warn about collisions ──────────────────────────── */

function existingSlugs() {
  const out = new Set();
  if (!fs.existsSync(ARTICLES)) return out;
  for (const d of fs.readdirSync(ARTICLES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(ARTICLES, d.name))) {
      if (!/\.(md|markdown)$/i.test(f)) continue;
      const raw = fs.readFileSync(path.join(ARTICLES, d.name, f), "utf8").replace(/^\uFEFF/, "");
      const m = /^slug:\s*(.+)$/m.exec(raw);
      out.add(m ? m[1].trim() : slugify(f.replace(/\.(md|markdown)$/i, "").replace(/^\d{4}-\d{2}-\d{2}[-_]/, "")));
    }
  }
  return out;
}

/* ── go ────────────────────────────────────────────────────────────────── */

console.log("新建一篇文章\n");

const title = givenTitle || (isTTY ? await ask("标题：") : "");
if (!title) { console.error("✗ 需要标题。用法：npm run new -- \"标题\""); close(); process.exit(1); }

const domain = await choose("领域", DOMAINS.map((d) => ({ key: d.key, name: d.name })), flag("domain"));
const kinds = domainByKey(domain.key).kinds.map((k) => ({ key: k, name: k }));
const kind = await choose("类型", kinds, flag("kind"));

let slug = flag("slug") || slugify(title);
if (!slug) {
  if (!isTTY) { console.error("✗ 无法从标题生成 slug，请用 --slug 指定"); close(); process.exit(1); }
  slug = slugify(await ask("这个标题生成不出 URL 片段，请手写一个（英文或拼音）："));
}
if (!slug) { console.error("✗ slug 不能为空"); close(); process.exit(1); }

const used = existingSlugs();
if (used.has(slug)) {
  console.error(`✗ slug "${slug}" 已被占用。换一个：npm run new -- "${title}" --slug ${slug}-2`);
  close();
  process.exit(1);
}

let description = flag("description") || (isTTY ? await ask("一句话摘要（会用于元信息、搜索与预览）：") : "");
if (!description) description = `${title}。`;
if (description.length > 160) {
  console.log(`  ! 摘要有 ${description.length} 字，元信息块里会显得长，建议收到 60 字以内`);
}

const today = todayISO();
const dir = path.join(ARTICLES, domain.key);
const file = path.join(dir, `${today}-${slug}.md`);
fs.mkdirSync(dir, { recursive: true });

if (fs.existsSync(file)) {
  console.error(`✗ 已存在：${path.relative(ROOT, file)}`);
  close();
  process.exit(1);
}

fs.writeFileSync(file, `---
title: ${title}
slug: ${slug}
description: ${description}
domain: ${domain.key}
kind: ${kind.name}
created: ${today}
status: draft
tags: []
---

正文从这里开始。每句话一行，便于 Git 逐句比对。

## 第一个小节

脚注写成这样^[行内脚注。宽屏时它会排到页边成为边注，窄屏时回落到段落下方 —— 两种情况下都在文档里，关掉 JS 也读得到。]

块级脚注用两个脱字符，可以写多段：

^^[这是块级脚注的第一段。

第二段。适合放比较长的补充材料。]

段旁概括用三个感叹号，放在被概括的段落上方，方便跳读：

!!! 一句话概括这一段

引用别的文章用短码，构建时会检查目标是否存在，拼错会给出候选：

{{ref:why-plain-text}}

## 参考

- 用普通 markdown 列表写外部参考。

<!--
可选字段，需要时取消注释：
modified: ${today}        改订日期
series: 系列名              成组的文章
confidence: likely          把握（high / likely / possible / unlikely / unsure）
importance: 3               重要度 0–10
license: CC BY-NC-SA 4.0   覆盖站点默认许可
-->

<!-- 跨领域标签参考：${CROSS_TAGS.slice(0, 6).join(" · ")} -->
`, "utf8");

console.log(`\n✓ 新建 ${path.relative(ROOT, file)}`);
console.log(`  ${domain.name} · ${kind.name} · slug: ${slug}`);
console.log(`  URL 会是 /${domain.key}/${slug}/`);
console.log("\n下一步：");
console.log("  npm run dev            边写边看，保存即刷新");
console.log("  npm run check:content  只检查内容与分类");
console.log("  npm run check:links    看可用 slug、查死链");
console.log(`\n可用的跨领域标签：${CROSS_TAGS.join(" · ")}`);

close();
