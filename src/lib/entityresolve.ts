import { brandKey } from "@/lib/discovery";

/**
 * Fellegi-Sunter entity resolution — links business records that are the SAME
 * real-world entity, and (critically) SPLITS ones that aren't, using geo / phone /
 * address as mandatory splitters so two distinct businesses with similar names at
 * different locations are never merged on the name alone. Replaces the crude
 * name-only `canonRival` regex the detector used.
 *
 * The method (Fellegi & Sunter 1969): for each candidate pair, score agreement on
 * each field as a log-likelihood weight log(m/u) (agree) or log((1-m)/(1-u))
 * (disagree); sum to a match weight; a pair LINKS above an upper threshold, is a
 * non-match below a lower one, and "possible" in between is left UNMERGED (the
 * do-not-guess discipline). We have no labelled pairs yet, so the m/u values are
 * hand-set priors (the standard posture when training data is absent) — encoded as
 * the per-field weights below and tunable once owner confirms/rejects accrue.
 *
 * Two hard rules on top of the weight sum:
 *   • NAMES ARE FREQUENCY-WEIGHTED (IDF): a shared distinctive token ("Ghouse")
 *     is strong evidence; a shared common token ("Indian", "Restaurant") is nearly
 *     none — so generic-name collisions don't drive false merges.
 *   • SPLITTERS OVERRIDE NAME: a phone conflict, a >2km geo gap, or a clearly
 *     different street address forces NON-LINK regardless of how alike the names
 *     are — this is what preserves distinct branches/operators.
 *
 * Output is entity-level (one canonical id per real location) plus a brand grouping
 * (branches of one chain share a brand) for callers that want brand-level counts.
 */

export interface EntityRecord {
  id: string;
  name: string;
  phone?: string | null;
  address?: string | null;
  geo?: { lat: number; lng: number } | null;
}
export interface EntityResolution {
  entityOf: Map<string, string>;                    // recordId → canonical entity id (a representative recordId)
  brandOf: Map<string, string>;                     // recordId → brand key (branches of a chain share it)
  index: { id: string; brand: string; toks: Map<string, number>; norm: number }[]; // for resolving bare names
  idf: Map<string, number>;
}

// ── field helpers ───────────────────────────────────────────────────────────
const STOP = new Set(["the", "of", "and", "co", "inc", "llc", "ltd", "a", "an", "at", "on", "to"]);
const tokenize = (s: string): string[] =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));

