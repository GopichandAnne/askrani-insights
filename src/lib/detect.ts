import { getProvider } from "@/lib/providers/registry";
import { inferVertical, extractSubtype, subtypeLabel } from "@/lib/classify";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Universal business auto-detect — the INSIDE of Rani's Phase-1 onboarding.
 *
 * Rani's setup interview learns ONE identifier from the owner — a street address
 * (a local storefront) or a website (an online / product company) — and calls this
 * to fill in everything else from public data, so the owner confirms instead of
 * types. This is deliberately an UN-METERED onboarding cost: a Google Places detail
 * lookup (or a homepage fetch) is a few tenths of a cent, and paying it to remove
 * setup friction is worth more than the charge. The deep, credit-metered scans
 * (competitors, socials) stay behind the explicit Insights opt-in.
 *
 * Reuses the same providers Insights already runs — the Google Places adapter for
 * local, a light homepage read + LLM for online — so nothing new to maintain.
 * Governed contract: called by Rani's `detect-business` edge function with the
 * shared RANI_OPS_SECRET (see /api/rani/detect). Fail-soft everywhere — onboarding
 * must never dead-end on a lookup, so a miss returns `null`, never throws.
 */

export type DetectKind = "local" | "online";

/** A confirm-me draft of the store's customer-service knowledge, synthesized from
 *  the business's own public footprint (website + reviews) plus typical patterns
 *  for its kind. The owner tweaks it in one message — never types it from blank. */
export interface DraftKnowledge {
  departments?: string[];              // sections a customer navigates (aisles / menu / service groups)
  services?: string[];                 // deli, hot food, catering, pickup, delivery, appointments, …
  faqs?: { q: string; a: string }[];   // the questions this kind of place gets, with short suggested answers
  highlights?: string[];               // what this place is known for (from reviews / editorial)
}

export interface DetectedBusiness {
  name: string;
  /** Google primaryType (e.g. "hardware_store", "indian_restaurant") — the single
   *  richest hint for Rani's business-type classifier. */
  category?: string;
  /** Insights' coarse vertical (grocery/restaurant/salon) when it applies. */
  vertical?: string;
  subtype?: string;
  address?: string;
  website?: string;
  phone?: string;
  mapsUrl?: string;
  /** Human-readable weekday hours, e.g. ["Monday: 9 AM – 6 PM", …]. */
  hours?: string[];
  rating?: number;
  reviews?: number;
  /** Online only — one/two-sentence read of what the company does. */
  summary?: string;
  /** Online only — main products/services/features detected on the homepage. */
  offerings?: string[];
  /** Local only — a draft knowledge base the owner confirms (Lever A). */
  knowledge?: DraftKnowledge;
  /** Online / B2B only — the product-company playbook draft (P3). */
  b2b?: B2bDraft;
  placeId?: string;
}

/** The product/B2B company draft — what a prospect asks about, and which leads to
 *  capture. Built from the company's own site (home + about/product/pricing/…). */
export interface B2bDraft {
  features?: string[];       // key product capabilities/features
  integrations?: string[];   // systems it connects to
  pricingTiers?: string[];   // named plans/tiers, or "contact sales"
  faqs?: { q: string; a: string }[];
  /** Lead types worth capturing — subset of demo / quote / support / careers. */
  captureTypes?: string[];
}

export interface DetectResult {
  detected: DetectedBusiness | null;
  source: "google" | "website" | "none";
}

/* ── local: address → Google Place (basics + hours) ─────────────────────────── */

interface PlaceDetails {
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  types?: string[];
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  editorialSummary?: { text?: string };
  reviews?: { text?: { text?: string }; originalText?: { text?: string }; rating?: number }[];
  location?: { latitude: number; longitude: number };
}

