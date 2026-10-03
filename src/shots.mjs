#!/usr/bin/env node
/**
 * shots.mjs — capture the magazine and measure its layout at EXACT viewports.
 *
 * Driven over CDP rather than `--screenshot`, because Edge's headless window
 * cannot go below 496px and strips ~26px at every other size: those flags crop
 * a wider layout, which makes a correct page look broken. Requires
 * `npm run serve`.
 *
 *   node src/shots.mjs              capture + measure
 *   node src/shots.mjs --measure    measure only, no PNGs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Browser } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || 4321;
const BASE = `http://127.0.0.1:${PORT}`;
/* NOT under .build/ — every build wipes that directory, which silently deleted
   the screenshots each time the site was rebuilt. */
const OUT = path.join(ROOT, ".shots");
const measureOnly = process.argv.includes("--measure");

const VIEWPORTS = [
  ["phone", 390, 844],
  ["tablet", 768, 1024],
  ["laptop", 1440, 900],
  ["wide", 1920, 1000],
  ["ultra", 2560, 1100]
];

/** Discover the pages that actually exist, so renaming a route never leaves a
 *  stale entry here. */
function discoverPages() {
  const pages = ["/", "/contents/", "/archive/", "/about/", "/404.html", "/images/"];
  const dir = path.join(ROOT, "articles");
  if (fs.existsSync(dir)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) pages.push(`/articles/${e.name}/`);
    }
  }
  return pages;
}

let failures = 0;
const fail = (m) => { console.log("  ✗ " + m); failures++; };

const browser = await Browser.launch();
const PAGES = discoverPages();

/* ── 1. measure every page at every viewport ─────────────────────────────── */
console.log("layout measurement (exact CSS viewports)\n");
for (const page of PAGES) {
  console.log(`── ${page}`);
  for (const [vname, w, h] of VIEWPORTS) {
    let m;
    try { m = await browser.measure({ url: BASE + page, width: w, height: h }); }
    catch (e) { fail(`${page} ${vname}: ${e.message}`); continue; }

    const bits = [`client=${m.clientWidth}`];
    if (m.hScroll) bits.push("H_SCROLL!");
    if (m.outsideViewport.length) bits.push(`outside=${m.outsideViewport.length}`);
    if (m.h1Count !== 1) bits.push(`h1=${m.h1Count}!`);
    if (m.title) bits.push(`title=${m.title.w}@${m.title.fs}`);
    if (m.openerTitle) bits.push(`opener=${m.openerTitle.w}@${m.openerTitle.fs}`);
    if (m.nameplate) bits.push(`nameplate=${m.nameplate.w}@${m.nameplate.fs}`);
    if (m.prose) bits.push(`prose=${m.prose.w}@${m.prose.fs}`);
    console.log(`   ${String(w).padStart(4)}px ${vname.padEnd(7)} ${bits.join("  ")}`);

    if (m.clientWidth !== w) fail(`${page} ${vname}: asked for ${w}px, laid out at ${m.clientWidth}px`);
    if (m.hScroll) fail(`${page} ${vname}: horizontal scrollbar (${m.scrollWidth} > ${m.clientWidth})`);
    if (m.outsideViewport.length) fail(`${page} ${vname}: past the right edge → ${m.outsideViewport.join(", ")}`);
    if (m.h1Count !== 1) fail(`${page} ${vname}: ${m.h1Count} <h1> elements, expected exactly 1`);
    if (m.title && m.title.right > m.clientWidth + 1) fail(`${page} ${vname}: a title overflows the viewport`);
    if (m.openerTitle && m.openerTitle.right > m.clientWidth + 1) fail(`${page} ${vname}: the opener title overflows`);
  }
  console.log("");
}

/* ── 2. capture ──────────────────────────────────────────────────────────── */
if (!measureOnly) {
  console.log("captures");
  fs.mkdirSync(OUT, { recursive: true });
  const wanted = (page, vname) =>
    (vname === "laptop") ||
    (vname === "phone" && ["/", "/contents/"].includes(page)) ||
    (vname === "phone" && page.startsWith("/articles/")) ||
    (vname === "ultra" && page === "/") ||
    (vname === "tablet" && page.startsWith("/articles/"));

  for (const page of PAGES) {
    for (const [vname, w, h] of VIEWPORTS) {
      if (!wanted(page, vname)) continue;
      const name = (page === "/" ? "cover" : page.replace(/^\/|\/$/g, "").replace(/\//g, "-")) + `-${w}`;
      const png = path.join(OUT, `${name}.png`);
      try {
        await browser.shoot({ url: BASE + page, width: w, height: h, out: png });
        const jpg = png.replace(/\.png$/, ".jpg");
        await sharp(png).jpeg({ quality: 80 }).toFile(jpg);
        const meta = await sharp(png).metadata();
        console.log(`  ${name.padEnd(26)} ${meta.width}×${meta.height}  ${(fs.statSync(jpg).size / 1024).toFixed(0)}KB`);
      } catch (e) { fail(`shoot ${name}: ${e.message}`); }
    }
  }
}

await browser.close();

console.log("");
console.log(failures ? `✗ ${failures} layout problem(s)` : "✓ every page lays out cleanly at every tested width");
console.log(`  shots → ${OUT}`);
process.exit(failures ? 1 : 0);
