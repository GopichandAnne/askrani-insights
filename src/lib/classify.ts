/**
 * Business classification helpers — pure, dependency-free (easy to test).
 *
 * Two jobs:
 *  1) inferVertical: is this place a restaurant or a grocery? (from OSM tags +
 *     name), so onboarding doesn't have to ask the user to pick.
 *  2) subtype: the cuisine / ethnic character of a place (Indian, Chinese,
 *     Mexican, halal…), so competitor discovery can rank *like-for-like* first
 *     (an Indian grocery's closest rivals are other Indian/South-Asian grocers,
 *     then nearby grocers generally) — for restaurants and groceries alike.
 */

export interface CandidateLike {
  name?: string;
  category?: string;
  raw?: any; // OSM row bits: { osm_class, osm_type, extratags:{shop,amenity,cuisine,...} }
}

// ── vertical inference ──────────────────────────────────────────────────────
const GROCERY_SHOP = new Set([
  "supermarket", "convenience", "greengrocer", "grocery", "deli", "butcher",
  "bakery", "general", "food", "farm", "dairy", "spices", "frozen_food",
  "health_food", "organic", "seafood", "wholesale",
]);
const RESTAURANT_AMENITY = new Set([
  "restaurant", "cafe", "fast_food", "bar", "pub", "food_court", "ice_cream",
  "biergarten", "cafeteria",
]);
const GROCERY_NAME = /\b(grocer(y|ies|s)?|supermarket|market|bazaar|mart|foods?|provisions?|spices?|halal meat|butcher|deli|bakery|cash\s*&\s*carry)\b/i;
const RESTAURANT_NAME = /\b(restaurant|caf[eé]|kitchen|grill|pizzeria|pizza|diner|bistro|eatery|taqueria|tavern|steakhouse|bar\s*&\s*grill|noodle|sushi|ramen|bbq|barbecue|dhaba)\b/i;

function tagBits(cand: CandidateLike): { cls?: string; type?: string; shop?: string; amenity?: string; cuisine?: string } {
  const raw = cand.raw ?? {};
  const ex = raw.extratags ?? {};
  return {
    cls: (raw.osm_class ?? raw.class)?.toLowerCase?.(),
    type: (raw.osm_type_tag ?? raw.type)?.toLowerCase?.(),
    shop: ex.shop?.toLowerCase?.(),
    amenity: ex.amenity?.toLowerCase?.(),
    cuisine: ex.cuisine?.toLowerCase?.(),
  };
}

/** "grocery" | "restaurant" — best guess for a picked place. Defaults to
 *  restaurant only as a last resort (most food places in OSM are restaurants). */
export function inferVertical(cand: CandidateLike): "grocery" | "restaurant" {
  const { cls, type, shop, amenity, cuisine } = tagBits(cand);

  if (shop && GROCERY_SHOP.has(shop)) return "grocery";
  if (cls === "shop" || (type && GROCERY_SHOP.has(type))) return "grocery";
  if (amenity && RESTAURANT_AMENITY.has(amenity)) return "restaurant";
  if (cls === "amenity" && type && RESTAURANT_AMENITY.has(type)) return "restaurant";

  const name = cand.name ?? "";
  // Name signals: check grocery first (a "market" is grocery, not a restaurant).
  if (GROCERY_NAME.test(name)) return "grocery";
  if (RESTAURANT_NAME.test(name)) return "restaurant";
  // cuisine tag without a shop tag → almost always a restaurant
  if (cuisine) return "restaurant";
  return "restaurant";
}

// ── subtype (cuisine / ethnicity) ───────────────────────────────────────────
// Canonical cuisine keywords we recognise in OSM cuisine tags and names.
const CUISINES = [
  "indian", "pakistani", "bangladeshi", "sri_lankan", "nepali", "afghan", "desi",
  "chinese", "korean", "japanese", "taiwanese", "mongolian",
  "thai", "vietnamese", "filipino", "malaysian", "indonesian", "burmese", "cambodian",
  "asian",
  "mexican", "latin_american", "cuban", "peruvian", "brazilian", "argentinian", "colombian", "salvadoran",
  "caribbean", "jamaican",
  "italian", "greek", "mediterranean", "spanish", "portuguese", "french", "german", "polish", "russian", "ukrainian",
  "middle_eastern", "persian", "turkish", "lebanese", "arab", "moroccan", "israeli",
  "halal", "kosher", "jewish",
  "african", "ethiopian", "nigerian", "somali",
  "american", "southern", "cajun", "soul_food", "bbq", "seafood", "pizza", "burger",
  "vegetarian", "vegan", "kosher",
];