async function placeDetails(placeId: string, key: string): Promise<PlaceDetails | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "id,displayName,formattedAddress,location,rating,userRatingCount,websiteUri,nationalPhoneNumber,internationalPhoneNumber,primaryType,types,regularOpeningHours.weekdayDescriptions,editorialSummary,reviews",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as PlaceDetails;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* ── Lever A: draft the store's knowledge from its public footprint ─────────── */

// Typical patterns per vertical — HINTS the LLM grounds against when the website
// and reviews are thin, plus the site paths worth reading for each. Vertical-
// agnostic otherwise: for anything outside these three the LLM infers from the
// Google category + website text alone.
const VERTICAL_KB: Record<string, { departments: string[]; services: string[]; faqTopics: string[]; paths: string[] }> = {
  grocery: {
    departments: ["Produce", "Frozen foods", "Dairy & eggs", "Spices & lentils", "Snacks", "Beverages", "Bakery", "Meat & seafood", "Household"],
    services: ["Deli / hot food counter", "Catering", "Pickup", "Delivery", "Special orders"],
    faqTopics: ["fresh produce availability", "halal/meat counter", "hot or prepared food", "catering", "delivery & pickup", "hours & parking"],
    paths: ["/departments", "/services", "/about"],
  },
  restaurant: {
    departments: ["Appetizers", "Mains", "Breads", "Desserts", "Beverages"],
    services: ["Dine-in", "Takeout", "Delivery", "Catering", "Reservations"],
    faqTopics: ["menu & dietary options (veg/vegan/halal/spice level)", "reservations", "catering", "delivery & takeout", "hours & parking"],
    paths: ["/menu", "/catering", "/about"],
  },
  salon: {
    departments: ["Hair", "Skin & facials", "Nails", "Waxing & threading", "Massage"],
    services: ["Walk-ins", "Appointments", "Bridal & events", "Memberships & packages"],
    faqTopics: ["services & pricing", "walk-in vs appointment", "bridal & events", "hours & parking"],
    paths: ["/services", "/pricing", "/about"],
  },
};

async function fetchPageText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "AskRani-Setup/1.0 (+https://askrani.ai)", accept: "text/html" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return "";
    return htmlToText((await res.text()).slice(0, 300_000)).text;
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

const KNOWLEDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    departments: { type: "array", items: { type: "string" }, maxItems: 12, description: "The main sections/aisles a customer navigates here (grocery aisles, menu sections, or service groups). Short labels." },
    services: { type: "array", items: { type: "string" }, maxItems: 10, description: "Services this place offers a customer — e.g. deli/hot food, catering, pickup, delivery, appointments, special orders. [] if none apparent." },
    faqs: {
      type: "array", maxItems: 6,
      items: { type: "object", additionalProperties: false, properties: { q: { type: "string" }, a: { type: "string" } }, required: ["q", "a"] },
      description: "The 4-6 questions a customer of THIS kind of business most often asks, each with a short, safe suggested answer the owner can edit. Ground answers in the website/reviews where possible; keep them 1 sentence.",
    },
    highlights: { type: "array", items: { type: "string" }, maxItems: 6, description: "What this specific place is known for, drawn from its reviews/editorial summary. [] if unclear." },
  },
  required: ["departments", "services", "faqs", "highlights"],
};

/** Synthesize a confirm-me knowledge draft from the business's public footprint.
 *  Cheap + un-metered (a light site read + one classify-tier call). Fail-soft. */
