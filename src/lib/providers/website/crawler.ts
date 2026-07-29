import { createHash } from "node:crypto";
import type { RawObservation, MediaRef } from "../types";
import {
  extractJsonLd,
  extractReadableText,
  extractDocumentLinks,
  type JsonLdFacts,
} from "./jsonld";

/**
 * Website crawler — guide 5.4 strategy. The most controllable competitive
 * source. Static-first: robots → sitemap → conditional GET → content hash →
 * JSON-LD → semantic text → linked PDFs/images. Playwright rendering is the
 * documented fallback (5.4 step 5) and is intentionally NOT pulled in here so
 * the pilot stays dependency-light; the hook is marked below.
 */

export interface CrawlCacheEntry {
  etag?: string;
  lastModified?: string;
  contentHash?: string;
}

export interface CrawlOptions {
  maxPages?: number; // crawl budget (guide 5.4 step 7)
  timeoutMs?: number;
  userAgent?: string;
  // conditional-GET cache keyed by URL, persisted by the caller across runs
  cache?: Map<string, CrawlCacheEntry>;
  // honor robots disallow (default true)
  respectRobots?: boolean;
  // menu/flyer keywords worth prioritizing in the frontier
  priorityHints?: string[];
}

export interface CrawlResult {
  observations: RawObservation[];
  pagesFetched: number;
  pagesSkippedUnchanged: number;
  robotsPolicy: "allowed" | "partial" | "unknown";
  errors: string[];
}

const DEFAULT_UA =
  "local-intel-bot/0.1 (+https://example.com/bot; respects robots.txt)";

const PRIORITY = ["menu", "specials", "offers", "deals", "events", "catering", "lunch"];

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

