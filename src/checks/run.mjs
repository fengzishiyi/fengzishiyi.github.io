#!/usr/bin/env node
/**
 * run.mjs — every check that does not need a browser, in one run.
 *
 *   node src/checks/run.mjs            the full static check
 *
 * The content is already checked by the build itself: the model refuses to
 * produce a page when a `{{ref:}}` points nowhere, an anchor has no section, a
 * slug is ambiguous or a cover's derivatives are missing, so a successful
 * `astro build` means the content passed. What is left for here is the design
 * contract (read from the sources), the artefacts (read from `dist/`) and the
 * size budgets — the three things a successful build says nothing about.
 *
 * `npm run check` runs the build first and then this, so the numbers below are
 * always measured on the tree that is about to be published.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { walk, relative, exists } from "../lib/fsx.mjs";
import { checkDesign } from "./design.mjs";
import { checkRendered } from "./rendered.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(ROOT, "dist");

const log = (s = "") => console.log(s);
let failures = 0;
const add = (list) => { failures += list.length; for (const f of list) log("   · " + f); };

/* ══════════════════════════════════════════════════════════════════════ */
/* reader payload                                                        */
/* ══════════════════════════════════════════════════════════════════════ */

const localFile = (url) => path.join(DIST, String(url).replace(/^\//, "").split("?")[0].split("#")[0]);

/** Everything a reader downloads to READ one page: the stylesheets it links, the
 *  scripts it loads, and the inline script text — because that is the number the
 *  budget is about. Measuring the source files instead would charge the reader
 *  for comments they never receive. */
function payload(body) {
  const local = new Set();
  for (const m of body.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) {
    if (m[1].startsWith("/")) local.add(m[1]);
  }
  for (const m of body.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    if (m[1].startsWith("/")) local.add(m[1]);
  }
  let bytes = 0;
  for (const url of local) {
    const file = localFile(url);
    if (exists(file)) bytes += fs.statSync(file).size;
  }
  for (const m of body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    bytes += Buffer.byteLength(m[1], "utf8");
  }
  return { bytes, files: local.size };
}

/** The covers one page actually downloads. `src` and not the whole `srcset`: the
 *  browser picks one, and the largest is the worst case. */
function imagePayload(body) {
  const srcs = new Set([...body.matchAll(/<img\b[^>]*\bsrc="(\/img\/[^"]+)"/g)].map((m) => m[1]));
  let bytes = 0;
  for (const src of srcs) {
    const file = localFile(src);
    if (exists(file)) bytes += fs.statSync(file).size;
  }
  return bytes;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* third parties                                                         */
/* ══════════════════════════════════════════════════════════════════════ */

/** The one promise the site makes about the network: nothing it LOADS comes from
 *  anywhere else. Checked on the artefacts, because that is where a stray CDN
 *  link would actually land.
 *
 *  An outbound `href` is not a request — the about page cites gwern.net and
 *  chester.how on purpose, and following those is the reader's decision. What is
 *  banned is a subresource: a script, a stylesheet, an image, a frame. */
function checkNoThirdParty(pages) {
  const failures = [];
  const hits = new Set();
  const isLocal = (url) => !/^https?:/i.test(url) || /^https?:\/\/fengzishiyi\.github\.io/.test(url);
  for (const [rel, body] of pages) {
    for (const m of body.matchAll(/<(?:script|img|iframe|source|video|audio)\b[^>]*\bsrc="([^"]+)"/g)) {
      if (!isLocal(m[1])) hits.add(`${rel} → ${m[1]}`);
    }
    for (const m of body.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) {
      if (!isLocal(m[1])) hits.add(`${rel} → ${m[1]}`);
    }
  }
  if (hits.size) failures.push(`页面加载了站外资源：${[...hits].slice(0, 4).join("；")}`);
  else log(`  ok   第三方请求   0 个（${pages.size} 个页面全部站内）`);
  return failures;
}

/* ══════════════════════════════════════════════════════════════════════ */
/* go                                                                    */
/* ══════════════════════════════════════════════════════════════════════ */

if (!exists(path.join(DIST, "index.html"))) {
  console.error("dist/ 里没有构建产物 —— 先运行 npm run build");
  process.exit(2);
}

const t0 = Date.now();

log("▸ 设计契约（读源码）");
add(checkDesign(ROOT, log));

log("\n▸ 产物断言（读 dist/）");
add(checkRendered(DIST, log));

const pages = new Map(walk(DIST).filter((f) => f.endsWith(".html")).map((f) => [relative(DIST, f), fs.readFileSync(f, "utf8")]));

log("\n▸ 第三方请求");
add(checkNoThirdParty(pages));

log("\n▸ 体积");
let worstPage = ["", 0];
let worstPayload = ["", 0, 0];
let worstImages = ["", 0];
for (const [rel, body] of pages) {
  const pageBytes = Buffer.byteLength(body, "utf8");
  const p = payload(body);
  const images = imagePayload(body);
  if (pageBytes > worstPage[1]) worstPage = [rel, pageBytes];
  if (p.bytes > worstPayload[1]) worstPayload = [rel, p.bytes, p.files];
  if (images > worstImages[1]) worstImages = [rel, images];
}

const budgets = [
  ["最大单页", worstPage[1] / 1024, 120, `KB  (${worstPage[0]})`],
  ["单页 css+js", worstPayload[1] / 1024, 64, `KB  (${worstPayload[2]} 个文件, ${worstPayload[0]})`],
  ["单页配图", worstImages[1] / 1024, 400, `KB  (${worstImages[0]})`]
];
for (const [name, value, max, note] of budgets) {
  const ok = value <= max;
  log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(14)} ${value.toFixed(1)}${note} / ${max}KB`);
  if (!ok) failures++;
}
log(`  ·    页面数        ${pages.size} 个 HTML 页面`);

log("\n" + (failures
  ? `✗ ${failures} 项未通过（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
  : `✓ 检查通过（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`));
process.exit(failures ? 1 : 0);
