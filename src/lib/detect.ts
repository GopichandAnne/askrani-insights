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
  placeId?: string;
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
          "id,displayName,formattedAddress,location,rating,userRatingCount,websiteUri,nationalPhoneNumber,internationalPhoneNumber,primaryType,types,regularOpeningHours.weekdayDescriptions,editorialSummary",
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
    summary: { type: "string", description: "1–2 plain sentences: what the company does and who it serves. Grounded ONLY in the page text." },
    offerings: { type: "array", items: { type: "string" }, maxItems: 6, description: "The main products, services, or capabilities named on the page (up to 6 short phrases). [] if unclear." },
  },
  required: ["name", "category", "summary", "offerings"],
};

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

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

  try {
    const system =
      "You read a company's homepage and summarize the business for an assistant that will answer prospects' questions about it. Be specific and grounded ONLY in the text provided — never invent products, claims, or numbers.";
    const input = `WEBSITE: ${url}\nPAGE TITLE: ${title}\nMETA DESCRIPTION: ${description}\n\nHOMEPAGE TEXT:\n${text}`;
    const { data } = await getLlm().callStructured<{ name: string; category: string; summary: string; offerings: string[] }>({
      system,
      text: input,
      schema: ONLINE_SCHEMA,
      tier: "classify",
      maxTokens: 500,
    });
    const offerings = (Array.isArray(data.offerings) ? data.offerings : []).map(clean).filter(Boolean).slice(0, 6);
    const detected: DetectedBusiness = {
      name: clean(data.name) || title.split(/[|\-–—·:]/)[0].trim() || host,
      website: url,
      category: clean(data.category) || "online business",
      summary: clean(data.summary) || description || undefined,
      offerings: offerings.length ? offerings : undefined,
    };
    return { detected, source: "website" };
  } catch {
    const name = title.split(/[|\-–—·:]/)[0].trim() || host;
    return { detected: { name, website: url, category: "online business", summary: description || undefined }, source: "website" };
  }
}

export async function detectBusiness(input: { kind: DetectKind; query: string; name?: string }): Promise<DetectResult> {
  const query = (input.query ?? "").trim();
  if (!query) return { detected: null, source: "none" };
  return input.kind === "online" ? detectOnline(query) : detectLocal(query, input.name?.trim() || undefined);
}
