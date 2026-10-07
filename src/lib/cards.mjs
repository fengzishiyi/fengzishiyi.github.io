/**
 * cards.mjs — the homepage grid's shape.
 *
 * Which footprint a card occupies is a presentation decision about CONTENT
 * (poetry is short and reads well small; a book is square), so it lives here
 * rather than inside the card component: the grid needs to know a card's size
 * before it can be laid out, and the checker needs to know the three footprints
 * exist without reading any markup.
 */

/** Footprint and VARIANT are separate questions: `card: image` is a way of
 *  drawing a card, not a size, and treating it as one silently gave every cover
 *  the wrong variant. Size is here; the variant is Card.astro's. */
export function sizeFor(item) {
  if (item.card === "wide") return "wide";
  if (item.card === "intro" || item.card === "square") return item.card;
  // A cover looks best square unless told otherwise; `image_and_text` needs the
  // height for its scrim, and `image` would happily be wide.
  return "square";
}

/**
 * The grid's order: pinned first by their number, then newest first.
 *
 * The intro block is cell 0 and the items follow, so `--i` starts at 1 — the
 * entrance is per-cell, and a wide card occupies two columns.
 */
export function orderedCards(articles, collections) {
  const pinned = [];
  const rest = [];
  for (const a of articles) (a.pin > 0 ? pinned : rest).push(a);
  for (const list of Object.values(collections)) for (const e of list) (e.pin > 0 ? pinned : rest).push(e);

  pinned.sort((a, b) => a.pin - b.pin || b.created.localeCompare(a.created));
  rest.sort((a, b) => b.created.localeCompare(a.created));

  return [...pinned, ...rest].map((item, i) => ({ item, size: sizeFor(item), index: i + 1 }));
}

/**
 * The opening tile — a large square holding the site's own description, exactly
 * where the reference puts its greeting.
 *
 * It is also the page's only `<h1>`. Putting a visible heading elsewhere would
 * fight the design, where the greeting IS the top of the page; a visually-hidden
 * `<h1>` would satisfy a checker and no reader.
 */
export const introFor = (site) => ({
  h1: site.introH1 || site.title,
  introHtml: site.introHtml
    || `<p class="card__intro">这里是 <span class="accent">${site.title}</span>，一个写字的地方。</p>`
});
