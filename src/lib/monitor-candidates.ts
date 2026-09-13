import { createServiceClient } from "@/lib/supabase/server";

/**
 * The monitoring-queue candidate list — the businesses the superadmin is validating
 * before collecting. Persisted as one JSON document (monitor_candidate, migration
 * 0077) so handle/facet corrections survive a reload. Seeded from DEFAULT_CANDIDATES
 * on first load; every edit overwrites the document. Non-breaking: if the table isn't
 * there yet, load falls back to the default and save is a no-op.
 */

export type Chan = "instagram" | "facebook" | "tiktok" | "youtube";
export type Vert = "restaurant" | "grocery";
export interface Candidate {
  id: string; nm: string; vertical: Vert; area: string;
  web?: string; place?: boolean; note?: string;
  handles: Partial<Record<Chan, string>>;
  facets?: Vert[];
}

export const CHANS: Chan[] = ["instagram", "facebook", "tiktok", "youtube"];

export const DEFAULT_CANDIDATES: Candidate[] = [
  { id: "r1", nm: "Desi Circle", vertical: "restaurant", area: "Austin", web: "https://desicircleusa.com", place: true, handles: { instagram: "desicircleaustin" }, facets: ["restaurant", "grocery"] },
  { id: "r2", nm: "Foodistaan", vertical: "restaurant", area: "Cedar Park", web: "https://www.foodistaan.us", place: true, handles: { instagram: "foodistaancp" }, note: "Location account — @foodistaancp (Cedar Park), not the national @foodistaan.us.", facets: ["restaurant", "grocery"] },
  { id: "r3", nm: "House of Chettinad", vertical: "restaurant", area: "Austin", web: "https://www.houseofchettinad.com", place: true, handles: { instagram: "houseofchettinad_", tiktok: "houseofchettinad_" } },
  { id: "r4", nm: "Bawarchi Indian Cuisine & Bar", vertical: "restaurant", area: "Leander", web: "https://www.bawarchibiryanis.us", place: true, handles: { instagram: "bawarchi_indiancuisine_bar_tx" }, note: "Location account — @bawarchi_indiancuisine_bar_tx (Leander), not the national @bawarchibiryanis_usa." },
  { id: "r5", nm: "Chowrastha", vertical: "restaurant", area: "Austin", web: "http://desichowrastha.com", place: true, handles: { instagram: "desichowrastha", facebook: "chowrastha-104748712131254" } },
  { id: "r6", nm: "Hashtag India", vertical: "restaurant", area: "Leander", web: "https://www.hashtagindia.com", place: true, handles: { instagram: "hashtagindia.leander" }, note: "Location account — @hashtagindia.leander, not the national @hashtagindia_ (all 15 stores)." },
  { id: "r7", nm: "Naga's Indian Cuisine", vertical: "restaurant", area: "Cedar Park", web: "https://nagasaustin.com", place: true, handles: { instagram: "nagasaustin" } },
  { id: "r8", nm: "Salt N Pepper Gourmet Indian Fare", vertical: "restaurant", area: "Cedar Park", web: "https://saltnpepperusa.com", place: true, handles: { instagram: "saltnpepper_cedarpark" } },
  { id: "r9", nm: "Tandoor Restaurant & Catering", vertical: "restaurant", area: "Austin", web: "https://www.tandoortx.com", place: true, handles: {} },
  { id: "r10", nm: "Sangam Chettinad Indian Cuisine", vertical: "restaurant", area: "Austin", web: "https://www.sangamchettinad.com", place: true, handles: { instagram: "austinsangam", facebook: "austinsangam" } },
  { id: "r11", nm: "Teji's", vertical: "restaurant", area: "Austin", place: true, handles: { instagram: "tejisindian" } },
  { id: "r12", nm: "Tulsi Indian Cuisine", vertical: "restaurant", area: "Austin", place: true, handles: { instagram: "tulsifineindian_austin" } },
  { id: "r13", nm: "Kuppanna Indian Restaurant", vertical: "restaurant", area: "Austin", place: true, handles: { instagram: "kuppannaaustin" } },
  { id: "r14", nm: "Aroma — Indian Food Park", vertical: "restaurant", area: "Round Rock", place: true, handles: { instagram: "aromaaustin" } },
  { id: "r15", nm: "Bayleaf Indian Restaurant & Bar", vertical: "restaurant", area: "Round Rock", place: true, handles: { instagram: "bayleaf_indian_restaurant_bar" } },
  { id: "r16", nm: "Asiana Indian Cuisine", vertical: "restaurant", area: "Austin", place: true, handles: { instagram: "asiana_indian_cuisine" } },
  { id: "g1", nm: "Man Pasand Supermarket", vertical: "grocery", area: "Austin", web: "https://www.manpasandsupermarket.com", place: true, handles: { instagram: "manpasandaustin" }, facets: ["grocery", "restaurant"] },
  { id: "g2", nm: "Desi Brothers Farmers Market", vertical: "grocery", area: "Austin", web: "http://www.desibrothers.com", place: true, handles: { instagram: "desibrothersaustin" }, note: "Location account — @desibrothersaustin (the DFW Facebook was dropped as wrong-metro).", facets: ["grocery", "restaurant"] },
  { id: "g3", nm: "India Bazaar Austin", vertical: "grocery", area: "Cedar Park", web: "https://www.indiabazaar.us", place: true, handles: { instagram: "indiabazaaraustin" }, facets: ["grocery", "restaurant"] },
  { id: "g4", nm: "Big Bazaar Fresh Market", vertical: "grocery", area: "Cedar Park", web: "https://www.big-bazaar.co", place: true, handles: { instagram: "bigbazaar789" }, note: "Two similar Big Bazaar IG accounts — @bigbazaar789 is the Cedar Park one. Confirm." },
  { id: "g5", nm: "Gandhi Bazar", vertical: "grocery", area: "Austin", web: "http://www.gandhi-bazar.com", place: true, handles: { facebook: "gandhibazarstore" }, note: "Only a Facebook page found — add their Instagram if they have one." },
  { id: "g6", nm: "International Foods (Halal)", vertical: "grocery", area: "Austin", web: "https://ifatx.com", place: true, handles: { instagram: "internationalfoodsaustin" } },
  { id: "g7", nm: "Dana Bazaar Indian Supermarket", vertical: "grocery", area: "Austin", web: "https://danabazaarsupermarket.com", place: true, handles: { instagram: "danabazaarsupermarket", facebook: "danabazaaraustin" } },
  { id: "g8", nm: "Iqbal Foods", vertical: "grocery", area: "Austin", place: true, handles: {} },
  { id: "g9", nm: "H Mart (Lakeline)", vertical: "grocery", area: "Austin", web: "https://www.hmart.com", place: true, handles: { instagram: "hmartofficial" }, note: "Korean grocer, not Indian — a competitor. Confirm you want it in the set." },
  { id: "g10", nm: "Patel Brothers", vertical: "grocery", area: "Cedar Park", web: "https://www.patelbros.com", place: true, handles: { instagram: "patelbrotherscedarpark" }, note: "Open in Cedar Park (2026). Confirm @patelbrotherscedarpark via Open ↗." },
  { id: "g11", nm: "Khana Khazana ATX", vertical: "grocery", area: "Cedar Park", place: true, handles: { instagram: "khana_khazana_atx" } },
  { id: "g12", nm: "MTM Indian Grocery & Fish", vertical: "grocery", area: "Austin", place: true, handles: { instagram: "mtmindianfoodsinc" } },
];

