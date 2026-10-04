/**
 * images.mjs — the card-cover pipeline.
 *
 * Masters live in `_images/` (gitignored: originals are large and easy to lose,
 * and the build only ever needs the derivatives) or beside the entry that names
 * them. This module turns a front-matter `image:` into the small, local,
 * responsive set of files a card actually loads.
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
 *  3. **Derivatives outlive a missing master.** A fresh clone has no `_images/`
 *     — it is gitignored — but it does have the built site committed. When the
 *     master is gone and the derivative is there, reuse it and say so, rather
 *     than failing a build over a file the repository was never meant to hold.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

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
const RATIO = 2 / 3;

const EXT = /\.(jpe?g|png|webp|avif|tiff?)$/i;

export const derivativeName = (slug, width) => `${slug}-${width}.webp`;

/** Where a master might be: beside the entry that names it, or in `_images/`.
 *  Both are legitimate — one entry's cover is easier to keep beside it, a pile
 *  of pictures is easier to keep in one folder. */
export function findMaster(name, contentFile, root) {
  const candidates = [
    path.join(path.dirname(contentFile), name),
    path.join(root, "_images", name)
  ];
  return candidates.find((p) => fs.existsSync(p) && EXT.test(p)) || null;
}

/** Resolve one entry's image and work out which widths it needs.
 *
 *  Always async and always the same shape, so the caller has one thing to handle.
 *  Problems are recorded rather than thrown: the build collects every content
 *  problem in a run so a writer can fix them in one pass. */
export async function prepareImage(item, root, problems) {
  const name = String(item.image || "").trim();
  if (!name) return null;

  const { slug } = item;
  const publishedAt = (w) => path.join(root, "img", derivativeName(slug, w));
  const master = findMaster(name, item.file, root);

  if (!master) {
    const kept = WIDTHS.filter((w) => fs.existsSync(publishedAt(w)));
    if (!kept.length) {
      problems.error(item.name, `image: ${name} 找不到。放在条目旁边，或放进 _images/。`);
      return null;
    }
    problems.warn(`${item.name}: 找不到母图 ${name}，沿用上次生成的 ${kept.length} 个衍生图`);
    return { slug, alt: item.imageAlt, master: null, widths: kept, reused: true };
  }

  const info = await sharp(master).metadata();
  if (!info.width || !info.height) {
    problems.error(item.name, `image: ${name} 不是能读的图片`);
    return null;
  }
  // Never upscale: a 500px master asked for 1200 would only get blurrier.
  const widths = WIDTHS.filter((w) => w <= info.width);
  return { slug, alt: item.imageAlt, master, widths: widths.length ? widths : [WIDTHS[0]], reused: false };
}

/** Write the derivatives into the staging tree, and return what the card needs.
 *
 *  Only ever writes into `.build/`: `publish()` mirrors that into the published
 *  `img/` folder and prunes what is no longer produced, so there is exactly one
 *  path by which files reach the site. */
export async function emitImage(prepared, root) {
  if (!prepared) return null;
  const { slug, alt, widths, master, reused } = prepared;

  if (!reused) {
    const out = path.join(root, ".build", "img");
    fs.mkdirSync(out, { recursive: true });
    for (const w of widths) {
      await sharp(master)
        .resize({ width: w, height: Math.round(w * RATIO), fit: "cover", position: "attention" })
        .webp({ quality: 78, effort: 4 })
        .toFile(path.join(out, derivativeName(slug, w)));
    }
  }

  const largest = widths[widths.length - 1];
  return {
    srcset: widths.map((w) => `/img/${derivativeName(slug, w)} ${w}w`).join(", "),
    src: `/img/${derivativeName(slug, largest)}`,
    width: largest,
    height: Math.round(largest * RATIO),
    alt,
    reused
  };
}

/** The `sizes` attribute for a card footprint: how wide the picture is drawn, per
 *  breakpoint. Without it the browser assumes 100vw and downloads the largest
 *  file on every phone. */
export const sizesFor = (footprint) => (footprint === "wide"
  ? "(min-width: 1280px) 45vw, 92vw"
  : "(min-width: 1280px) 23vw, (min-width: 1024px) 31vw, (min-width: 640px) 46vw, 92vw");
