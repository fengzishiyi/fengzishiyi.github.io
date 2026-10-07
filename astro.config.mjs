import { defineConfig } from "astro/config";

/**
 * Astro is the build; it is not the renderer of article bodies.
 *
 * The site's own writing syntax — admonitions, folds, epigraphs, columns, notes,
 * citations and `{{ref:}}` — plus the structural pass that assigns positional
 * heading ids and wraps sections is in `src/lib/markdown.mjs` and
 * `src/lib/sitetext.mjs`, on Astro's own Markdown engine but under this site's
 * control. `markdown.processor` is therefore left at its default: registering
 * those plugins here as well would give `<Content />` a second, subtly different
 * renderer, and a page rendered through the wrong one would look almost right.
 *
 * There is no integration list either. The sitemap and the feed are endpoints in
 * `src/pages/`, generated from the same model the pages use, so there is no
 * plugin to configure and nothing to keep in step.
 */
export default defineConfig({
  site: "https://fengzishiyi.github.io",
  output: "static",
  // Every address on this site ends in a slash and every page is a directory:
  // `/compsci/why-plain-text/` rather than `/compsci/why-plain-text.html`. Both
  // settings are load-bearing — the URLs are published, and old links are
  // someone else's bookmarks.
  trailingSlash: "always",
  build: { format: "directory" }
});
