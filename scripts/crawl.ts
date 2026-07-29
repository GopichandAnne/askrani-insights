/**
 * Ad-hoc crawl runner — verifies the website adapter end-to-end with no
 * external accounts:  npm run crawl -- https://some-restaurant.com
 *
 * Prints normalized RawObservations (the exact shape ingestion persists) so you
 * can see JSON-LD menu items, offers and page text being extracted.
 */
import { crawlWebsite } from "../src/lib/providers/website/crawler";

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: npm run crawl -- <website-url> [maxPages]");
    process.exit(1);
  }
  const maxPages = Number(process.argv[3] ?? 10);
  console.error(`crawling ${url} (max ${maxPages} pages)…`);
  const r = await crawlWebsite(url, { maxPages });
  console.error(
    `\npages fetched: ${r.pagesFetched}  unchanged: ${r.pagesSkippedUnchanged}  robots: ${r.robotsPolicy}  errors: ${r.errors.length}`,
  );
  for (const o of r.observations) {
    const jl = (o.structuredHints as any)?.jsonld;
    console.log(
      JSON.stringify(
        {
          kind: o.contentKind,
          url: o.sourceUrl,
          business: o.businessHint?.name,
          menuItems: jl?.menuItems?.length ?? 0,
          offers: jl?.offers?.length ?? 0,
          media: o.media.length,
          textPreview: (o.text ?? "").slice(0, 120),
        },
        null,
        2,
      ),
    );
  }
  if (r.errors.length) console.error("errors:", r.errors.slice(0, 5));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
