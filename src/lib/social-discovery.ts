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
import { apifyConfigured, collectProfileIdentity, type ProfileIdentity } from "@/lib/providers/apify/platforms";

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
    // Platform script/SEO paths (story.php, profile.php, sharer.php, …) match the
    // handle regex but are never a real account — reject anything ending in .php.
    if (/\.php$/i.test(lc)) continue;
    if (seen.has(lc)) continue;
    seen.add(handle.toLowerCase());
    out.push({ handle, url: r.url, context: `${r.title ?? ""} ${r.description ?? ""}`.replace(/\s+/g, " ").trim().slice(0, 160) });
  }
  return out;
}

/** Heuristic fallback pick (no LLM / LLM errored): require a REAL match — the
 *  handle must contain a distinctive token of the business name. Prefer one that
 *  also matches the city. NEVER returns "the first search result": attaching an
 *  unrelated same-name/aggregator account is worse than attaching nothing (the
 *  owner can add it in the confirm step). Returns undefined when nothing matches. */
function pickHeuristic(cands: { handle: string }[], name: string, cityToken: string): string | undefined {
  if (!cands.length) return undefined;
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
  const toks = nameTokens(name);
  const nameHits = cands.filter((c) => toks.some((t) => norm(c.handle).includes(t)));
  if (!nameHits.length) return undefined; // no confident name match → attach nothing
  if (cityToken.length >= 3) {
    const cityHit = nameHits.find((c) => norm(c.handle).includes(cityToken));
    if (cityHit) return cityHit.handle;
  }
  return nameHits[0].handle;
}

const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    handle: { type: "string", description: "The single best handle (no @, no URL) that belongs to THIS business at THIS location, or empty string if none of the candidates clearly match." },
    confident: { type: "boolean", description: "true only if you're confident it's the same business (name + location fit)." },
    plausible: {
      type: "array",
      items: { type: "string" },
      description: "Every candidate handle (no @) that could belong to THIS SAME business at THIS location — INCLUDE the old/abandoned duplicate accounts of the same business here (a stale account will be filtered out later by which one still posts). EXCLUDE any account for a DIFFERENT city/metro or a DIFFERENT business. Usually 1; give 2+ only when the same business genuinely has multiple accounts.",
    },
  },
  required: ["handle", "confident", "plausible"],
};

/** What the picker returns: the single best guess (when confident) plus every
 *  handle that plausibly belongs to THIS same business at THIS location. When 2+
 *  are plausible, the caller breaks the tie by recency (which account still posts). */
interface Pick { chosen?: string; plausible: string[]; }

/** Intelligent pick: let the model choose the account that matches this business
 *  + location, AND surface every account that plausibly belongs to this SAME
 *  business here (old + current duplicates) so the caller can break the tie by
 *  recency. Falls back to the heuristic when the LLM is unavailable. */
async function pickIntelligent(
  cands: { handle: string; url: string; context: string }[],
  name: string,
  city: string,
  platform: string,
  cityToken: string,
): Promise<Pick> {
  if (!cands.length) return { plausible: [] };
  // No lone-candidate shortcut: even a single result must pass the name check in
  // pickHeuristic, so a same-name account for a different business isn't attached.
  if (!isLlmConfigured()) { const h = pickHeuristic(cands, name, cityToken); return { chosen: h, plausible: heuristicPlausible(cands, name) }; }
  try {
    const list = cands.map((c, i) => `${i + 1}. @${c.handle} — ${c.context || "(no description)"}`).join("\n");
    const { data } = await getLlm().callStructured<{ handle: string; confident: boolean; plausible?: string[] }>({
      system: `You verify the official ${platform} account for a SPECIFIC local business location, the way a careful human would — not by matching the name, but by checking it's THIS business at THIS place and it's the CURRENT account.\n` +
        `RULES:\n` +
        `1) Location: many brands run a separate account per city/metro (e.g. "@indiabazaraustin" vs "@indiabazardfw", or a bio saying "Frisco, TX"). REJECT any account whose handle or description points to a DIFFERENT city/metro — a same-name account for another metro is WRONG, not a fallback.\n` +
        `2) Multiple accounts of the SAME business: a business often has an OLD/abandoned account and a CURRENT one. List ALL of them in "plausible" (they'll be disambiguated by which one still posts). For "handle", give your single best guess for the current primary account; do NOT just pick the one with the most posts — an old account can have more posts than the live one.\n` +
        `3) Don't guess a single answer when unsure: if two accounts of the same business both fit this location and you can't tell which is current from the descriptions, still list BOTH in "plausible" but set confident=false (a recency check or a human will settle it). Attaching a stale or wrong account is worse than attaching none.\n` +
        `Return exact handles from the list (no '@').`,
      text: `Business: "${name}"\nCity: ${city || "(unknown)"}\n\nCandidate ${platform} accounts (handle — page name/description):\n${list}`,
      schema: PICK_SCHEMA,
      tier: "classify",
      maxTokens: 160,
    });
    const valid = (h: unknown) => { const s = String(h ?? "").replace(/^@/, "").trim(); return s && !NEVER_HANDLE.has(s.toLowerCase()) && cands.some((c) => c.handle.toLowerCase() === s.toLowerCase()) ? s : undefined; };
    const plausible = [...new Set((data.plausible ?? []).map(valid).filter((s): s is string => !!s))];
    const best = valid(data.handle);
    if (best && !plausible.some((p) => p.toLowerCase() === best.toLowerCase())) plausible.unshift(best);
    // chosen = the confident single pick; when not confident we leave it undefined
    // and let the caller decide (recency among `plausible`, else attach nothing).
    return { chosen: best && data.confident ? best : undefined, plausible };
  } catch {
    const h = pickHeuristic(cands, name, cityToken);
    return { chosen: h, plausible: heuristicPlausible(cands, name) };
  }
}

