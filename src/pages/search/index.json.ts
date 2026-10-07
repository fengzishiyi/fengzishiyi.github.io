import { getSiteModel } from "../../lib/model.mjs";

/** The search index: one record per piece, including the full plain text. It is
 *  fetched once by /search/ and never leaves the reader's browser. */
export async function GET() {
  const m = await getSiteModel();
  return new Response(JSON.stringify(m.searchIndex), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
