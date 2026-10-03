#!/usr/bin/env node
/**
 * wall-math.mjs — a computational proof of the wall's loop.
 *
 * The drift cannot be screenshotted in a headless run here, so instead this
 * re-derives the browser's arithmetic from the BUILT HTML — it reads the
 * injected --tw/--th and --travel back out of index.html, so it verifies the
 * artefact rather than the intent:
 *
 *   1. lay the tiles out with `gap`, measuring where each one starts
 *   2. translate every tile left by the offsets the keyframes will apply
 *   3. at each offset ask whether the visible window [0, V) is fully backed by
 *      some tile — any instant without coverage is a hole you can see as paper
 *   4. verify the wrap is phase-identical: after `travel` px some tile must sit
 *      exactly at the track origin, or the loop visibly jumps
 *
 * Exit 1 on any failure. Run with: node src/wall-math.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "images/manifest.json"), "utf8"));

const GUTTER = 16;
const VIEWPORTS = [375, 414, 768, 1024, 1280, 1440, 1600, 1920, 2560];
const SAMPLES = 1500;

/** Rows exactly as they were published, geometry included. */
function readRows(htmlFile) {
  const html = fs.readFileSync(htmlFile, "utf8");
  const rows = [];
  // each row is: <div class="wall-row" ...> <div class="wall-track"> tiles </div> </div>
  const rowRe = /<div class="wall-row"([^>]*)>\s*<div class="wall-track">([\s\S]*?)<\/div>\s*<\/div>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const attrs = m[1];
    const tiles = [...m[2].matchAll(/<button[\s\S]*?data-slug="([^"]+)"[\s\S]*?style="--th:(\d+)px; --tw:(\d+)px"/g)]
      .map((t) => ({ slug: t[1], h: Number(t[2]), w: Number(t[3]) }));
    rows.push({
      travel: Number(/--travel:\s*(-?\d+(?:\.\d+)?)px/.exec(attrs)?.[1]),
      dur: Number(/--wall-dur:\s*(-?\d+(?:\.\d+)?)s/.exec(attrs)?.[1]),
      dir: /data-dir="([^"]+)"/.exec(attrs)?.[1] || "normal",
      passes: Number(/data-passes="(\d+)"/.exec(attrs)?.[1]),
      repeats: Number(/data-repeats="(\d+)"/.exec(attrs)?.[1]),
      tiles
    });
  }
  return rows;
}

let failures = 0;
const fail = (msg) => { console.log("  ✗ " + msg); failures++; };
const pass = (msg) => console.log("  " + msg + "  ✓");

console.log("wall loop proof  —  reading the published artefact\n");
const rows = readRows(path.join(ROOT, "index.html"));
if (!rows.length) fail("no wall rows found in index.html — the markup changed shape");

rows.forEach((row, ri) => {
  const names = row.tiles.map((t) => t.slug);
  const repeats = row.repeats || 1;
  const passLen = Math.round(row.tiles.length / ((row.passes || 1) * repeats));

  const starts = [];
  let x = 0;
  for (const t of row.tiles) { starts.push(x); x += t.w + GUTTER; }
  const trackWidth = x - GUTTER;
  const copyStride = starts[passLen * repeats];   // one PASS, not one sequence

  console.log(
    `row ${ri + 1} (${row.dir}) — ${row.tiles.length} tiles, sequence ${passLen} ×${repeats} per pass, ` +
    `${row.passes} passes`
  );
  console.log(`  track ${trackWidth}px · pass ${copyStride}px · travel ${row.travel}px · ${row.dur}s/lap`);

  if (!row.tiles.length) { fail(`row ${ri + 1}: no tiles parsed (markup or regex drift)`); return; }
  if (!(copyStride > 0)) fail(`row ${ri + 1}: pass length is ${copyStride}px`);
  if (!(trackWidth > 0)) fail(`row ${ri + 1}: track width is ${trackWidth}px`);

  // ---- 2. travel must be a whole number of passes ----------------------
  const laps = row.travel / copyStride;
  if (Math.abs(laps - Math.round(laps)) > 1e-6) {
    fail(`row ${ri + 1}: travel is ${laps.toFixed(3)} passes — the loop will jump at the wrap`);
  } else {
    pass(`travel = ${Math.round(laps)} passes exactly`);
  }
  if (row.travel > trackWidth) {
    fail(`row ${ri + 1}: travel ${row.travel}px exceeds the track ${trackWidth}px — it would run off the end`);
  }

  // ---- 3. the wrap is phase-identical ---------------------------------
  const atWrap = starts.map((s) => s - row.travel);
  const aligned = atWrap.some((s) => Math.abs(s - starts[0]) < 1e-6);
  if (aligned) pass("a tile lands exactly on the track origin at the wrap");
  else fail(`row ${ri + 1}: nothing sits at the origin after ${row.travel}px — visible jump`);

  // ---- 4. coverage over a whole lap, at every viewport ----------------
  // The rightmost backed pixel is the max over EVERY tile of (start − d + w).
  // A tile whose left edge has already left the screen must still count: its
  // right edge is very often exactly what covers the viewport mid-drift, and
  // ignoring those makes the check report holes that are not there.
  let worst = 0;
  let uncovered = 0;
  let worstV = 0;
  for (const V of VIEWPORTS) {
    for (let k = 0; k <= SAMPLES; k++) {
      const d = (row.travel * k) / SAMPLES;
      let backed = -Infinity;
      for (let i = 0; i < starts.length; i++) {
        const right = starts[i] - d + row.tiles[i].w;
        if (right > backed) backed = right;
      }
      const gap = V - backed;
      if (gap > 0.5) { uncovered++; if (gap > worst) { worst = gap; worstV = V; } }
    }
  }
  if (uncovered) {
    fail(`row ${ri + 1}: ${uncovered} sampled offsets show up to ${Math.round(worst)}px of bare paper at ${worstV}px wide`);
  } else {
    pass(`fully covered at all ${SAMPLES} offsets × ${VIEWPORTS.length} viewports`);
  }

  // ---- 5. drift speed -------------------------------------------------
  const pxPerSec = copyStride / row.dur;
  if (pxPerSec > 15 && pxPerSec < 80) pass(`drift ${pxPerSec.toFixed(1)} px/s (readable band 15–80)`);
  else fail(`row ${ri + 1}: drift ${pxPerSec.toFixed(1)} px/s is outside the readable band`);

  // ---- 6. every image actually reaches the wall -----------------------
  console.log("");
});

const onWall = new Set(rows.flatMap((r) => r.tiles.map((t) => t.slug)));
const all = Object.keys(manifest.pages);
const missing = all.filter((s) => !onWall.has(s));
if (missing.length) fail(`never placed on the wall: ${missing.join(", ")}`);
else pass(`all ${all.length} images appear on the wall`);

console.log("");
console.log(failures ? `✗ ${failures} wall-loop problem(s)` : "✓ the wall loops seamlessly at every tested width");
process.exit(failures ? 1 : 0);