/** Name-matching candidates, for the recency tie-break when the LLM is unavailable.
 *  Same "must contain a distinctive name token" bar as pickHeuristic (never the
 *  whole result list), so recency only ever chooses among real same-name accounts. */
function heuristicPlausible(cands: { handle: string }[], name: string): string[] {
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
  const toks = nameTokens(name);
  return cands.filter((c) => toks.some((t) => norm(c.handle).includes(t))).map((c) => c.handle);
}

/** Does this scraped profile PROVE it belongs to this business? The gold signal is
 *  the profile linking the business's own website; naming its street address (+city)
 *  is just as strong; name + city together is acceptable. Name ALONE is NOT enough —
 *  that's exactly what let unrelated same-name accounts through. Returns a strength
 *  (3 = website/address proof, 2 = name+city) so the caller can rank multiple proven
 *  accounts, or 0 when unproven. */
function identityMatch(id: ProfileIdentity, name: string, ctx: VerifyCtx): number {
  const flat = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const dom = domainOf(ctx.website);
  const hay = flat(`${id.bio ?? ""} ${id.name ?? ""} ${id.handle ?? ""}`);
  const extDom = domainOf(id.externalUrl);
  const domainMatch = !!dom && (extDom === dom || (dom.length >= 6 && hay.includes(flat(dom))));
  const cityTok = flat(ctx.city);
  const cityHit = cityTok.length >= 3 && hay.includes(cityTok);
  const nameHit = nameTokens(name).some((t) => hay.includes(t));
  const streetNo = (ctx.address ?? "").match(/\b\d{3,6}\b/)?.[0];
  const addrHit = !!streetNo && cityHit && hay.includes(streetNo);
  if (domainMatch || addrHit) return 3; // proven THIS business
  if (nameHit && cityHit) return 2;      // name + city — acceptable
  return 0;                              // unproven → never attach
}

/** Confirm candidate accounts via Apify (the only channel that can actually load
 *  the profile) and return the best PROVEN one. Scrapes each candidate's profile in
 *  parallel (identity + recency in one call), keeps only those the profile proves
 *  belong to this business, then ranks by proof strength → recency → verified →
 *  followers. Returns undefined when NONE prove out — the caller then attaches
 *  nothing (a blank the human fills), never a guessed account. */