async function draftKnowledge(
  d: DetectedBusiness,
  reviewSnippets: string[],
): Promise<DraftKnowledge | undefined> {
  if (!isLlmConfigured()) return undefined;

  const kb = d.vertical ? VERTICAL_KB[d.vertical] : undefined;

  // Light website read — homepage + a couple of vertical-relevant pages, in
  // parallel with short timeouts. Best-effort; missing pages just return "".
  let siteText = "";
  if (d.website) {
    const base = normalizeUrl(d.website);
    if (base) {
      const origin = (() => { try { return new URL(base).origin; } catch { return base; } })();
      const paths = kb?.paths ?? ["/about", "/services"];
      const urls = [base, ...paths.map((p) => `${origin}${p}`)].slice(0, 4);
      const texts = await Promise.all(urls.map(fetchPageText));
      siteText = texts.filter(Boolean).join("\n\n").slice(0, 6000);
    }
  }

  // Nothing but a bare listing and no vertical pattern? Skip — don't invent.
  if (!siteText && reviewSnippets.length === 0 && !kb) return undefined;

  const hints = kb
    ? `Typical for this kind of business (use only to fill gaps, don't force): departments ~ ${kb.departments.join(", ")}; services ~ ${kb.services.join(", ")}; common questions ~ ${kb.faqTopics.join("; ")}.`
    : "No preset pattern for this category — infer entirely from the category, website, and reviews.";
  const reviewsBlock = reviewSnippets.length ? `\n\nRECENT REVIEW SNIPPETS (what customers mention):\n- ${reviewSnippets.slice(0, 6).join("\n- ")}` : "";
  const siteBlock = siteText ? `\n\nWEBSITE TEXT:\n${siteText}` : "";

  const system =
    "You prepare a DRAFT customer-service knowledge base for a local business's AI assistant. The owner will confirm and edit it, so a sensible, specific draft beats a blank. Ground departments, services, and FAQ answers in the website and reviews provided; use typical patterns for this kind of business only to fill obvious gaps. Never invent specific prices, brands, or claims not supported by the input. Keep everything short.";
  const text = `BUSINESS: ${d.name}\nGOOGLE CATEGORY: ${d.category ?? "unknown"}\nVERTICAL: ${d.vertical ?? "unknown"}${d.summary ? `\nEDITORIAL: ${d.summary}` : ""}\n${hints}${reviewsBlock}${siteBlock}`;

  try {
    const { data } = await getLlm().callStructured<{ departments: string[]; services: string[]; faqs: { q: string; a: string }[]; highlights: string[] }>({
      system, text, schema: KNOWLEDGE_SCHEMA, tier: "classify", maxTokens: 900,
    });
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);
    const faqs = (Array.isArray(data.faqs) ? data.faqs : [])
      .map((f) => ({ q: clean(f?.q), a: clean(f?.a) }))
      .filter((f) => f.q && f.a)
      .slice(0, 6);
    const k: DraftKnowledge = {
      departments: arr(data.departments).slice(0, 12),
      services: arr(data.services).slice(0, 10),
      faqs,
      highlights: arr(data.highlights).slice(0, 6),
    };
    const any = (k.departments?.length || k.services?.length || k.faqs?.length || k.highlights?.length);
    return any ? k : undefined;
  } catch {
    return undefined;
  }
}

async function detectLocal(query: string, name?: string): Promise<DetectResult> {
  const google = getProvider("google");
  if (!google?.isConfigured()) return { detected: null, source: "none" };

  const textQuery = [name, query].filter(Boolean).join(" ").trim();
  let placeId: string | undefined;
  try {
    const cands = await google.discoverProfiles({ query: textQuery, limit: 5 });
    placeId = cands[0]?.externalId; // prominence-sorted; the top hit is the match
  } catch {
    return { detected: null, source: "none" };
  }
  if (!placeId) return { detected: null, source: "none" };

  const p = await placeDetails(placeId, process.env.GOOGLE_MAPS_API_KEY ?? "");
  if (!p) return { detected: null, source: "none" };

  const candLike = { name: p.displayName?.text, category: p.primaryType, raw: p };
  const subtype = subtypeLabel(extractSubtype(candLike));

  const detected: DetectedBusiness = {
    name: p.displayName?.text ?? name ?? "",
    category: p.primaryType,
    vertical: inferVertical(candLike),
    subtype: subtype || undefined,
    address: p.formattedAddress,
    website: p.websiteUri,
    phone: p.nationalPhoneNumber ?? p.internationalPhoneNumber,
    mapsUrl: `https://www.google.com/maps/place/?q=place_id:${placeId}`,
    hours: p.regularOpeningHours?.weekdayDescriptions?.length ? p.regularOpeningHours.weekdayDescriptions : undefined,
    rating: typeof p.rating === "number" ? p.rating : undefined,
    reviews: typeof p.userRatingCount === "number" ? p.userRatingCount : undefined,
    summary: p.editorialSummary?.text || undefined,
    placeId,
  };
  if (!detected.name) return { detected: null, source: "none" };

  // Lever A — draft the store's knowledge (departments, services, FAQs) from its
  // public footprint so the owner confirms instead of starts blank. Best-effort:
  // any failure just returns the basics.
  const reviewSnippets = (p.reviews ?? [])
    .map((r) => clean(r.text?.text ?? r.originalText?.text))
    .filter(Boolean)
    .slice(0, 6);
  detected.knowledge = await draftKnowledge(detected, reviewSnippets);

  return { detected, source: "google" };
}

