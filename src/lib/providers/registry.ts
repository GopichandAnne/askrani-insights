import type { PublicContentProvider, DiscoverInput, ProfileCandidate } from "./types";
import { WebsiteProvider } from "./website";
import { GoogleProvider } from "./google";
import { OsmProvider } from "./osm";
import { YelpProvider } from "./yelp";
import { YouTubeProvider } from "./youtube";
import { ApifyProvider } from "./apify";
import { BrightDataProvider } from "./brightdata";
import { HealthgradesProvider, ZocdocProvider } from "./directory";

/**
 * Provider registry — the single place that knows which adapters exist and
 * which are usable right now (based on env keys). Nothing else in the codebase
 * instantiates a provider directly, so adding a source = adding one adapter and
 * one line here (guide Final Build Principle: "keep every provider replaceable").
 */

let _all: PublicContentProvider[] | null = null;

export function allProviders(): PublicContentProvider[] {
  if (!_all) {
    _all = [
      new WebsiteProvider(),
      new GoogleProvider(),
      new OsmProvider(),
      new YelpProvider(),
      new YouTubeProvider(),
      new ApifyProvider(),
      new BrightDataProvider(),
      new HealthgradesProvider(),
      new ZocdocProvider(),
    ];
  }
  return _all;
}

/** Only adapters with their required keys present. */
export function activeProviders(): PublicContentProvider[] {
  return allProviders().filter((p) => p.isConfigured());
}

export function getProvider(name: string): PublicContentProvider | undefined {
  return allProviders().find((p) => p.name === name);
}

/**
 * Discovery across every configured discovery-capable source, merged and ranked
 * by prominence. Website has no free-text discovery, so this is driven by
 * Google (if keyed); OSM/Nominatim can be added as another adapter later
 * (guide 3.1 fallback). Deduped by website host / name.
 */
export async function discoverCandidates(input: DiscoverInput): Promise<ProfileCandidate[]> {
  const results: ProfileCandidate[] = [];
  for (const p of activeProviders()) {
    try {
      const cands = await p.discoverProfiles(input);
      results.push(...cands);
    } catch {
      // adapters that don't support discovery throw UnsupportedCapability — skip
    }
  }
  return dedupeCandidates(results).sort(
    (a, b) => (b.prominence ?? 0) - (a.prominence ?? 0),
  );
}

/**
 * Cross-provider dedupe. The same business shows up from Google *and* OSM with
 * different shapes (Google carries primaryType/types, OSM carries osm_class), so
 * a naive per-platform key lists it twice. We cluster candidates that are the
 * same business — sharing a website host, or a normalized name at the same place
 * (~1km) — and merge each cluster into one candidate that keeps the *union* of
 * signals (so both Google and OSM tags remain available for vertical detection).
 */
export function dedupeCandidates(cands: ProfileCandidate[]): ProfileCandidate[] {
  const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const geoBucket = (g?: { lat: number; lng: number }) =>
    g ? `${g.lat.toFixed(2)},${g.lng.toFixed(2)}` : undefined; // ~1.1km cell
  const keysFor = (c: ProfileCandidate): string[] => {
    const ks: string[] = [];
    const host = c.website && safeHost(c.website);
    if (host) ks.push(`h:${host}`);
    const n = normName(c.name);
    if (n) {
      const gb = geoBucket(c.geo);
      // name+place is a strong identity; name-only (no geo) as a weak fallback.
      ks.push(gb ? `ng:${n}@${gb}` : `n:${n}`);
    }
    return ks;
  };

  // union-find over candidate indices
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const keyToIdx = new Map<string, number>();
  cands.forEach((c, i) => {
    for (const k of keysFor(c)) {
      const seen = keyToIdx.get(k);
      if (seen != null) union(i, seen);
      else keyToIdx.set(k, i);
    }
  });

  const groups = new Map<number, ProfileCandidate[]>();
  cands.forEach((c, i) => {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(c);
    groups.set(r, g);
  });

  const mergeInto = (base: ProfileCandidate, extra: ProfileCandidate): ProfileCandidate => ({
    ...base,
    website: base.website ?? extra.website,
    geo: base.geo ?? extra.geo,
    category: base.category ?? extra.category,
    distanceKm: base.distanceKm ?? extra.distanceKm,
    prominence: Math.max(base.prominence ?? 0, extra.prominence ?? 0),
    confidence: Math.max(base.confidence ?? 0, extra.confidence ?? 0),
    // union of raw signals; base wins on overlapping keys, but OSM's osm_class and
    // Google's primaryType/types are disjoint so both survive for detection.
    raw: { ...((extra.raw as any) ?? {}), ...((base.raw as any) ?? {}) },
  });

  return [...groups.values()].map((g) => {
    const [first, ...rest] = [...g].sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0));
    return rest.reduce(mergeInto, first);
  });
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Health of every adapter — powers the Admin "provider health" screen (12.1). */
export async function providerHealth() {
  return Promise.all(allProviders().map((p) => p.healthCheck()));
}