async function confirmProfiles(platform: string, host: SocialHost, handles: string[], name: string, ctx: VerifyCtx): Promise<string | undefined> {
  if (!handles.length) return undefined;
  const scored = await Promise.all(handles.map(async (h) => {
    const id = await collectProfileIdentity(platform, `${PREFIX[host]}${h}`, { maxMs: 40000 }).catch(() => undefined);
    if (!id) return undefined;
    const strength = identityMatch(id, name, ctx);
    return strength ? { h, strength, at: id.latestPostAt ?? 0, followers: id.followers ?? 0, verified: id.verified ? 1 : 0 } : undefined;
  }));
  const ok = scored.filter((x): x is NonNullable<typeof x> => !!x);
  if (!ok.length) return undefined;
  ok.sort((a, b) => b.strength - a.strength || b.at - a.at || b.verified - a.verified || b.followers - a.followers);
  return ok[0].h;
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

export type HandleConfidence = "high" | "medium";
/** Context used to VERIFY a candidate actually belongs to this business. */
export interface VerifyCtx { website?: string; city?: string; address?: string; phone?: string }

function domainOf(website?: string): string {
  if (!website) return "";
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return website.replace(/^https?:\/\//i, "").replace(/^www\./, "").split(/[/?#]/)[0].toLowerCase();
  }
}

/** Human-style verification: fetch the candidate profile and check it actually
 *  belongs to THIS business. A link back to the business's own website is
 *  definitive ("high"); the city or a distinctive name token in the page is
 *  corroborating. Best-effort — a blocked/empty fetch yields no signal (we do NOT
 *  treat that as disproof; the LLM geo-judge already gated the pick). */
async function verifyProfile(url: string, name: string, ctx: VerifyCtx): Promise<{ backlink: boolean; geoOrName: boolean; strong: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, signal: ctrl.signal });
    if (!res.ok) return { backlink: false, geoOrName: false, strong: false };
    const html = (await res.text()).toLowerCase();
    const flat = html.replace(/[^a-z0-9]/g, "");
    const dom = domainOf(ctx.website);
    const backlink = !!dom && html.includes(dom);
    const cityTok = (ctx.city ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const hasCity = cityTok.length >= 3 && flat.includes(cityTok);
    const hasName = nameTokens(name).some((tk) => flat.includes(tk));
    // Branch-identity evidence (P2): the store's street number (with the city, to
    // avoid a stray-number coincidence) or its phone's last 7 digits appearing in the
    // profile is very strong proof this account is THIS branch — as good as a backlink.
    const streetNo = (ctx.address ?? "").match(/\b\d{3,6}\b/)?.[0];
    const hasAddr = !!streetNo && hasCity && flat.includes(streetNo);
    const phone7 = (ctx.phone ?? "").replace(/\D/g, "").slice(-7);
    const hasPhone = phone7.length >= 7 && flat.includes(phone7);
    return { backlink, geoOrName: hasCity || hasName, strong: hasAddr || hasPhone };
  } catch {
    return { backlink: false, geoOrName: false, strong: false };
  } finally {
    clearTimeout(t);
  }
}