/* ── online: website → company basics (homepage read + LLM) ─────────────────── */

function normalizeUrl(raw: string): string | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function htmlToText(html: string): { title: string; description: string; text: string } {
  const pick = (re: RegExp) => (html.match(re)?.[1] ?? "").trim();
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const description =
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i) ||
    pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["']/i);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
  return { title, description, text };
}

const ONLINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "The company / product / brand name." },
    category: { type: "string", description: "A short label for what kind of company this is, e.g. 'DCIM software', 'SaaS platform', 'IT consulting', 'e-commerce brand'. ≤5 words." },
    summary: { type: "string", description: "1–2 plain sentences: what the company does and who it serves. Grounded ONLY in the text." },
    offerings: { type: "array", items: { type: "string" }, maxItems: 6, description: "The main products or services named (up to 6 short phrases). [] if unclear." },
    features: { type: "array", items: { type: "string" }, maxItems: 8, description: "Key product capabilities/features a prospect would ask about. [] if not a product company." },
    integrations: { type: "array", items: { type: "string" }, maxItems: 8, description: "Named systems/tools/platforms it integrates or works with. [] if none stated." },
    pricingTiers: { type: "array", items: { type: "string" }, maxItems: 6, description: "Named pricing plans/tiers (e.g. 'Starter', 'Pro', 'Enterprise'), or ['Contact sales'] if pricing is quote-only. [] if no pricing info." },
    faqs: {
      type: "array", maxItems: 6,
      items: { type: "object", additionalProperties: false, properties: { q: { type: "string" }, a: { type: "string" } }, required: ["q", "a"] },
      description: "The 4-6 questions a PROSPECT most often asks this kind of company, each with a short suggested answer grounded in the site.",
    },
    captureTypes: {
      type: "array", items: { type: "string", enum: ["demo", "quote", "support", "careers"] }, maxItems: 4,
      description: "Which leads this company should capture: 'demo' if it offers demos/trials; 'quote' if pricing is sales/enterprise-led; 'support' if it serves existing customers (docs/help/support); 'careers' if it's hiring. Pick only those the site supports.",
    },
  },
  required: ["name", "category", "summary", "offerings", "features", "integrations", "pricingTiers", "faqs", "captureTypes"],
};

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Pages worth reading on a product/B2B site (best-effort, in parallel). */
const B2B_PATHS = ["/about", "/product", "/products", "/features", "/solutions", "/pricing", "/integrations"];

