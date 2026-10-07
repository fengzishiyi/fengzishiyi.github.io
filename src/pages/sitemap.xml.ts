import { getSiteModel } from "../lib/model.mjs";

/**
 * Every real page, and nothing else.
 *
 * The redirect stubs are deliberately absent: they carry `noindex` and exist for
 * old bookmarks, so listing them would ask a search engine to index an address
 * whose only content is a pointer. `/404.html` is absent for the same reason.
 */
export async function GET() {
  const m = await getSiteModel();
  const { site } = m;

  const urls = [
    "/", "/writing/", "/archive/", "/tags/", "/series/", "/search/", "/changelog/", "/about/",
    ...m.sections.map((s) => `/${s.key}/`),
    ...m.tags.map((t) => `/tags/${encodeURIComponent(t.name)}/`),
    ...m.series.map((s) => `/series/${encodeURIComponent(s.name)}/`),
    ...m.articles.map((a) => a.url),
    ...Object.values(m.collections).flat().map((e) => e.url).filter(Boolean)
  ];

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map((u) => `  <url><loc>${site.origin}${u}</loc></url>`).join("\n")
    + "\n</urlset>\n";
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