async function findHandle(name: string, city: string, host: SocialHost, state: { searched: boolean }, ctx: VerifyCtx): Promise<{ handle: string; confidence: HandleConfidence } | undefined> {
  const clean = cleanName(name);
  const loc = city ? ` ${city}` : "";
  const cityToken = city.toLowerCase().replace(/[^a-z0-9]/g, "");
  const word = WORD[host];
  // Search by name+city AND by the street address — a profile that names its address
  // is strong proof it's this branch, and address search surfaces location accounts a
  // bare name search misses.
  const queries = [`${clean}${loc} ${word}`, `${clean} ${word}`];
  if (ctx.address) queries.splice(1, 0, `${clean} ${ctx.address} ${word}`);
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
  const pick = await pickIntelligent(all.slice(0, 8), name, city, word, cityToken);

  // PROD path (Instagram): CONFIRM via Apify, then prefer the active account.
  // A plain fetch to instagram.com is blocked from datacenter IPs (Vercel), so the
  // old web-verify was inert and the raw LLM guess leaked through — which is how
  // unrelated accounts got attached. Apify can actually load the profile, so we
  // scrape each name-matching candidate, keep only the ones the profile PROVES are
  // this business (links our website, or names our address/city), and among those
  // prefer the currently-active one (@manpasand_atx over stale @manpasandaustin).
  // If NONE prove out, we attach nothing — a blank the human fills, never a guess.
  if (host === "instagram.com" && apifyConfigured()) {
    const pool = [...new Set([pick.chosen, ...pick.plausible, ...heuristicPlausible(all, name)].filter((h): h is string => !!h))].slice(0, 3);
    const confirmed = await confirmProfiles("instagram", host, pool, name, ctx);
    return confirmed ? { handle: confirmed, confidence: "high" } : undefined;
  }

  // Non-Apify path (local/dev; and Facebook/TikTok): the LLM pick + best-effort web
  // verify. Returns nothing rather than a guess when the model isn't confident.
  const chosen = pick.chosen;
  if (!chosen) return undefined;
  const v = await verifyProfile(`${PREFIX[host]}${chosen}`, name, ctx);
  return { handle: chosen, confidence: v.backlink || v.strong ? "high" : "medium" };
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

/** Fallback delivery pick: require a distinctive name token in the store URL/slug
 *  (e.g. "/store/desi-circle-…"), never blindly the first result. */
function pickDeliveryHeuristic(cands: { url: string; context: string }[], name: string): string | undefined {
  const toks = nameTokens(name);
  if (!toks.length) return undefined;
  const hit = cands.find((c) => { const u = c.url.toLowerCase().replace(/[^a-z0-9]/g, ""); return toks.some((t) => u.includes(t)); });
  return hit?.url;
}

async function pickDeliveryUrl(cands: { url: string; context: string }[], name: string, city: string, platform: string): Promise<string | undefined> {
  if (!cands.length) return undefined;
  if (!isLlmConfigured()) return pickDeliveryHeuristic(cands, name);
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
    return pickDeliveryHeuristic(cands, name);
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

// ── healthcare directory URL discovery (Zocdoc / Healthgrades) ───────────────
// When a practice's site doesn't link its directory profile, find it by name+city
// via web search — the profile URL embeds the practice name (…/practice/austin-3d-
// dental-…), so we match on name-token overlap in the slug (no "first result").
export interface DirectoryWant { healthgrades?: boolean; zocdoc?: boolean }
export interface DirectoryFound { healthgrades?: string; zocdoc?: string; searched: boolean }
const DIR_HOST: Record<string, RegExp> = {
  zocdoc: /(^|\/\/)(www\.)?zocdoc\.com\/(practice|dentist|doctor|provider)\//i,
  healthgrades: /(^|\/\/)(www\.)?healthgrades\.com\/(dentist|physician|providers)\//i,
};
function directoryCandidates(results: SearchResult[], platform: "zocdoc" | "healthgrades"): string[] {
  const re = DIR_HOST[platform]; const out: string[] = []; const seen = new Set<string>();
  for (const r of results) {
    const u = String(r.url ?? "");
    if (re.test(u)) { const c = u.split("#")[0].split("?")[0]; if (!seen.has(c)) { seen.add(c); out.push(c); } }
  }
  return out;
}
export async function findDirectoryUrls(name: string, city: string, want: DirectoryWant = { healthgrades: true, zocdoc: true }): Promise<DirectoryFound> {
  const out: DirectoryFound = { searched: false };
  const clean = cleanName(name); const loc = city ? ` ${city}` : "";
  const nameToks = new Set(nameTokens(name));
  const plans: [("zocdoc" | "healthgrades"), string][] = [];
  if (want.zocdoc) plans.push(["zocdoc", "zocdoc dentist"]);
  if (want.healthgrades) plans.push(["healthgrades", "healthgrades dentist"]);
  for (const [platform, word] of plans) {
    const queries = [`site:${platform}.com ${clean}${loc}`, `${clean}${loc} ${word}`];
    const cands: string[] = []; const seen = new Set<string>();
    for (const q of queries) {
      const res = await search(q);
      if (res.length) out.searched = true;
      for (const u of directoryCandidates(res, platform)) if (!seen.has(u)) { seen.add(u); cands.push(u); }
      if (cands.length >= 6) break;
      await new Promise((r) => setTimeout(r, 350));
    }
    // pick the candidate whose slug best matches the practice name (require ≥1 token)
    let best: string | undefined; let bestScore = 0;
    for (const u of cands) {
      const slug = u.toLowerCase();
      let score = 0; for (const t of nameToks) if (slug.includes(t)) score++;
      if (score > bestScore) { bestScore = score; best = u; }
    }
    if (best && bestScore >= 1) out[platform] = best;
  }
  return out;
}

export interface SocialWant { instagram?: boolean; facebook?: boolean; tiktok?: boolean }
export interface SocialFound {
  instagram?: string; facebook?: string; tiktok?: string; searched: boolean;
  // per-platform verification confidence: "high" = profile links back to the
  // business site; "medium" = name+geo match only (surface for owner to confirm).
  confidence?: Partial<Record<"instagram" | "facebook" | "tiktok", HandleConfidence>>;
}

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
  ctx: VerifyCtx = {},
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
    const r = await findHandle(name, city, host, state, { website: ctx.website, city, address: ctx.address, phone: ctx.phone });
    if (r && !isGenericHandle(r.handle)) {
      out[key] = `${PREFIX[host]}${r.handle}`;
      (out.confidence ??= {})[key] = r.confidence;
    }
  }
  out.searched = state.searched;
  return out;
}
