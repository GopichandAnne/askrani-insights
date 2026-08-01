/**
 * Name-based social handle discovery. The profile resolver only finds a
 * business's Instagram/Facebook if its website links them — but many small
 * businesses (esp. ethnic grocers) live mostly on social and don't. This finds
 * their handles via a web search (DuckDuckGo HTML, free), guarded by a name
 * match so we never attach the wrong account. Found handles are then scraped by
 * the normal social collectors.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/**
 * Brave Search API (BRAVE_API_KEY) — the reliable path: works from datacenter
 * IPs (Vercel) where scraping DuckDuckGo gets blocked. Free tier is generous.
 * Returns null when unconfigured so we fall back to the keyless DDG scrape.
 */
async function braveUrls(query: string): Promise<string[] | null> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("https://api.search.brave.com/res/v1/web/search?count=12&q=" + encodeURIComponent(query), {
      headers: { accept: "application/json", "x-subscription-token": key },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data?.web?.results ?? []).map((r: any) => r.url).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** Search for result URLs: Brave API if keyed (reliable), else DuckDuckGo scrape. */
async function searchUrls(query: string): Promise<string[]> {
  const brave = await braveUrls(query);
  return brave !== null ? brave : await ddgUrls(query);
}

async function ddgUrls(query: string): Promise<string[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    const urls: string[] = [];
    for (const m of html.matchAll(/uddg=([^"&]+)/g)) {
      try { urls.push(decodeURIComponent(m[1])); } catch { /* skip */ }
    }
    for (const m of html.matchAll(/href="(https?:\/\/[^"]*(?:instagram|facebook)\.com[^"]*)"/g)) urls.push(m[1]);
    return urls;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

const nameTokens = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !["indian", "grocery", "store", "market", "foods", "supermarket", "restaurant", "halal", "cafe"].includes(t));

/** The handle must share a distinctive token with the business name (guards
 *  against attaching an unrelated account). */
function handleMatchesName(handle: string, name: string): boolean {
  const h = handle.toLowerCase().replace(/[^a-z0-9]/g, "");
  const toks = nameTokens(name);
  if (!toks.length) return h.length > 0; // generic name → accept first result
  return toks.some((t) => h.includes(t));
}

function pickHandle(urls: string[], host: "instagram.com" | "facebook.com", generic: string[]): string | undefined {
  const re = new RegExp(host.replace(".", "\\.") + "\\/([A-Za-z0-9._-]+)");
  for (const u of urls) {
    const m = re.exec(u);
    if (m && !generic.includes(m[1].toLowerCase())) return m[1];
  }
  return undefined;
}

/** Strip branch/location suffixes and parentheticals that derail search, e.g.
 *  "India Bazaar Austin - Cedar Park" → "India Bazaar Austin". */
function cleanName(name: string): string {
  return name
    .split(/\s[-–—|]\s/)[0] // drop "… - Cedar Park", "… | Downtown"
    .replace(/\([^)]*\)/g, "") // drop "(Durga Bhavani World Foods)"
    .replace(/\s+/g, " ")
    .trim();
}

const IG_GENERIC = ["p", "reel", "reels", "explore", "accounts", "stories", "tv"];
const FB_GENERIC = ["pages", "groups", "events", "watch", "marketplace", "sharer", "login", "profile.php", "people"];

async function findHandle(
  name: string,
  city: string,
  host: "instagram.com" | "facebook.com",
  generic: string[],
  state: { searched: boolean },
): Promise<string | undefined> {
  const clean = cleanName(name);
  const loc = city ? ` ${city}` : "";
  const word = host === "instagram.com" ? "instagram" : "facebook";
  // try the cleaned name (with + without location), then the raw name — stop at
  // the first result that plausibly matches the business name.
  const queries = [`${clean}${loc} ${word}`, `${clean} ${word}`];
  if (clean !== name) queries.push(`${name} ${word}`);
  const seen = new Set<string>();
  for (const q of queries) {
    if (seen.has(q)) continue;
    seen.add(q);
    const urls = await searchUrls(q);
    if (urls.length) state.searched = true; // search engine actually responded
    const h = pickHandle(urls, host, generic);
    if (h && handleMatchesName(h, name)) return h;
    await new Promise((r) => setTimeout(r, 400)); // be gentle with DDG
  }
  return undefined;
}

/** Returns discovered handles plus `searched`: false means the search engine
 *  returned nothing at all (likely a transient block) — caller should retry
 *  later rather than mark the business as resolved. */
export async function findSocialHandles(
  name: string,
  city: string,
  want: { instagram?: boolean; facebook?: boolean } = { instagram: true, facebook: true },
): Promise<{ instagram?: string; facebook?: string; searched: boolean }> {
  const state = { searched: false };
  const out: { instagram?: string; facebook?: string; searched: boolean } = { searched: false };
  if (want.instagram) {
    const h = await findHandle(name, city, "instagram.com", IG_GENERIC, state);
    if (h) out.instagram = `https://www.instagram.com/${h}`;
  }
  if (want.facebook) {
    const h = await findHandle(name, city, "facebook.com", FB_GENERIC, state);
    if (h) out.facebook = `https://www.facebook.com/${h}`;
  }
  out.searched = state.searched;
  return out;
}
