import { getProvider } from "@/lib/providers/registry";
import { inferVertical, extractSubtype, subtypeLabel } from "@/lib/classify";

/**
 * "Explore an area" — a no-setup market scan. Enter a zip/city + what you're
 * looking for; we geocode the area, run a geo-biased Google Places search, keep
 * only results near that centroid (kills same-name results from other cities),
 * and rank by quality × popularity. Ratings/reviews come straight from the
 * search response, so this needs no collection and no workspace.
 */

export interface ExploreResult {
  name: string;
  rating: number | null;
  reviews: number | null;
  address?: string;
  website?: string;
  geo?: { lat: number; lng: number };
  vertical: string;
  subtype: string;
  distanceKm?: number;
  mapsUrl?: string;
  category?: string; // Google primaryType — seeds onboarding
  placeId?: string;
}
export interface ExploreResponse {
  center?: { lat: number; lng: number };
  areaLabel?: string;
  results: ExploreResult[];
  error?: string;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Forward-geocode a zip/city to a centroid (Nominatim, free, US-biased). */
async function geocodeArea(q: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`,
      { headers: { "user-agent": "local-intel-app/0.1", "accept-language": "en" }, signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const d = ((await res.json()) as any[])[0];
    if (!d) return null;
    return { lat: Number(d.lat), lng: Number(d.lon), label: shortLabel(d.display_name) };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
function shortLabel(display: string): string {
  // "78641, Leander, Williamson County, Texas, United States" → "Leander, Texas"
  const parts = String(display).split(",").map((s) => s.trim());
  const city = parts.find((p) => p && !/^\d+$/.test(p) && !/county/i.test(p) && !/united states/i.test(p));
  const state = parts.find((p) => /texas|california|new york|new jersey|florida|[A-Z]{2}$/i.test(p) && p !== city);
  return [city, state].filter(Boolean).join(", ") || display;
}

export async function exploreArea(input: { area: string; keyword?: string }): Promise<ExploreResponse> {
  const area = (input.area ?? "").trim();
  const kw = (input.keyword ?? "").trim() || "restaurants";
  if (!area) return { results: [], error: "Enter a zip code or city." };

  const google = getProvider("google");
  if (!google?.isConfigured()) return { results: [], error: "Area search needs the Google Places key (GOOGLE_MAPS_API_KEY)." };

  const geo = await geocodeArea(area);
  const near = geo ? { lat: geo.lat, lng: geo.lng, radiusKm: 12 } : undefined;
  const query = `${kw} in ${area}`;

  let cands: any[] = [];
  try {
    cands = await google.discoverProfiles({ query, near, limit: 20 });
  } catch (e) {
    return { results: [], error: (e as Error).message, center: geo ?? undefined, areaLabel: geo?.label };
  }

  let results: ExploreResult[] = cands.map((c: any) => {
    const p = c.raw ?? {};
    const distanceKm = geo && c.geo ? Number(haversineKm(geo, c.geo).toFixed(1)) : undefined;
    return {
      name: c.name,
      rating: p.rating ?? null,
      reviews: p.userRatingCount ?? null,
      address: p.formattedAddress,
      website: c.website,
      geo: c.geo,
      vertical: inferVertical(c),
      subtype: subtypeLabel(extractSubtype(c)) ?? "",
      distanceKm,
      mapsUrl: c.url,
      category: p.primaryType,
      placeId: p.id,
    };
  });

  // geo-enforce: drop anything far from the area centroid (same-name elsewhere)
  if (geo) results = results.filter((r) => r.distanceKm == null || r.distanceKm <= 20);
  // rank by quality × popularity (rating weighted by how many reviews back it)
  const score = (r: ExploreResult) => (r.rating ?? 0) * Math.log10((r.reviews ?? 0) + 10);
  results.sort((a, b) => score(b) - score(a));

  return { center: geo ?? undefined, areaLabel: geo?.label, results };
}
