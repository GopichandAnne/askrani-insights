import * as cheerio from "cheerio";

/**
 * JSON-LD / Schema.org extraction — guide 5.4 step 3 and 6.2 (website page):
 * "Parse JSON-LD and Schema.org entities first: LocalBusiness, Restaurant, Menu,
 * Product, Offer and Event." Structured markup is the cheapest, highest-trust
 * signal on a page, so we mine it before falling back to model extraction.
 */

export interface JsonLdFacts {
  businessName?: string;
  phone?: string;
  address?: string;
  cuisines?: string[];
  priceRange?: string;
  openingHours?: string[];
  menuItems: Array<{
    name: string;
    price?: number;
    currency?: string;
    section?: string;
    description?: string;
  }>;
  offers: Array<{
    name?: string;
    price?: number;
    currency?: string;
    validFrom?: string;
    validThrough?: string;
  }>;
  events: Array<{ name?: string; startDate?: string; endDate?: string }>;
  raw: unknown[];
}

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

const typesOf = (node: any): string[] =>
  asArray<string>(node?.["@type"]).map((t) => String(t).toLowerCase());

function parsePrice(offer: any): { price?: number; currency?: string } {
  if (!offer) return {};
  const p = offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price;
  const currency =
    offer.priceCurrency ?? offer.priceSpecification?.priceCurrency;
  const price = p != null ? Number(String(p).replace(/[^0-9.]/g, "")) : undefined;
  return {
    price: Number.isFinite(price) ? price : undefined,
    currency: currency ? String(currency) : undefined,
  };
}

export function extractJsonLd(html: string): JsonLdFacts {
  const $ = cheerio.load(html);
  const facts: JsonLdFacts = { menuItems: [], offers: [], events: [], raw: [] };

  const nodes: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt.trim()) return;
    try {
      const parsed = JSON.parse(txt);
      // @graph containers and bare arrays both appear in the wild
      if (parsed["@graph"]) nodes.push(...asArray(parsed["@graph"]));
      else nodes.push(...asArray(parsed));
    } catch {
      /* malformed JSON-LD is common; skip silently */
    }
  });
  facts.raw = nodes;

  const walkMenu = (node: any, section?: string) => {
    const t = typesOf(node);
    if (t.includes("menusection")) {
      const secName = node.name ?? section;
      asArray(node.hasMenuItem).forEach((mi) => walkMenu(mi, secName));
      asArray(node.hasMenuSection).forEach((s) => walkMenu(s, secName));
    } else if (t.includes("menuitem")) {
      const { price, currency } = parsePrice(asArray(node.offers)[0]);
      facts.menuItems.push({
        name: String(node.name ?? "").trim(),
        price,
        currency,
        section,
        description: node.description ? String(node.description) : undefined,
      });
    } else if (t.includes("menu")) {
      asArray(node.hasMenuSection).forEach((s) => walkMenu(s));
      asArray(node.hasMenuItem).forEach((mi) => walkMenu(mi));
    }
  };

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const t = typesOf(node);

    if (
      t.some((x) =>
        ["restaurant", "localbusiness", "foodestablishment", "store", "bakery", "cafeorcoffeeshop"].includes(x),
      )
    ) {
      facts.businessName ??= node.name ? String(node.name) : undefined;
      facts.phone ??= node.telephone ? String(node.telephone) : undefined;
      facts.priceRange ??= node.priceRange ? String(node.priceRange) : undefined;
      const addr = node.address;
      if (addr && !facts.address) {
        facts.address =
          typeof addr === "string"
            ? addr
            : [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode]
                .filter(Boolean)
                .join(", ");
      }
      if (node.servesCuisine) facts.cuisines = asArray(node.servesCuisine).map(String);
      if (node.openingHours) facts.openingHours = asArray(node.openingHours).map(String);
      if (node.hasMenu) asArray(node.hasMenu).forEach((m) => walkMenu(m));
    }

    if (t.includes("menu")) walkMenu(node);

    if (t.includes("product") || t.includes("offer")) {
      const offerNode = t.includes("offer") ? node : asArray(node.offers)[0];
      const { price, currency } = parsePrice(offerNode);
      facts.offers.push({
        name: node.name ? String(node.name) : undefined,
        price,
        currency,
        validFrom: offerNode?.validFrom,
        validThrough: offerNode?.validThrough,
      });
    }

    if (t.includes("event")) {
      facts.events.push({
        name: node.name ? String(node.name) : undefined,
        startDate: node.startDate,
        endDate: node.endDate,
      });
    }
  }

  return facts;
}

/** Plain visible text of a page, used as evidence + model-extraction input. */
export function extractReadableText(html: string, maxChars = 20000): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, header nav, footer").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text.slice(0, maxChars);
}

/** Absolute URLs of linked PDFs / images (menus, flyers) — guide 5.4 step 4. */
export function extractDocumentLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $("a[href], img[src]").each((_, el) => {
    const href = $(el).attr("href") ?? $(el).attr("src");
    if (!href) return;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (/\.(pdf|png|jpe?g|webp)(\?|#|$)/i.test(abs)) out.add(abs);
    } catch {
      /* ignore malformed href */
    }
  });
  return [...out];
}
