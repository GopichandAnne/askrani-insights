import { subtypeLabel } from "@/lib/classify";

/**
 * Local market radar — industry trends, local news, and new openings in the
 * region — via Google News RSS (free, no key). Broadens the platform from a
 * business's own channels to what's happening *around* it, so owners hear about
 * a rival opening down the street or a shift in their category.
 */

export type NewsKind = "trend" | "opening" | "local";
export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  kind: NewsKind;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; AskRaniInsights/1.0; +https://insights.askrani.ai)" }, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}
const pick = (block: string, re: RegExp): string => re.exec(block)?.[1] ?? "";

async function fetchGoogleNews(query: string, limit = 6): Promise<Omit<NewsItem, "kind">[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  let xml: string;
  try {
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  }
  const out: Omit<NewsItem, "kind">[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const rawTitle = decode(pick(block, /<title>([\s\S]*?)<\/title>/));
    const link = decode(pick(block, /<link>([\s\S]*?)<\/link>/));
    const pub = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/).trim();
    const source = decode(pick(block, /<source[^>]*>([\s\S]*?)<\/source>/));
    if (!rawTitle || !link) continue;
    // Google News titles end with " - Publisher"; strip for a clean headline.
    const title = source && rawTitle.endsWith(` - ${source}`) ? rawTitle.slice(0, -(source.length + 3)) : rawTitle.replace(/\s+-\s+[^-]+$/, "");
    let publishedAt: string | undefined;
    if (pub) { const d = new Date(pub); if (!isNaN(d.getTime())) publishedAt = d.toISOString(); }
    out.push({ title: title.trim(), url: link, source: source.trim(), publishedAt });
    if (out.length >= limit) break;
  }
  return out;
}

/** US addresses read "street, city, state zip, country" — the city is usually the
 *  3rd-from-last comma part (or the first when there's no street). */
function extractCity(address?: string): string {
  if (!address) return "";
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 3];
  return parts[0] ?? "";
}

/** Collect industry trends + local news + nearby openings for a target business. */
export async function collectLocalNews(target: {
  vertical: string;
  subtype?: string[];
  address?: string;
}): Promise<NewsItem[]> {
  const city = extractCity(target.address);
  const cuisine = subtypeLabel(target.subtype ?? []);
  const kindWord = target.vertical === "grocery" ? "grocery store" : "restaurant";

  const queries: { kind: NewsKind; q: string }[] = [
    { kind: "trend", q: `${cuisine ? cuisine + " " : ""}${kindWord} industry trends` },
    { kind: "opening", q: `new ${kindWord} opening ${city}`.trim() },
    { kind: "local", q: `${city} ${kindWord} news`.trim() },
  ];
  if (cuisine && city) queries.push({ kind: "opening", q: `new ${cuisine} ${kindWord} ${city}`.trim() });

  const out: NewsItem[] = [];
  const seen = new Set<string>();
  for (const { kind, q } of queries) {
    if (q.length < 5) continue;
    for (const it of await fetchGoogleNews(q, 6)) {
      if (!it.url || seen.has(it.url)) continue;
      seen.add(it.url);
      out.push({ ...it, kind });
    }
  }
  return out.slice(0, 18);
}