// Name aliases → canonical cuisine keyword (covers brand/word signals OSM tags miss).
const NAME_ALIASES: [RegExp, string][] = [
  [/\b(patel|desi|masala|tandoor|tandoori|curry|namaste|bombay|mumbai|delhi|punjab|punjabi|gujarat|chaat|dosa|biryani|india|indian)\b/i, "indian"],
  [/\b(pakistan|pakistani|karachi|lahore)\b/i, "pakistani"],
  [/\b(bangla|bangladesh|dhaka)\b/i, "bangladeshi"],
  [/\bnepal(i)?\b/i, "nepali"],
  [/\b(china|chinese|szechuan|sichuan|canton|dim\s*sum|wok|panda|dragon)\b/i, "chinese"],
  [/\b(korea|korean|kimchi|seoul|bibimbap)\b/i, "korean"],
  [/\b(japan|japanese|sushi|ramen|izakaya|sake|tokyo|hokkaido)\b/i, "japanese"],
  [/\b(thai|bangkok|pad\s*thai)\b/i, "thai"],
  [/\b(pho|vietnam(ese)?|saigon|hanoi)\b/i, "vietnamese"],
  [/\b(filipino|philippine|manila|lechon)\b/i, "filipino"],
  [/\b(taco|taqueria|mexican|mexico|oaxaca|jalisco|carniceria)\b/i, "mexican"],
  [/\b(halal|zabiha)\b/i, "halal"],
  [/\b(kosher|glatt)\b/i, "kosher"],
  [/\b(persian|iran(ian)?|kabob|kebab|shiraz|tehran)\b/i, "persian"],
  [/\b(turk(ish)?|istanbul|doner|kebab)\b/i, "turkish"],
  [/\b(lebanese|beirut|shawarma|falafel)\b/i, "lebanese"],
  [/\b(arab|arabic|middle\s*east|mediterranean)\b/i, "middle_eastern"],
  [/\b(ethiopia(n)?|injera|habesha)\b/i, "ethiopian"],
  [/\b(african|nigeria(n)?|ghana(ian)?)\b/i, "african"],
  [/\b(caribbean|jamaica(n)?|jerk|trinidad)\b/i, "caribbean"],
  [/\b(italian|italia|pizzeria|trattoria|osteria|napoli)\b/i, "italian"],
  [/\b(greek|gyro|souvlaki|athens)\b/i, "greek"],
  [/\b(polish|pierogi|warsaw)\b/i, "polish"],
  [/\b(russian|moscow|slavic)\b/i, "russian"],
  [/\b(asian|oriental)\b/i, "asian"],
];

// Broad families so related cuisines still count as "similar" (Indian ↔ Pakistani).
const BROAD: Record<string, string> = {
  indian: "south_asian", pakistani: "south_asian", bangladeshi: "south_asian",
  sri_lankan: "south_asian", nepali: "south_asian", afghan: "south_asian", desi: "south_asian",
  chinese: "east_asian", korean: "east_asian", japanese: "east_asian", taiwanese: "east_asian", mongolian: "east_asian",
  thai: "southeast_asian", vietnamese: "southeast_asian", filipino: "southeast_asian",
  malaysian: "southeast_asian", indonesian: "southeast_asian", burmese: "southeast_asian", cambodian: "southeast_asian",
  mexican: "latin", latin_american: "latin", cuban: "latin", peruvian: "latin",
  brazilian: "latin", argentinian: "latin", colombian: "latin", salvadoran: "latin",
  caribbean: "caribbean", jamaican: "caribbean",
  italian: "mediterranean", greek: "mediterranean", mediterranean: "mediterranean", spanish: "mediterranean", portuguese: "mediterranean",
  middle_eastern: "middle_eastern", persian: "middle_eastern", turkish: "middle_eastern",
  lebanese: "middle_eastern", arab: "middle_eastern", moroccan: "middle_eastern", israeli: "middle_eastern", halal: "middle_eastern",
  ethiopian: "african", nigerian: "african", somali: "african", african: "african",
};

function normalizeCuisine(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[;,_/|]+|\s+and\s+/)
    .map((t) => t.trim().replace(/\s+/g, "_"))
    .filter(Boolean);
}

/** The cuisine/ethnic keywords that describe a place (may be empty). */
export function extractSubtype(cand: CandidateLike): string[] {
  const found = new Set<string>();
  const ex = cand.raw?.extratags ?? {};
  const cuisineTag = ex.cuisine ?? cand.category ?? "";
  for (const tok of normalizeCuisine(String(cuisineTag))) {
    if (CUISINES.includes(tok)) found.add(tok);
  }
  // origin tag (e.g. cuisine origin country) + explicit halal diet tag
  if (ex.origin) for (const tok of normalizeCuisine(String(ex.origin))) if (CUISINES.includes(tok)) found.add(tok);
  if (ex["diet:halal"] === "yes") found.add("halal");

  const name = cand.name ?? "";
  for (const [re, key] of NAME_ALIASES) if (re.test(name)) found.add(key);
  return [...found];
}

/** 0..1 similarity between two subtype sets. 1 = shared cuisine, 0.6 = same
 *  broad family, 0.7 for the "asian" umbrella overlapping an asian sub-cuisine. */
export function subtypeSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  for (const x of b) if (sa.has(x)) return 1; // direct cuisine match

  const asianFamilies = new Set(["south_asian", "east_asian", "southeast_asian"]);
  const fam = (arr: string[]) => new Set(arr.map((x) => BROAD[x]).filter(Boolean) as string[]);
  const fa = fam(a);
  const fb = fam(b);
  for (const x of fb) if (fa.has(x)) return 0.6; // same broad family

  const aHasAsian = a.includes("asian");
  const bHasAsian = b.includes("asian");
  if (aHasAsian && [...fb].some((f) => asianFamilies.has(f))) return 0.7;
  if (bHasAsian && [...fa].some((f) => asianFamilies.has(f))) return 0.7;
  if (aHasAsian && bHasAsian) return 0.8;

  return 0;
}

/** A short human label for a subtype set, e.g. ["indian"] → "Indian". */
export function subtypeLabel(subtype: string[]): string | undefined {
  if (!subtype.length) return undefined;
  const pretty = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return subtype.slice(0, 2).map(pretty).join(" / ");
}
