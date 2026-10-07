import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

/**
 * The content schema.
 *
 * Astro validates this before any page is built, so a missing title or a domain
 * that is not one of the three is reported as a content error with the file name
 * rather than as a broken page. What the schema CANNOT check — whether a slug is
 * unique across collections, whether a `{{ref:}}` points at something, whether a
 * cover's derivatives exist — is checked by src/lib/model.mjs, which sees every
 * entry at once.
 */

const date = z.union([z.string(), z.date()]).transform((value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value
);

/** Card footprints in the homepage grid. See templates' sizeFor: `intro` is the
 *  greeting block, `wide` spans two columns, `square` one, and the two image
 *  forms are drawings rather than sizes. */
const CARD = z.enum(["intro", "wide", "square", "image", "image_and_text"]);

const cover = {
  card: CARD.optional(),
  pin: z.coerce.number().optional(),
  image: z.string().optional(),
  image_alt: z.string().optional(),
  tags: z.array(z.string()).default([])
};

const articles = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./_articles" }),
  schema: z.object({
    title: z.string().min(1),
    slug: z.string().min(1).optional(),
    description: z.string().min(1),
    domain: z.enum(["literature", "philosophy", "compsci"]),
    kind: z.string().min(1),
    created: date,
    modified: date.optional(),
    status: z.string().optional(),
    confidence: z.string().optional(),
    importance: z.coerce.number().min(0).max(10).optional(),
    series: z.string().optional(),
    license: z.string().optional(),
    source: z.string().optional(),
    ...cover
  })
});

const entry = (base) => defineCollection({
  loader: glob({ pattern: "**/*.md", base }),
  schema: z.object({
    title: z.string().min(1),
    slug: z.string().min(1).optional(),
    created: date,
    description: z.string().optional(),
    status: z.string().optional(),
    author: z.string().optional(),
    note: z.string().optional(),
    ...cover
  })
});

export const collections = {
  articles,
  reading: entry("./_reading"),
  hobbies: entry("./_hobbies")
};
