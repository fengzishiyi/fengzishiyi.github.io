/**
 * images.mjs — the card-cover pipeline.
 *
 * Masters live in `_images/` (gitignored: originals are large and easy to lose)
 * or beside the entry that names them. This module turns a front-matter
 * `image:` into the small, local, responsive set of files a card actually loads.
 *
 * Three decisions worth stating:
 *
 *  1. **Nothing is loaded from anywhere else.** chester.how serves its covers
 *     from an image CDN; this site serves them from its own `img/` folder,
 *     because "no third-party requests" is a promise the rest of the site is
 *     built around.
 *
 *  2. **WebP only, with intrinsic dimensions in the markup.** Every browser that
 *     can run the rest of this site reads WebP, so a JPEG fallback would double
 *     the file count to serve nobody. Width and height come from the file that
 *     was actually written, which is what stops the grid reflowing as pictures
 *     arrive.
 *
 *  3. **The derivatives are committed under `public/img/`.** A fresh clone has no
 *     `_images/` — it is gitignored — and CI must not need it. So the WebP files
 *     are part of the repository, `npm run images` is the only thing that writes
 *     them, and `cardJson` below only ever reads what is already on disk.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Display widths the grid can ask for.
 *
 * The four-column grid caps at a 1536px wrap, so a square cell is about 370px
 * wide and a `wide` one about 740px; doubled for a retina screen that is 740 and
 * 1480. 1200 is the compromise for the wide cell — a 1480px file costs more
 * bytes than the difference is worth — and the `sizes` attribute tells the
 * browser which one it is getting.
 */
export const WIDTHS = [400, 800, 1200];

/** The crop every derivative shares. Cards draw pictures with `object-fit:
 *  cover`, so the file's aspect only decides how much is thrown away; 3:2 keeps
 *  a photo readable at cell size and costs fewer bytes than the master's shape. */
export const RATIO = 2 / 3;

const EXT = /\.(jpe?g|png|webp|avif|tiff?)$/i;

export const derivativeName = (slug, width) => `${slug}-${width}.webp`;

/** Where a master might be: beside the entry that names it, or in `_images/`.
 *  Both are legitimate — one entry's cover is easier to keep beside it, a pile
 *  of pictures is easier to keep in one folder. */
export function findMaster(name, contentFile, root) {
  const candidates = [
    path.join(path.dirname(path.join(root, contentFile)), name),
    path.join(root, "_images", name)
  ];
  return candidates.find((p) => fs.existsSync(p) && EXT.test(p)) || null;
}

/** The published `img/` folder: Astro copies `public/` into `dist/`, so this is
 *  both where the generator writes and where the site reads. */
export const imgDir = (root) => path.join(root, "public", "img");

/** What a card needs to draw its cover, from the derivatives that exist.
 *
 *  Returns `null` when the entry names no picture — a site with no covers is a
 *  valid site, and `null` is how the card component spells "plain text card". */
export function cardJson(slug, alt, root) {
  const widths = WIDTHS.filter((w) => fs.existsSync(path.join(imgDir(root), derivativeName(slug, w))));
  if (!widths.length) return null;
  const largest = widths.at(-1);
  return {
    src: `/img/${derivativeName(slug, largest)}`,
    srcset: widths.map((w) => `/img/${derivativeName(slug, w)} ${w}w`).join(", "),
    width: largest,
    height: Math.round(largest * RATIO),
    alt: alt || ""
  };
}

/** The `sizes` attribute for a card footprint: how wide the picture is drawn, per
 *  breakpoint. Without it the browser assumes 100vw and downloads the largest
 *  file on every phone. */
export const sizesFor = (footprint) => (footprint === "wide"
  ? "(min-width: 1280px) 45vw, 92vw"
  : "(min-width: 1280px) 23vw, (min-width: 1024px) 31vw, (min-width: 640px) 46vw, 92vw");

/* ── the generator ──────────────────────────────────────────────────────── */

/** Write the derivatives for one entry. Called only by `npm run images`.
 *
 *  `sharp` is imported lazily so that building the site itself never needs it:
 *  CI installs production dependencies only, and the WebP files it publishes are
 *  already in the repository. */
export async function generateFor(item, root) {
  const { default: sharp } = await import("sharp");
  const name = String(item.image || "").trim();
  if (!name) return { written: 0, reused: false, missing: false };

  const master = findMaster(name, item.file, root);
  const out = imgDir(root);
  if (!master) {
    const kept = WIDTHS.filter((w) => fs.existsSync(path.join(out, derivativeName(item.slug, w))));
    return { written: 0, reused: kept.length > 0, missing: true };
  }

  const info = await sharp(master).metadata();
  if (!info.width || !info.height) return { written: 0, reused: false, missing: true, unreadable: true };

  // Never upscale: a 500px master asked for 1200 would only get blurrier.
  const wanted = WIDTHS.filter((w) => w <= info.width);
  const widths = wanted.length ? wanted : [WIDTHS[0]];
  fs.mkdirSync(out, { recursive: true });
  for (const w of widths) {
    await sharp(master)
      .resize({ width: w, height: Math.round(w * RATIO), fit: "cover", position: "attention" })
      .webp({ quality: 78, effort: 4 })
      .toFile(path.join(out, derivativeName(item.slug, w)));
  }
  return { written: widths.length, reused: false, missing: false, widths };
}