async function detectOnline(query: string): Promise<DetectResult> {
  const url = normalizeUrl(query);
  if (!url) return { detected: null, source: "none" };

  let html = "";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "AskRani-Setup/1.0 (+https://askrani.ai)", accept: "text/html" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (res.ok) html = (await res.text()).slice(0, 400_000);
  } catch {
    /* unreachable site → fall through to null */
  } finally {
    clearTimeout(t);
  }
  if (!html) return { detected: null, source: "none" };

  const host = (() => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } })();
  const { title, description, text } = htmlToText(html);

  // No LLM? Still give Rani the basics from the page's own metadata.
  if (!isLlmConfigured() || !text) {
    const name = title.split(/[|\-–—·:]/)[0].trim() || host;
    return {
      detected: { name, website: url, category: "online business", summary: description || undefined },
      source: "website",
    };
  }

  // Read a few key B2B pages so the product knowledge isn't homepage-only (P3).
  const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
  const extra = (await Promise.all(B2B_PATHS.map((p) => fetchPageText(`${origin}${p}`)))).filter(Boolean);
  const siteText = [text, ...extra].join("\n\n").slice(0, 9000);
  // Cheap hint: careers pages rarely sit on the paths above — flag from links.
  const hiring = /\b(careers|jobs|we'?re hiring|join (our|the) team|open (roles|positions))\b/i.test(html);

  const fallback = (): DetectResult => {
    const name = title.split(/[|\-–—·:]/)[0].trim() || host;
    return { detected: { name, website: url, category: "online business", summary: description || undefined }, source: "website" };
  };

  try {
    const system =
      "You read a company's website (home + key pages) and prepare a knowledge base AND lead-capture setup for an AI assistant that will answer PROSPECTS' questions and capture leads for this company. Be specific and grounded ONLY in the text provided — never invent products, integrations, prices, or claims.";
    const input = `WEBSITE: ${url}\nPAGE TITLE: ${title}\nMETA DESCRIPTION: ${description}${hiring ? "\n(The site appears to have a careers/hiring section.)" : ""}\n\nSITE TEXT (home + key pages):\n${siteText}`;
    const { data } = await getLlm().callStructured<{
      name: string; category: string; summary: string; offerings: string[];
      features: string[]; integrations: string[]; pricingTiers: string[];
      faqs: { q: string; a: string }[]; captureTypes: string[];
    }>({ system, text: input, schema: ONLINE_SCHEMA, tier: "extract", maxTokens: 1100 });

    const arr = (v: unknown, n: number) => (Array.isArray(v) ? v.map(clean).filter(Boolean).slice(0, n) : []);
    const faqs = (Array.isArray(data.faqs) ? data.faqs : [])
      .map((f) => ({ q: clean(f?.q), a: clean(f?.a) })).filter((f) => f.q && f.a).slice(0, 6);
    const captureTypes = arr(data.captureTypes, 4)
      .map((s) => s.toLowerCase())
      .filter((s) => ["demo", "quote", "support", "careers"].includes(s));
    if (hiring && !captureTypes.includes("careers")) captureTypes.push("careers");

    const b2b: B2bDraft = {
      features: arr(data.features, 8),
      integrations: arr(data.integrations, 8),
      pricingTiers: arr(data.pricingTiers, 6),
      faqs,
      captureTypes: [...new Set(captureTypes)],
    };
    const hasB2b = !!(b2b.features?.length || b2b.integrations?.length || b2b.faqs?.length || b2b.captureTypes?.length);

    const detected: DetectedBusiness = {
      name: clean(data.name) || title.split(/[|\-–—·:]/)[0].trim() || host,
      website: url,
      category: clean(data.category) || "online business",
      summary: clean(data.summary) || description || undefined,
      offerings: arr(data.offerings, 6).length ? arr(data.offerings, 6) : undefined,
      b2b: hasB2b ? b2b : undefined,
    };
    return { detected, source: "website" };
  } catch {
    return fallback();
  }
}

export async function detectBusiness(input: { kind: DetectKind; query: string; name?: string }): Promise<DetectResult> {
  const query = (input.query ?? "").trim();
  if (!query) return { detected: null, source: "none" };
  return input.kind === "online" ? detectOnline(query) : detectLocal(query, input.name?.trim() || undefined);
}
