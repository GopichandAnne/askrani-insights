import { subtypeLabel } from "@/lib/classify";

/**
 * Local market radar — industry trends, local news, and new openings in the
 * region. Uses Bing News RSS (free, no key), which exposes the *real* publisher
 * URL (via the apiclick `url=` param) — unlike Google News's obfuscated
 * redirects — so we can fetch each article and extract its text for deeper trend
 * analysis. Article extraction is best-effort (~half of publishers allow it);
 * the rest keep their headline. Everything here is read-only public data.
 */

export type NewsKind = "trend" | "opening" | "local";
export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  kind: NewsKind;
  excerpt?: string; // extracted article body (best-effort)
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function fetchWithTimeout(url: string, ms: number, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, " ");
}
const pick = (block: string, re: RegExp): string => re.exec(block)?.[1] ?? "";
const hostLabel = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

async function fetchBingNews(query: string, limit = 6): Promise<Omit<NewsItem, "kind" | "excerpt">[]> {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=RSS`;
  let xml: string;
  try {
    const res = await fetchWithTimeout(url, 8000, { headers: { "user-agent": UA } });
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  }
  const out: Omit<NewsItem, "kind" | "excerpt">[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = decodeEntities(pick(block, /<title>([\s\S]*?)<\/title>/)).trim();
    const rawLink = decodeEntities(pick(block, /<link>([\s\S]*?)<\/link>/).trim());
    // Bing wraps the article in an apiclick redirect carrying the real url=…
    const urlParam = /[?&]url=([^&]+)/.exec(rawLink)?.[1];
    const link = urlParam ? decodeURIComponent(urlParam) : rawLink;
    const pub = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/).trim();
    if (!title || !link.startsWith("http") || link.includes("bing.com")) continue;
    let publishedAt: string | undefined;
    if (pub) { const d = new Date(pub); if (!isNaN(d.getTime())) publishedAt = d.toISOString(); }
    out.push({ title, url: link, source: hostLabel(link), publishedAt });
    if (out.length >= limit) break;
  }
  return out;
}

/** Best-effort readable-text extraction from an article URL (pure HTTP, no browser). */
export async function extractArticleText(url: string, maxChars = 2200): Promise<string> {
  let html: string;
  try {
    const res = await fetchWithTimeout(url, 7000, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en" },
      redirect: "follow",
    });
    if (!res.ok) return "";
    html = await res.text();
  } catch {
    return "";
  }
  const region =
    /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ||
    /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ||
    html;
  const text = region
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const clean = decodeEntities(text).replace(/\s+/g, " ").trim();
  return clean.length >= 400 ? clean.slice(0, maxChars) : "";
}

/** US addresses read "street, city, state zip, country" — the city is usually the
 *  3rd-from-last comma part (or the first when there's no street). */
function extractCity(address?: string): string {
  if (!address) return "";
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 3];
  return parts[0] ?? "";
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

/** Collect industry trends + local news + nearby openings, each enriched with
 *  extracted article text where the publisher allows it. */
export async function collectLocalNews(target: {
  vertical: string;
  subtype?: string[];
  address?: string;
}): Promise<NewsItem[]> {
  const city = extractCity(target.address);
  const cuisine = subtypeLabel(target.subtype ?? []);
  const kindWord = target.vertical === "grocery" ? "grocery store" : "restaurant";

  const queries: { kind: NewsKind; q: string }[] = [
    { kind: "trend", q: `${cuisine ? cuisine + " " : ""}${kindWord} industry trends 2026` },
    { kind: "trend", q: `${kindWord} industry trends` },
    { kind: "opening", q: `new ${kindWord} opening ${city}`.trim() },
    { kind: "local", q: `${city} ${kindWord} news`.trim() },
  ];
  if (cuisine && city) queries.push({ kind: "opening", q: `new ${cuisine} ${kindWord} ${city}`.trim() });

  const items: NewsItem[] = [];
  const seen = new Set<string>();
  for (const { kind, q } of queries) {
    if (q.length < 5) continue;
    for (const it of await fetchBingNews(q, 6)) {
      if (!it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      items.push({ ...it, kind });
    }
  }

  // Enrich the top items with article text (trend + opening first — those drive
  // the "deeper trends" answers). Best-effort, bounded, parallel in small batches.
  const priority = [...items].sort((a, b) => rank(a.kind) - rank(b.kind)).slice(0, 12);
  await mapLimit(priority, 4, async (it) => {
    it.excerpt = await extractArticleText(it.url);
  });

  return items.slice(0, 20);
}

const rank = (k: NewsKind) => (k === "trend" ? 0 : k === "opening" ? 1 : 2);
