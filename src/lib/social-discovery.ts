/**
 * Name-based social handle discovery. The profile resolver only finds a
 * business's socials if its website links them — but many small businesses
 * (esp. ethnic grocers, boba shops) live mostly on social and don't. This finds
 * their Instagram / Facebook / TikTok via web search (Brave API if keyed, else
 * DuckDuckGo), then uses an LLM to INTELLIGENTLY pick the account that belongs
 * to this specific business at this location (guarding against same-name
 * accounts elsewhere). Found handles are scraped by the normal social collectors.
 */

import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export type SocialHost = "instagram.com" | "facebook.com" | "tiktok.com";
interface SearchResult { url: string; title?: string; description?: string; }

/** Brave Search API (BRAVE_API_KEY) — reliable from datacenter IPs (Vercel).
 *  Returns null when unconfigured so we fall back to the keyless DDG scrape. */
async function braveResults(query: string): Promise<SearchResult[] | null> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("https://api.search.brave.com/res/v1/web/search?count=15&q=" + encodeURIComponent(query), {
      headers: { accept: "application/json", "x-subscription-token": key },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data?.web?.results ?? []).map((r: any) => ({ url: r.url, title: r.title, description: r.description })).filter((r: SearchResult) => r.url);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function ddgResults(query: string): Promise<SearchResult[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out: SearchResult[] = [];
    for (const m of html.matchAll(/uddg=([^"&]+)/g)) {
      try { out.push({ url: decodeURIComponent(m[1]) }); } catch { /* skip */ }
    }
    for (const m of html.matchAll(/href="(https?:\/\/[^"]*(?:instagram|facebook|tiktok)\.com[^"]*)"/g)) out.push({ url: m[1] });
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function search(query: string): Promise<SearchResult[]> {
  const brave = await braveResults(query);
  return brave !== null ? brave : await ddgResults(query);
}

const STOP = new Set(["indian", "grocery", "store", "market", "foods", "food", "supermarket", "restaurant", "halal", "cafe", "asian", "the", "and", "llc", "inc", "pakistani", "bakery", "kitchen", "boba", "tea"]);
const nameTokens = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));

// Non-account paths that leak into search results (esp. Instagram's /popular/…,
// /explore/…, /directory/… SEO pages). Anything here is never a real handle.
const GENERIC: Record<SocialHost, string[]> = {
  "instagram.com": ["p", "reel", "reels", "explore", "accounts", "stories", "tv", "popular", "directory", "web", "about", "legal", "privacy", "developer", "topics", "location", "locations", "lite", "help"],
  "facebook.com": ["pages", "groups", "events", "watch", "marketplace", "sharer", "login", "profile.php", "people", "p", "help", "business", "policies", "legal"],
  "tiktok.com": ["tag", "music", "discover", "foryou", "explore", "live", "@", "about", "legal", "business", "search"],
};
// slugs that are obviously not a business account regardless of platform
const NEVER_HANDLE = new Set(["popular", "explore", "directory", "search", "about", "help", "login", "signup", "home", "topics", "trending"]);

/** Extract candidate {handle, url, context} for a host from search results. */
function candidatesFor(results: SearchResult[], host: SocialHost): { handle: string; url: string; context: string }[] {
  const re = new RegExp(host.replace(".", "\\.") + "\\/(@?[A-Za-z0-9._-]+)", "i");
  const out: { handle: string; url: string; context: string }[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const m = re.exec(r.url);
    if (!m) continue;
    const handle = m[1].replace(/^@/, "");
    const lc = handle.toLowerCase();
    if (GENERIC[host].includes(lc) || NEVER_HANDLE.has(lc)) continue;
    if (seen.has(lc)) continue;
    seen.add(handle.toLowerCase());
    out.push({ handle, url: r.url, context: `${r.title ?? ""} ${r.description ?? ""}`.replace(/\s+/g, " ").trim().slice(0, 160) });
  }
  return out;
}

/** Heuristic fallback pick (no LLM): prefer a handle containing the city token,
 *  else one sharing a distinctive name token, else the first candidate. */
function pickHeuristic(cands: { handle: string }[], name: string, cityToken: string): string | undefined {
  if (!cands.length) return undefined;
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cityToken.length >= 3) {
    const cityHit = cands.find((c) => norm(c.handle).includes(cityToken));
    if (cityHit) return cityHit.handle;
  }
  const toks = nameTokens(name);
  const nameHit = cands.find((c) => toks.some((t) => norm(c.handle).includes(t)));
  return (nameHit ?? cands[0]).handle;
}

const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    handle: { type: "string", description: "The exact handle (no @, no URL) that belongs to THIS business at THIS location, or empty string if none of the candidates clearly match." },
    confident: { type: "boolean", description: "true only if you're confident it's the same business (name + location fit)." },
  },
  required: ["handle", "confident"],
};

/** Intelligent pick: let the model choose the account that matches this business
 *  + location from the candidates. Falls back to the heuristic when unavailable. */