// Asset extensions that are never HTML pages. Linked PDFs/images are captured
// separately as media (extractDocumentLinks); everything here is crawl noise.
const NON_HTML = /\.(css|js|mjs|json|xml|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|eot|mp4|webm|mp3|zip|pdf)(\?|#|$)/i;

function isCrawlableHtml(url: string): boolean {
  try {
    const u = new URL(url);
    if (NON_HTML.test(u.pathname)) return false;
    // skip Next.js/webpack build assets and common non-content paths
    if (/\/_next\/|\/static\/|\/assets\//.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Minimal robots.txt disallow check for our user-agent / '*'. */
function parseRobots(txt: string): { disallows: string[] } {
  const lines = txt.split(/\r?\n/);
  const disallows: string[] = [];
  let active = false;
  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (key === "user-agent") active = val === "*" || val.includes("local-intel");
    else if (key === "disallow" && active && val) disallows.push(val);
  }
  return { disallows };
}

function isDisallowed(url: string, disallows: string[]): boolean {
  try {
    const path = new URL(url).pathname;
    return disallows.some((d) => d !== "/" ? path.startsWith(d) : path === "/");
  } catch {
    return false;
  }
}

async function fetchText(
  url: string,
  opts: CrawlOptions,
): Promise<{ status: number; body?: string; etag?: string; lastModified?: string }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  try {
    const prev = opts.cache?.get(url);
    const headers: Record<string, string> = { "user-agent": opts.userAgent ?? DEFAULT_UA };
    if (prev?.etag) headers["if-none-match"] = prev.etag;
    if (prev?.lastModified) headers["if-modified-since"] = prev.lastModified;
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    if (res.status === 304) return { status: 304 };
    const body = await res.text();
    return {
      status: res.status,
      body,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
    };
  } finally {
    clearTimeout(to);
  }
}

function jsonLdToMedia(links: string[]): MediaRef[] {
  return links.map((url) => ({
    type: /\.pdf(\?|#|$)/i.test(url) ? ("pdf" as const) : ("image" as const),
    url,
  }));
}

function structuredHints(facts: JsonLdFacts): Record<string, unknown> | undefined {
  const has =
    facts.menuItems.length || facts.offers.length || facts.events.length || facts.businessName;
  if (!has) return undefined;
  return {
    jsonld: {
      businessName: facts.businessName,
      cuisines: facts.cuisines,
      priceRange: facts.priceRange,
      openingHours: facts.openingHours,
      menuItems: facts.menuItems,
      offers: facts.offers,
      events: facts.events,
    },
  };
}

/**
 * Crawl a business website and return normalized observations.
 * Pure with respect to I/O boundaries (fetch is the only side effect) so it can
 * be unit-tested against fixtures — guide 14.2 "contract tests using fixtures".
 */
export async function crawlWebsite(
  rootUrl: string,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 25;
  const cache = opts.cache;
  const respectRobots = opts.respectRobots ?? true;
  const result: CrawlResult = {
    observations: [],
    pagesFetched: 0,
    pagesSkippedUnchanged: 0,
    robotsPolicy: "unknown",
    errors: [],
  };

  let root: URL;
  try {
    root = new URL(rootUrl);
  } catch {
    result.errors.push(`invalid root url: ${rootUrl}`);
    return result;
  }

  // 1) robots.txt (guide 5.4 step 1)
  let disallows: string[] = [];
  if (respectRobots) {
    try {
      const r = await fetchText(`${root.origin}/robots.txt`, opts);
      if (r.status === 200 && r.body) {
        disallows = parseRobots(r.body).disallows;
        result.robotsPolicy = disallows.length ? "partial" : "allowed";
      } else {
        result.robotsPolicy = "allowed";
      }
    } catch {
      result.robotsPolicy = "unknown";
    }
  }

  // 2) sitemap seeds (guide 5.4 step 1)
  const frontier: string[] = [root.toString()];
  const seen = new Set<string>();
  try {
    const sm = await fetchText(`${root.origin}/sitemap.xml`, opts);
    if (sm.status === 200 && sm.body) {
      const locs = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
      for (const loc of locs) if (sameHost(loc, root.origin)) frontier.push(loc);
    }
  } catch {
    /* no sitemap is fine */
  }

  // prioritize menu/specials-looking URLs in the frontier
  const priority = [...PRIORITY, ...(opts.priorityHints ?? [])];
  frontier.sort((a, b) => {
    const pa = priority.some((k) => a.toLowerCase().includes(k)) ? 0 : 1;
    const pb = priority.some((k) => b.toLowerCase().includes(k)) ? 0 : 1;
    return pa - pb;
  });

  const now = new Date().toISOString();

  while (frontier.length && result.pagesFetched < maxPages) {
    const url = frontier.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!sameHost(url, root.origin)) continue;
    if (!isCrawlableHtml(url)) continue;
    if (respectRobots && isDisallowed(url, disallows)) continue;

    let fetched;
    try {
      fetched = await fetchText(url, opts);
    } catch (e) {
      result.errors.push(`fetch failed ${url}: ${(e as Error).message}`);
      continue;
    }

    if (fetched.status === 304) {
      result.pagesSkippedUnchanged++;
      continue;
    }
    if (fetched.status !== 200 || !fetched.body) continue;

    const html = fetched.body;
    const contentHash = sha256(html);

    // content-hash change detection (guide 5.4 step 6): skip unchanged pages
    const prev = cache?.get(url);
    if (prev?.contentHash === contentHash) {
      result.pagesSkippedUnchanged++;
      cache?.set(url, { ...prev, etag: fetched.etag, lastModified: fetched.lastModified });
      continue;
    }
    cache?.set(url, {
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      contentHash,
    });
    result.pagesFetched++;

    const facts = extractJsonLd(html);
    const text = extractReadableText(html);
    const docLinks = extractDocumentLinks(html, url);

    const isMenuLike =
      facts.menuItems.length > 0 || /menu|specials|offers|deals/i.test(url);

    result.observations.push({
      provider: "website",
      provenance: "PUBLIC_WEBSITE_HTTP",
      platform: "website",
      contentKind: isMenuLike ? "menu" : "page",
      externalRef: url,
      sourceUrl: url,
      businessHint: {
        name: facts.businessName,
        website: root.origin,
      },
      text,
      media: jsonLdToMedia(docLinks),
      observedAt: now,
      contentHash,
      raw: { url, htmlLength: html.length },
      structuredHints: structuredHints(facts),
    });

    // enqueue same-host links (bounded by crawl budget)
    if (result.pagesFetched < maxPages) {
      for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
        try {
          const abs = new URL(m[1], url).toString().split("#")[0];
          if (sameHost(abs, root.origin) && !seen.has(abs) && isCrawlableHtml(abs))
            frontier.push(abs);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // NOTE (guide 5.4 step 5): when a page yields no meaningful text/JSON-LD but
  // clearly relies on JS, route it to a Playwright rendering fallback here and
  // tag observations PUBLIC_WEBSITE_BROWSER. Deferred for the static-first pilot.

  return result;
}
