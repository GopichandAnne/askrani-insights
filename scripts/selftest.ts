/**
 * Deterministic self-test of the intelligence layer with no external services:
 * JSON-LD extraction → offer creation (pipeline, jsonld path) → recommendations.
 * Run: npm run selftest
 */
import { extractJsonLd } from "../src/lib/providers/website/jsonld";
import { runExtraction } from "../src/lib/extraction/pipeline";
import type { RawObservation } from "../src/lib/providers/types";
import { generateRecommendations, type BusinessOffers } from "../src/lib/recommend/engine";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

// A realistic restaurant page with Schema.org Menu markup.
const HTML = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Restaurant","name":"Rani's Kitchen",
 "telephone":"+1-512-555-0100","servesCuisine":["Indian"],"priceRange":"$$",
 "address":{"@type":"PostalAddress","streetAddress":"12 Main St","addressLocality":"Austin","addressRegion":"TX"},
 "hasMenu":{"@type":"Menu","hasMenuSection":[
   {"@type":"MenuSection","name":"Mains","hasMenuItem":[
     {"@type":"MenuItem","name":"Butter Chicken","offers":{"@type":"Offer","price":"16.99","priceCurrency":"USD"}},
     {"@type":"MenuItem","name":"Chicken Biryani","offers":{"@type":"Offer","price":"15.50","priceCurrency":"USD"}}
   ]},
   {"@type":"MenuSection","name":"Lunch Special","hasMenuItem":[
     {"@type":"MenuItem","name":"Weekday Lunch Combo","offers":{"@type":"Offer","price":"11.99","priceCurrency":"USD"}}
   ]}
 ]}}
</script></head><body><h1>Rani's Kitchen</h1></body></html>`;

async function main() {
  console.log("1) JSON-LD extraction");
  const facts = extractJsonLd(HTML);
  assert(facts.businessName === "Rani's Kitchen", "parses business name");
  assert(facts.menuItems.length === 3, `parses 3 menu items (got ${facts.menuItems.length})`);
  assert(facts.menuItems.some((m) => m.name === "Butter Chicken" && m.price === 16.99), "parses Butter Chicken @ 16.99");
  assert(facts.cuisines?.[0] === "Indian", "parses cuisine");

  console.log("2) Pipeline → offers (jsonld path, no LLM)");
  const obs: RawObservation = {
    provider: "website",
    provenance: "PUBLIC_WEBSITE_HTTP",
    platform: "website",
    contentKind: "menu",
    sourceUrl: "https://ranis.example/menu",
    businessHint: { name: facts.businessName },
    media: [],
    observedAt: new Date().toISOString(),
    contentHash: "test",
    raw: {},
    structuredHints: {
      jsonld: {
        businessName: facts.businessName,
        menuItems: facts.menuItems,
        offers: facts.offers,
        events: facts.events,
      },
    },
  };
  const out = await runExtraction(obs, { vertical: "restaurant", name: facts.businessName });
  assert(out.offers.length === 3, `pipeline emits 3 offers (got ${out.offers.length})`);
  assert(out.offers.every((o) => o.confidence >= 0.9), "jsonld offers are high-confidence");
  assert(out.review === "confirmed", "high-confidence extraction auto-confirms");

  console.log("3) Recommendations (target missing lunch, peers have it)");
  const target: BusinessOffers = {
    businessId: "t",
    name: "Rani's Kitchen",
    offers: out.offers.filter((o) => !/lunch/i.test(o.entity_text)), // drop the lunch combo
  };
  const peers: BusinessOffers[] = [
    { businessId: "p1", name: "Curry House", offers: [{ ...out.offers[0], entity_text: "Weekday Lunch Special" } as any] },
    { businessId: "p2", name: "Spice Route", offers: [{ ...out.offers[0], entity_text: "Lunch Thali Combo" } as any] },
  ];
  const recs = generateRecommendations(target, peers);
  assert(recs.length > 0, `generates recommendations (got ${recs.length})`);
  assert(recs.some((r) => /lunch/i.test(r.title)), "detects the weekday lunch gap");
  assert(recs.every((r) => r.evidence.length > 0), "every recommendation carries evidence");
  console.log("\n   top rec:", recs[0]?.title, "→ priority", recs[0]?.priority);

  console.log(failures === 0 ? "\nALL PASSED ✓" : `\n${failures} FAILED ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