async function pickIntelligent(
  cands: { handle: string; url: string; context: string }[],
  name: string,
  city: string,
  platform: string,
  cityToken: string,
): Promise<string | undefined> {
  if (!cands.length) return undefined;
  if (cands.length === 1 && !isLlmConfigured()) return cands[0].handle;
  if (!isLlmConfigured()) return pickHeuristic(cands, name, cityToken);
  try {
    const list = cands.map((c, i) => `${i + 1}. @${c.handle} — ${c.context || "(no description)"}`).join("\n");
    const { data } = await getLlm().callStructured<{ handle: string; confident: boolean }>({
      system: `You verify the official ${platform} account for a SPECIFIC local business location. Many brands and franchises run a SEPARATE account per city/metro (e.g. "@indiabazaraustin" vs "@indiabazardfw", or a page whose bio says "Frisco, TX"). Your job: pick the account for THIS business in THIS city, and REJECT any account whose handle or description points to a DIFFERENT city/metro/region — even when the brand name matches exactly. A same-name account for another metro is WRONG, not a fallback. Only return a handle you're confident is this business at this location (name AND locality must fit). If every candidate belongs to another city, or you can't tell, return an empty handle. Return the exact handle from the list, without '@'.`,
      text: `Business: "${name}"\nCity: ${city || "(unknown)"}\n\nCandidate ${platform} accounts (handle — page name/description):\n${list}`,
      schema: PICK_SCHEMA,
      tier: "classify",
      maxTokens: 120,
    });
    const chosen = String(data.handle ?? "").replace(/^@/, "").trim();
    if (chosen && data.confident && !NEVER_HANDLE.has(chosen.toLowerCase()) && cands.some((c) => c.handle.toLowerCase() === chosen.toLowerCase())) return chosen;
    return undefined; // model not confident → don't attach a wrong account
  } catch {
    return pickHeuristic(cands, name, cityToken);
  }
}

export async function reverseGeoCity(geo?: { lat: number; lng: number }): Promise<string> {
  if (!geo) return "";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=${geo.lat}&lon=${geo.lng}`, {
      headers: { "user-agent": "local-intel-app/0.1", "accept-language": "en" },
      signal: ctrl.signal,
    });
    if (!res.ok) return "";
    const a = ((await res.json()) as any)?.address ?? {};
    return a.city || a.town || a.village || a.suburb || a.municipality || a.county || "";
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

/** Strip branch/location suffixes and parentheticals that derail search. */
function cleanName(name: string): string {
  return name.split(/\s[-–—|]\s/)[0].replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

const WORD: Record<SocialHost, string> = { "instagram.com": "instagram", "facebook.com": "facebook", "tiktok.com": "tiktok" };
const PREFIX: Record<SocialHost, string> = { "instagram.com": "https://www.instagram.com/", "facebook.com": "https://www.facebook.com/", "tiktok.com": "https://www.tiktok.com/@" };

async function findHandle(name: string, city: string, host: SocialHost, state: { searched: boolean }): Promise<string | undefined> {
  const clean = cleanName(name);
  const loc = city ? ` ${city}` : "";
  const cityToken = city.toLowerCase().replace(/[^a-z0-9]/g, "");
  const word = WORD[host];
  const queries = [`${clean}${loc} ${word}`, `${clean} ${word}`];
  if (clean !== name) queries.push(`${name} ${word}`);

  const all: { handle: string; url: string; context: string }[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const results = await search(q);
    if (results.length) state.searched = true;
    for (const c of candidatesFor(results, host)) {
      if (!seen.has(c.handle.toLowerCase())) { seen.add(c.handle.toLowerCase()); all.push(c); }
    }
    if (all.length >= 6) break; // enough to reason over
    await new Promise((r) => setTimeout(r, 350));
  }
  return pickIntelligent(all.slice(0, 8), name, city, word, cityToken);
}

// ── Intelligent delivery store-URL discovery ────────────────────────────────
// Delivery actors are unreliable with search-by-name; the store URL is reliable.
// We already have each business's address, so we search "{name} {city} doordash"
// and let the LLM pick the store page that matches THIS business at THIS location.
const DELIVERY_HOST: Record<string, string> = { doordash: "doordash.com", ubereats: "ubereats.com" };
const DELIVERY_WORD: Record<string, string> = { doordash: "doordash", ubereats: "uber eats" };

function deliveryCandidates(results: SearchResult[], platform: string): { url: string; context: string }[] {
  const host = DELIVERY_HOST[platform];
  const out: { url: string; context: string }[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (!r.url || !r.url.includes(host)) continue;
    const isStore = platform === "doordash" ? /doordash\.com\/store\//i.test(r.url) : /ubereats\.com\/(store\/|[^/]+\/food-delivery\/)/i.test(r.url);
    if (!isStore) continue;
    const clean = r.url.split("?")[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, context: `${r.title ?? ""} ${r.description ?? ""}`.replace(/\s+/g, " ").trim().slice(0, 160) });
  }
  return out;
}

const DURL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", description: "The exact store-page URL from the list that belongs to THIS business at THIS location, or empty string if none clearly match." },
    confident: { type: "boolean", description: "true only if you're confident it's the same business (name + location fit)." },
  },
  required: ["url", "confident"],
};

async function pickDeliveryUrl(cands: { url: string; context: string }[], name: string, city: string, platform: string): Promise<string | undefined> {
  if (!cands.length) return undefined;
  if (!isLlmConfigured()) return cands[0].url;
  try {
    const list = cands.map((c, i) => `${i + 1}. ${c.url} — ${c.context || "(no description)"}`).join("\n");
    const { data } = await getLlm().callStructured<{ url: string; confident: boolean }>({
      system: `You match a local business to its ${platform} store page. Pick the URL that is THIS business at the given city. Only pick one you're confident is the same business (name + location). If none clearly match, return an empty url. Return an exact URL from the list.`,
      text: `Business: "${name}"\nCity: ${city || "(unknown)"}\n\nCandidate ${platform} store pages:\n${list}`,
      schema: DURL_SCHEMA,
      tier: "classify",
      maxTokens: 160,
    });
    const chosen = String(data.url ?? "").trim();
    if (chosen && data.confident && cands.some((c) => c.url === chosen)) return chosen;
    return undefined;
  } catch {
    return cands[0].url;
  }
}

