#!/usr/bin/env node
/**
 * contrast.mjs — measure the real contrast of text that sits ON images.
 *
 * The style assertions in build.mjs can only check flat token pairs. Text laid
 * over a photograph is the one place that check cannot reach, and it is exactly
 * where a design like this breaks: white type over a pale illustration looks
 * fine in the markup and is unreadable in front of a reader.
 *
 * So this samples the ACTUAL composited pixels under the text — screenshot the
 * region, average the scrim-covered photo, composite the scrim over it, and
 * compute the ratio against the text colour.
 *
 *   node src/contrast.mjs            (requires `npm run serve`)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Browser } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || 4321;
const BASE = `http://127.0.0.1:${PORT}`;

const PAPER = [249, 248, 246];
const INK = [28, 28, 28];

const lum = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/** Parse "rgba(28, 28, 28, 0.78)" → { rgb, a } */
function parseColor(str) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/.exec(str);
  if (!m) return null;
  return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
}
const over = (top, alpha, base) => top.map((c, i) => c * alpha + base[i] * (1 - alpha));

const browser = await Browser.launch();
let failures = 0;
fs.mkdirSync(path.join(ROOT, ".shots"), { recursive: true });

const pages = ["/", ...fs.readdirSync(path.join(ROOT, "articles"), { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => `/articles/${e.name}/`)];

console.log("text-over-image contrast (measured from rendered pixels)\n");

for (const page of pages) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const session = await browser.open({ url: BASE + page, width: w, height: h });

    // 1. where is the text, and over what?
    const info = await session.evalJson(`(() => {
      const out = { texts: [] };
      const pick = (sel, name) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        // find the scrim this text sits on
        let scrim = null;
        const holder = el.closest(".opener") || el.closest(".feature");
        if (holder) {
          const s = holder.querySelector(".opener__scrim");
          if (s) {
            const sr = s.getBoundingClientRect();
            // only counts as a scrim if it actually covers this text
            if (sr.top <= r.top && sr.bottom >= r.bottom - 1) {
              const sc = getComputedStyle(s);
              scrim = { bg: sc.backgroundColor, top: sr.top, height: sr.height };
            }
          }
        }
        out.texts.push({ name, color: cs.color, top: Math.round(r.top), bottom: Math.round(r.bottom),
                         left: Math.round(r.left), right: Math.round(r.right), scrim,
                         holder: holder ? holder.className : null });
      };
      pick(".opener__title", "opener title");
      pick(".opener__deck", "opener deck");
      pick(".opener__byline", "opener byline");
      pick(".feature__title", "feature title");
      return JSON.stringify(out);
    })()`);

    if (!info.texts.length) { await session.close(); continue; }

    const png = path.join(ROOT, ".shots", `contrast-${w}.png`);
    await browser.shoot({ url: BASE + page, width: w, height: h, out: png });

    for (const t of info.texts) {
      const fg = parseColor(t.color);
      if (!fg) continue;
      if (!t.scrim) {
        // sits on plain paper — the flat check in build.mjs already covers it
        continue;
      }
      const scrimCol = parseColor(t.scrim.bg);
      if (!scrimCol) continue;

      // 2. average the photographed pixels in a band wall-to-wall directly
      //    BEHIND the text, clipped to the scrim. Sampling the whole scrim
      //    instead would average in areas no text touches and overstate how
      //    dark the backdrop is.
      const clipTop = Math.max(0, Math.round(Math.max(t.top, t.scrim.top) + 2));
      const clipBottom = Math.min(h, Math.round(Math.min(t.bottom, t.scrim.top + t.scrim.height) - 2));
      const bandH = Math.max(1, clipBottom - clipTop);
      const raw = await sharp(png).extract({ left: 0, top: clipTop, width: w, height: bandH })
        .raw().toBuffer({ resolveWithObject: true });
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < raw.data.length; i += raw.info.channels) {
        r += raw.data[i]; g += raw.data[i + 1]; b += raw.data[i + 2]; n++;
      }
      const photo = [r / n, g / n, b / n];

      // 3. composite the scrim over the photo, then ratio against the text
      const composited = over(scrimCol.rgb, scrimCol.a, photo);
      const cr = ratio(fg.rgb, composited);
      // large text (>=24px or >=19px bold) only needs 3:1
      const px = parseFloat(t.name.includes("deck") || t.name.includes("byline") ? "16" : "48");
      const need = px >= 24 ? 3 : 4.5;
      const ok = cr >= need;
      if (!ok) failures++;
      console.log(
        `  ${ok ? "ok  " : "FAIL"} ${page.padEnd(36)} ${String(w).padStart(4)}px  ${t.name.padEnd(14)} ` +
        `${cr.toFixed(2)}:1  (need ${need}, scrim α${scrimCol.a})`
      );
    }
    await session.close();
  }
}

await browser.close();
console.log("");
console.log(failures ? `✗ ${failures} unreadable text-over-image placement(s)` : "✓ all text over images meets WCAG AA");
process.exit(failures ? 1 : 0);
