/**
 * Price SCOPE + precedence — the same product legitimately has different prices in
 * different contexts (corporate website $19.99, a branch's DoorDash $18.49, a local
 * IG Tuesday special $12.99). These aren't conflicting data; they're scoped facts.
 * For LOCAL competitive intelligence the competitive price is the most LOCATION-
 * specific, currently-valid, most-recent one — never a corporate list price.
 *
 * At collection we can't yet read a single post's wording (that's the post-level
 * scope pass), so we scope by CHANNEL: a business's website is usually the corporate
 * site (brand scope); its delivery page, Google profile, flyer and local posts are
 * tied to that specific branch (location scope).
 */
export type PriceScope = "location" | "regional" | "brand" | "unknown";

export function scopeForChannel(channel?: string): PriceScope {
  const c = (channel || "").toLowerCase();
  if (!c) return "unknown";
  if (c === "website") return "brand";
  return "location"; // doordash / ubereats / google / flyer / instagram / facebook / tiktok / youtube
}

// Post-level scope (P1): a shared brand account posting "available at all locations"
// / "nationwide" is a BRAND signal, not a local-only price — so it must not outrank a
// genuine branch price. A specific-branch mention keeps it location. Deterministic
// first pass (cheap, safe); a full per-post LLM classifier can refine it later.
const ALL_LOCATIONS = /\b(?:at\s+)?(?:all|every|each)\s+(?:our\s+)?(?:location|locations|store|stores|branch|branches)\b|\bnation-?wide\b|\bchain-?wide\b|\ball\s+locations\b|\bevery\s+location\b/i;
export function refineScopeFromText(defaultScope: PriceScope, text?: string): PriceScope {
  if (text && ALL_LOCATIONS.test(text)) return "brand";
  return defaultScope;
}

export interface ScopedOffer {
  amount: number;
  scope?: string;
  channel?: string;
  observedAt?: string;
  validTo?: string | null;
  validityEnd?: string | null;
}

const scopeRank = (s?: string): number => (s === "location" ? 2 : s === "regional" ? 1 : 0);
const isValid = (o: ScopedOffer, now: number): boolean =>
  !o.validTo && !(o.validityEnd && Date.parse(o.validityEnd) < now);

/** The competitive price for one item at one business: most local, currently valid,
 *  then most recent. So a local $12.99 flyer wins over the corporate $19.99. */
export function pickCompetitivePrice<T extends ScopedOffer>(offers: T[]): T | null {
  if (!offers.length) return null;
  const now = Date.now();
  return [...offers].sort((a, b) => {
    const ra = scopeRank(a.scope) * 2 + (isValid(a, now) ? 1 : 0);
    const rb = scopeRank(b.scope) * 2 + (isValid(b, now) ? 1 : 0);
    if (rb !== ra) return rb - ra;
    return (Date.parse(b.observedAt || "") || 0) - (Date.parse(a.observedAt || "") || 0);
  })[0];
}
