import type { PublicContentProvider, DiscoverInput, ProfileCandidate } from "./types";
import { WebsiteProvider } from "./website";
import { GoogleProvider } from "./google";
import { ApifyProvider } from "./apify";
import { BrightDataProvider } from "./brightdata";

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
      new ApifyProvider(),
      new BrightDataProvider(),
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

function dedupeCandidates(cands: ProfileCandidate[]): ProfileCandidate[] {
  const byKey = new Map<string, ProfileCandidate>();
  for (const c of cands) {
    const key =
      (c.website && safeHost(c.website)) ||
      `${c.name.toLowerCase().trim()}|${c.platform}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, c);
    else if ((c.prominence ?? 0) > (existing.prominence ?? 0)) byKey.set(key, c);
  }
  return [...byKey.values()];
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
