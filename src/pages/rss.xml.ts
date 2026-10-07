import { getSiteModel } from "../lib/model.mjs";
import { esc } from "../lib/text.mjs";

/** The 30 most recent pieces, as RSS 2.0. Descriptions only — a feed reader that
 *  wants the text can follow the permalink, and a full-text feed would make this
 *  site's reading experience into someone else's. */
export async function GET() {
  const m = await getSiteModel();
  const { site } = m;

  const items = m.articles.slice(0, 30).map((a) => `    <item>
      <title>${esc(a.title)}</title>
      <link>${esc(site.origin + a.url)}</link>
      <guid isPermaLink="true">${esc(site.origin + a.url)}</guid>
      <pubDate>${new Date(a.created + "T00:00:00Z").toUTCString()}</pubDate>
      <category>${esc(a.domainName)} · ${esc(a.kindName)}</category>
      <description>${esc(a.description)}</description>
    </item>`).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(site.title)}</title>
    <link>${esc(site.origin + "/")}</link>
    <description>${esc(site.tagline)}</description>
    <language>${esc(site.lang)}</language>
    <atom:link href="${esc(site.origin)}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
