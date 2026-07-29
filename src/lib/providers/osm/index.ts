import {
  PublicContentProvider,
  DiscoverInput,
  ProfileBatch,
  ContentBatch,
  ProviderJob,
  ProviderJobStatus,
  ProviderHealth,
  ProviderRequest,
  CostEstimate,
  ProfileCandidate,
  RawObservation,
  UnsupportedCapability,
} from "../types";

/**
 * OpenStreetMap discovery adapter — the guide's free fallback for business/place
 * discovery (§3.1: "OpenStreetMap/Nominatim plus websites"). No API key, no
 * billing. Two modes:
 *   • text search (find your business)  → Nominatim
 *   • nearby same-category (competitors) → Overpass
 *
 * OSM coverage/websites are patchier than Google Places; Google is the quality
 * upgrade (adds reviews & photos). Both sit behind the same interface, so the
 * app doesn't care which answered.
 *
 * Respects Nominatim usage policy: identifying User-Agent, low volume, and we
 * never hammer it (one call per user action).
 */

// Nominatim blocks User-Agents that look fake (e.g. containing example.com).
// Keep it a real, identifying app name. Override via OSM_USER_AGENT if desired.
const UA = process.env.OSM_USER_AGENT ?? "local-intel-app/0.1";

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export class OsmProvider implements PublicContentProvider {
  readonly name = "osm";
  readonly provenance = "OFFICIAL_PUBLIC_API" as const;

  isConfigured(): boolean {
    return true; // no key required
  }

  async discoverProfiles(input: DiscoverInput): Promise<ProfileCandidate[]> {
    // Nearby mode (competitors) when we have a center point.
    if (input.near) return this.nearby(input);
    // Text mode (find your business).
    if (input.query) return this.textSearch(input);
    return [];
  }

  private async textSearch(input: DiscoverInput): Promise<ProfileCandidate[]> {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", input.query!);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("namedetails", "1");
    url.searchParams.set("extratags", "1");
    url.searchParams.set("limit", String(Math.min(input.limit ?? 10, 15)));
    if (input.near) {
      // bias toward a viewbox around the point
      const d = 0.2;
      url.searchParams.set(
        "viewbox",
        `${input.near.lng - d},${input.near.lat - d},${input.near.lng + d},${input.near.lat + d}`,
      );
    }

    const res = await fetchWithTimeout(
      url.toString(),
      { headers: { "User-Agent": UA, "Accept-Language": "en" } },
      10000,
    );
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const rows = (await res.json()) as any[];
    return rows.map((r): ProfileCandidate => {
      const lat = Number(r.lat);
      const lng = Number(r.lon);
      const website = r.extratags?.website ?? r.extratags?.["contact:website"] ?? r.extratags?.url;
      return {
        name: r.namedetails?.name ?? r.name ?? String(r.display_name).split(",")[0],
        platform: "osm",
        externalId: `${r.osm_type}/${r.osm_id}`,
        url: website,
        website,
        geo: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined,
        category: r.extratags?.cuisine ?? r.type,
        prominence: r.importance ?? 0,
        confidence: 0.7,
        raw: { display_name: r.display_name, address: r.address, extratags: r.extratags },
      };
    });
  }

  // Category terms for Nominatim's bounded free-text search (reliable infra).
  private static CATEGORY_TERM: Record<string, string> = {
    restaurant: "restaurant",
    grocery: "supermarket",
  };

  private async nearby(input: DiscoverInput): Promise<ProfileCandidate[]> {
    const { lat, lng, radiusKm = 3 } = input.near!;
    const center = { lat, lng };
    // Primary: Nominatim bounded category search — same reliable infra as text
    // search, and (unlike public Overpass) it stays up. viewbox restricts to a
    // box ~radiusKm around the business.
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 111);
    const vb = `${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}`;
    const term = OsmProvider.CATEGORY_TERM[input.vertical ?? "restaurant"] ?? "restaurant";

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", term);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("viewbox", vb);
    url.searchParams.set("bounded", "1");
    url.searchParams.set("limit", String(Math.min(input.limit ?? 40, 40)));
    url.searchParams.set("extratags", "1");
    url.searchParams.set("namedetails", "1");

    let rows: any[] = [];
    try {
      const res = await fetchWithTimeout(
        url.toString(),
        { headers: { "User-Agent": UA, "Accept-Language": "en" } },
        10000,
      );
      if (res.ok) rows = (await res.json()) as any[];
    } catch {
      // Nominatim hiccup → degrade to manual/Google
    }

    const out: ProfileCandidate[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const name = r.namedetails?.name ?? r.name ?? String(r.display_name).split(",")[0];
      if (!name) continue;
      const key = name.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      const gLat = Number(r.lat);
      const gLng = Number(r.lon);
      const geo = Number.isFinite(gLat) && Number.isFinite(gLng) ? { lat: gLat, lng: gLng } : undefined;
      const website = r.extratags?.website ?? r.extratags?.["contact:website"] ?? r.extratags?.url;
      out.push({
        name,
        platform: "osm",
        externalId: `${r.osm_type}/${r.osm_id}`,
        url: website,
        website,
        geo,
        distanceKm: geo ? Number(haversineKm(center, geo).toFixed(2)) : undefined,
        category: r.extratags?.cuisine ?? r.type,
        prominence: r.importance ?? 0,
        confidence: 0.6,
        raw: { extratags: r.extratags, address: r.address },
      });
    }
    return out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  }

  async collectProfiles(_i: ProfileBatch): Promise<ProviderJob> {
    throw new UnsupportedCapability(this.name, "collectProfiles");
  }
  async collectContent(_i: ContentBatch): Promise<ProviderJob> {
    throw new UnsupportedCapability(this.name, "collectContent");
  }
  async getJob(jobId: string): Promise<ProviderJobStatus> {
    return { jobId, provider: this.name, status: "failed", error: "n/a" };
  }
  async *fetchResults(): AsyncIterable<RawObservation> {
    /* discovery-only */
  }
  async estimateCost(_i: ProviderRequest): Promise<CostEstimate> {
    return {
      provider: this.name,
      currency: "USD",
      estimatedUsd: 0,
      basis: "OpenStreetMap Nominatim/Overpass — free, fair-use rate limits",
    };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return { provider: this.name, ok: true, configured: true, checkedAt: new Date().toISOString() };
  }
}
