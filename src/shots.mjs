#!/usr/bin/env node
/**
 * shots.mjs — capture the site and measure its layout at EXACT viewport widths.
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
const OUT = path.join(ROOT, ".build", "shots");
const measureOnly = process.argv.includes("--measure");

/* Exact CSS viewports to review. 390 is a modern phone, 768 a tablet,
   1440 and 1920 desktop, 2560 a wide desktop. */
const VIEWPORTS = [
  ["phone", 390, 844],
  ["tablet", 768, 1024],
  ["laptop", 1440, 900],
  ["wide", 1920, 1000],
  ["ultra", 2560, 1100]
];

const PAGES = [
  ["home", "/"],
  ["images", "/images/"],
  ["articles", "/articles/"],
  ["article", "/articles/why-the-wall-moves/"],
  ["about", "/about/"],
  ["404", "/404.html"]
];

let failures = 0;
const fail = (m) => { console.log("  ✗ " + m); failures++; };

const browser = await Browser.launch();

/* ── 1. measure every page at every viewport ─────────────────────────────── */
console.log("layout measurement (exact CSS viewports)\n");
for (const [pname, page] of PAGES) {
  console.log(`── ${pname} ${page}`);
  for (const [vname, w, h] of VIEWPORTS) {
    let m;
    try { m = await browser.measure({ url: BASE + page, width: w, height: h }); }
    catch (e) { fail(`${vname}: ${e.message}`); continue; }

    const tag = `${String(w).padStart(4)}px ${vname.padEnd(7)}`;
    const bits = [`client=${m.clientWidth}`];
    if (m.hScroll) bits.push(`H_SCROLL!`);
    if (m.outsideViewport.length) bits.push(`outside=${m.outsideViewport.length}`);
    if (m.title) bits.push(`title=${m.title.w}@${m.title.fs}`);
    if (m.prose) bits.push(`prose=${m.prose.w}@${m.prose.fs}`);
    if (m.nav) bits.push(`nav=${m.nav.w}`);
    console.log(`   ${tag} ${bits.join("  ")}`);

    if (m.clientWidth !== w) fail(`${pname}/${vname}: asked for ${w}px, laid out at ${m.clientWidth}px`);
    if (m.hScroll) fail(`${pname}/${vname}: horizontal scrollbar (scrollWidth ${m.scrollWidth} > ${m.clientWidth})`);
    if (m.outsideViewport.length) {
      fail(`${pname}/${vname}: elements past the right edge → ${m.outsideViewport.join(", ")}`);
    }
    if (m.vw50 !== Math.round(m.clientWidth / 2)) {
      fail(`${pname}/${vname}: 50vw resolved to ${m.vw50}, expected ${Math.round(m.clientWidth / 2)} — the full-bleed wall is misaligned`);
    }
    // text must never be laid out wider than its container
    if (m.title && m.title.right > m.clientWidth + 1) fail(`${pname}/${vname}: the headline overflows its viewport`);
  }
  console.log("");
}

/* ── 2. capture ──────────────────────────────────────────────────────────── */
if (!measureOnly) {
  console.log("captures");
  fs.mkdirSync(OUT, { recursive: true });
  for (const [pname, page] of PAGES) {
    for (const [vname, w, h] of VIEWPORTS) {
      // only a representative subset, or this is dozens of files
      const wanted = (vname === "phone" && ["home", "article", "articles"].includes(pname)) ||
                     (vname === "laptop" && true) ||
                     (vname === "ultra" && ["home"].includes(pname)) ||
                     (vname === "tablet" && ["home", "article"].includes(pname));
      if (!wanted) continue;
      const png = path.join(OUT, `${pname}-${w}.png`);
      try {
        await browser.shoot({ url: BASE + page, width: w, height: h, out: png });
        const jpg = png.replace(/\.png$/, ".jpg");
        await sharp(png).jpeg({ quality: 80 }).toFile(jpg);
        const meta = await sharp(png).metadata();
        console.log(`  ${(pname + "-" + w).padEnd(16)} ${meta.width}×${meta.height}  ${(fs.statSync(jpg).size / 1024).toFixed(0)}KB`);
      } catch (e) { fail(`shoot ${pname}@${w}: ${e.message}`); }
    }
  }
}

await browser.close();

console.log("");
console.log(failures ? `✗ ${failures} layout problem(s)` : "✓ every page lays out cleanly at every tested width");
console.log(`  shots → ${OUT}`);
process.exit(failures ? 1 : 0);