const phoneDigits = (p?: string | null): string => { const d = String(p ?? "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
// street signature: leading number + first street word ("123 main")
const streetSig = (a?: string | null): string => {
  const m = String(a ?? "").toLowerCase().match(/\b(\d{1,6})\s+([a-z]+)/);
  return m ? `${m[1]} ${m[2]}` : "";
};
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180, la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const md = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const ma = new Array(a.length).fill(false), mb = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - md); j < Math.min(b.length, i + md + 1); j++) {
      if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) if (ma[i]) { while (!mb[k]) k++; if (a[i] !== b[k]) t++; k++; }
  t /= 2;
  const jaro = (m / a.length + m / b.length + (m - t) / m) / 3;
  let p = 0; while (p < 4 && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

// ── the resolver ────────────────────────────────────────────────────────────
// L2 norm of the IDF-weighted token vector (so nameSim below is a true cosine).
const l2norm = (toks: Map<string, number>, idf: Map<string, number>, avgIdf: number) => {
  let s = 0; for (const [t, c] of toks) { const w = (idf.get(t) ?? avgIdf) * c; s += w * w; } return Math.sqrt(s);
};

/** IDF-weighted cosine over two token bags, using a shared idf table. */
function nameSim(
  ta: Map<string, number>, na: number, tb: Map<string, number>, nb: number,
  idf: Map<string, number>, avgIdf: number,
): number {
  if (!na || !nb) return 0;
  let dot = 0;
  for (const [t, ca] of ta) { const cb = tb.get(t); if (cb) { const w = idf.get(t) ?? avgIdf; dot += w * w * ca * cb; } }
  const cos = dot / (na * nb);
  // blend cosine with a Jaro-Winkler on the joined distinctive tokens (catches
  // spelling/transliteration variants the token overlap misses)
  const distinct = (t: Map<string, number>) => [...t.entries()].sort((x, y) => (idf.get(y[0]) ?? avgIdf) - (idf.get(x[0]) ?? avgIdf)).slice(0, 3).map((e) => e[0]).join("");
  const jw = jaroWinkler(distinct(ta), distinct(tb));
  return Math.max(cos, 0.85 * jw);
}

export function resolveEntities(records: EntityRecord[]): EntityResolution {
  const recs = records.filter((r) => r.id && r.name);
  const toksOf = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  for (const r of recs) {
    const bag = new Map<string, number>();
    for (const t of tokenize(r.name)) bag.set(t, (bag.get(t) ?? 0) + 1);
    toksOf.set(r.id, bag);
    for (const t of bag.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, recs.length);
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log((N + 1) / (d + 0.5)));
  const avgIdf = [...idf.values()].reduce((a, b) => a + b, 0) / Math.max(1, idf.size);
  const normOf = new Map<string, number>();
  for (const r of recs) normOf.set(r.id, l2norm(toksOf.get(r.id)!, idf, avgIdf) || 1e-9);

  // blocking: index records under EVERY name token so any pair sharing a token is
  // compared (a plain "India Bazaar" must still meet "India Bazaar Cedar Park").
  // Ultra-common tokens form huge blocks — cap them so it stays far under O(n²);
  // a pair sharing only an ultra-common token is a non-match anyway (low name sim).
  const block = new Map<string, string[]>();
  for (const r of recs) for (const t of toksOf.get(r.id)!.keys()) (block.get(t) ?? block.set(t, []).get(t)!).push(r.id);
  const BLOCK_CAP = 80;

  // union-find
  const parent = new Map<string, string>(recs.map((r) => [r.id, r.id]));
  const find = (x: string): string => { let p = parent.get(x)!; while (p !== x) { parent.set(x, parent.get(p)!); x = p; p = parent.get(x)!; } return x; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const recById = new Map(recs.map((r) => [r.id, r]));

  const seen = new Set<string>();
  for (const ids of block.values()) {
    if (ids.length > BLOCK_CAP) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const pk = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(pk)) continue; seen.add(pk);
      const ra = recById.get(a)!, rb = recById.get(b)!;

      // ── hard splitters: any conflicting strong identifier forces NON-LINK ──
      const pa = phoneDigits(ra.phone), pb = phoneDigits(rb.phone);
      if (pa && pb && pa !== pb) continue;                        // different phone → different entity
      if (ra.geo && rb.geo && haversineKm(ra.geo, rb.geo) > 2) continue; // >2km apart → different location
      const sa = streetSig(ra.address), sb = streetSig(rb.address);
      if (sa && sb && sa !== sb) continue;                        // different street address → different entity

      // ── Fellegi-Sunter weight sum (hand-set m/u priors) ──
      const sim = nameSim(toksOf.get(a)!, normOf.get(a)!, toksOf.get(b)!, normOf.get(b)!, idf, avgIdf);
      let w = 9 * (sim - 0.5);                                    // name: the primary field, IDF-weighted
      if (pa && pb && pa === pb) w += 6;                          // same phone → very strong agreement
      if (sa && sb && sa === sb) w += 4;                          // same street → strong
      if (ra.geo && rb.geo) { const km = haversineKm(ra.geo, rb.geo); w += km < 0.12 ? 3 : km < 0.5 ? 1 : -1; }
      if (w >= 4) union(a, b);                                    // ≥ upper threshold → LINK (else possible/non → leave split)
    }
  }

  // entity id = the representative record per component; brand groups entities by
  // their name stem (branches of a chain), independent of geo.
  const entityOf = new Map<string, string>();
  const brandOf = new Map<string, string>();
  for (const r of recs) {
    entityOf.set(r.id, find(r.id));
    brandOf.set(r.id, brandKey(r.name) || find(r.id));
  }
  const index = recs.map((r) => ({ id: r.id, brand: brandOf.get(r.id)!, toks: toksOf.get(r.id)!, norm: normOf.get(r.id)! }));
  return { entityOf, brandOf, index, idf };
}

/**
 * Resolve a BARE name (e.g. a market_event.rival string with no attributes) to a
 * brand key, by IDF-weighted name agreement against the resolved set; falls back to
 * the name's own brand stem when nothing matches. Name-only, so no splitter can
 * apply — used where attributes aren't available on the record itself.
 */
export function resolveNameToBrand(name: string, res: EntityResolution): string {
  const bag = new Map<string, number>();
  for (const t of tokenize(name)) bag.set(t, (bag.get(t) ?? 0) + 1);
  if (!bag.size) return String(name ?? "").toLowerCase().trim() || "unknown";
  const avgIdf = [...res.idf.values()].reduce((a, b) => a + b, 0) / Math.max(1, res.idf.size);
  const norm = l2norm(bag, res.idf, avgIdf) || 1e-9;
  let best = 0, brand = "";
  for (const e of res.index) {
    const s = nameSim(bag, norm, e.toks, e.norm, res.idf, avgIdf);
    if (s > best) { best = s; brand = e.brand; }
  }
  return best >= 0.6 ? brand : (brandKey(name) || tokenize(name).join(" "));
}