const cleanHandle = (s: unknown) => String(s ?? "").replace(/^@+/, "").replace(/[^A-Za-z0-9_.\-]/g, "").slice(0, 40);

/** Sanitize a candidate list from the client before persisting (never trust raw input). */
export function sanitizeCandidates(raw: unknown): Candidate[] {
  if (!Array.isArray(raw)) return [];
  const VERTS: Vert[] = ["restaurant", "grocery"];
  return raw.slice(0, 80).map((r) => {
    const b = (r ?? {}) as Record<string, unknown>;
    const vertical: Vert = VERTS.includes(b.vertical as Vert) ? (b.vertical as Vert) : "restaurant";
    const rawH = (b.handles ?? {}) as Record<string, unknown>;
    const handles: Partial<Record<Chan, string>> = {};
    for (const c of CHANS) { const h = cleanHandle(rawH[c]); if (h) handles[c] = h; }
    const facets = Array.isArray(b.facets) ? [...new Set((b.facets as unknown[]).map(String).filter((f): f is Vert => VERTS.includes(f as Vert)))] : undefined;
    return {
      id: String(b.id ?? "").slice(0, 40), nm: String(b.nm ?? "").slice(0, 120), vertical,
      area: String(b.area ?? "").slice(0, 60), web: b.web ? String(b.web).slice(0, 300) : undefined,
      place: !!b.place, note: b.note ? String(b.note).slice(0, 300) : undefined,
      handles, facets: facets && facets.length ? facets : undefined,
    };
  }).filter((b) => b.id && b.nm);
}

/** The persisted candidate list, or the code default when none saved yet / table absent. */
export async function loadCandidates(): Promise<Candidate[]> {
  try {
    const svc = createServiceClient();
    const { data, error } = await svc.from("monitor_candidate").select("candidates").eq("id", "default").maybeSingle();
    if (error) return DEFAULT_CANDIDATES; // table missing (pre-0077) → default
    const arr = data?.candidates as Candidate[] | undefined;
    return arr && arr.length ? arr : DEFAULT_CANDIDATES;
  } catch { return DEFAULT_CANDIDATES; }
}

/** Persist the whole candidate list (overwrite). Returns false if the store is absent. */
export async function saveCandidates(candidates: Candidate[]): Promise<boolean> {
  try {
    const svc = createServiceClient();
    const { error } = await svc.from("monitor_candidate").upsert({ id: "default", candidates, updated_at: new Date().toISOString() }, { onConflict: "id" });
    return !error;
  } catch { return false; }
}