export interface DeliveryWant { doordash?: boolean; ubereats?: boolean }
export interface DeliveryFound { doordash?: string; ubereats?: string; searched: boolean }

/** Discover a business's DoorDash/UberEats store URL from name + city. */
export async function findDeliveryUrls(name: string, city: string, want: DeliveryWant = { doordash: true, ubereats: true }): Promise<DeliveryFound> {
  const out: DeliveryFound = { searched: false };
  const clean = cleanName(name);
  const loc = city ? ` ${city}` : "";
  for (const platform of ["doordash", "ubereats"] as const) {
    if (!want[platform]) continue;
    const word = DELIVERY_WORD[platform];
    const queries = [`${clean}${loc} ${word}`, `${clean} ${word} menu`];
    const all: { url: string; context: string }[] = [];
    const seen = new Set<string>();
    for (const q of queries) {
      const res = await search(q);
      if (res.length) out.searched = true;
      for (const c of deliveryCandidates(res, platform)) {
        if (!seen.has(c.url)) { seen.add(c.url); all.push(c); }
      }
      if (all.length >= 5) break;
      await new Promise((r) => setTimeout(r, 350));
    }
    const u = await pickDeliveryUrl(all.slice(0, 6), name, city, platform);
    if (u) out[platform] = u;
  }
  return out;
}

export interface SocialWant { instagram?: boolean; facebook?: boolean; tiktok?: boolean }
export interface SocialFound { instagram?: string; facebook?: string; tiktok?: string; searched: boolean }

// Platform / aggregator accounts that get mis-attributed as a business's "own"
// handle when its listing lives on a platform site (Clover/DoorDash/Square/etc.) —
// e.g. a Clover-hosted "Kitchen To-Go" listing resolving to @clover.canada. These
// are never a real local business's handle, so reject them outright.
const GENERIC_HANDLES = new Set([
  "clover", "clovercanada", "cloverpos", "cloverapp", "clovercommerce", "getclover",
  "doordash", "doordashcanada", "ubereats", "uber", "ubereatsus", "grubhub", "seamless", "postmates",
  "toast", "toasttab", "toastpos", "square", "squareup", "squarepos", "godaddy",
  "wix", "wixcom", "weebly", "shopify", "yelp", "yelpforbusiness", "tripadvisor",
  "opentable", "linktree", "linktr", "instagram", "facebook", "facebookapp", "meta",
]);
const normHandle = (h: string) => h.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]/g, "");
export function isGenericHandle(h: string): boolean {
  return GENERIC_HANDLES.has(normHandle(h));
}

/** Discover social handles for a business, intelligently matched to its location.
 *  `searched:false` means search returned nothing (likely a transient block) — the
 *  caller should retry later rather than mark the business resolved. */
export async function findSocialHandles(
  name: string,
  city: string,
  want: SocialWant = { instagram: true, facebook: true, tiktok: true },
): Promise<SocialFound> {
  const state = { searched: false };
  const out: SocialFound = { searched: false };
  const hosts: [keyof SocialWant, SocialHost][] = [
    ["instagram", "instagram.com"],
    ["facebook", "facebook.com"],
    ["tiktok", "tiktok.com"],
  ];
  for (const [key, host] of hosts) {
    if (!want[key]) continue;
    const h = await findHandle(name, city, host, state);
    if (h && !isGenericHandle(h)) out[key] = `${PREFIX[host]}${h}`;
  }
  out.searched = state.searched;
  return out;
}
