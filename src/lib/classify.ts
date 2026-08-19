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
const GROCERY_NAME = /\b(grocer(y|ies|s)?|supermarket|market|bazaar|mart|foods?|provisions?|spices?|halal meat|butcher|deli|bakery|cash\s*(&|and)\s*carry|subzi|sabzi|mandi|kirana|carniceria|panaderia|produce|farmers?)\b/i;
const RESTAURANT_NAME = /\b(restaurant|caf[eé]|kitchen|grill|pizzeria|pizza|diner|bistro|eatery|taqueria|tavern|steakhouse|bar\s*&\s*grill|noodle|sushi|ramen|bbq|barbecue|dhaba)\b/i;

// Google Places (New) type signals (primaryType + types[]) — authoritative and
// present exactly for the well-known businesses OSM often leaves untagged.
const GROCERY_GTYPE = /grocery|supermarket|convenience_store|liquor_store|food_store|butcher|greengrocer|warehouse_store|wholesaler|department_store|market(?!ing)/;
const RESTAURANT_GTYPE = /restaurant|\bcafe\b|coffee_shop|\bbar\b|\bpub\b|meal_takeaway|meal_delivery|fast_food|food_court|ice_cream|diner|steak_house|bistro|brewery|winery/;

// Beauty / med-spa / personal-care vertical ('salon' in the enum). Covers med
// spas, day spas, aesthetics clinics, skin/laser, salons, barbers, nails, lash/brow.
const BEAUTY_SHOP = new Set(["beauty", "hairdresser", "cosmetics", "tattoo", "massage", "nail_salon"]);
const BEAUTY_GTYPE = /\bspa\b|beauty_salon|hair_care|hair_salon|nail_salon|barber|skin_care|medical_spa|med_spa|wellness_center|massage|tanning|waxing|facial|laser|dermatolog|aesthetic/;
const BEAUTY_NAME = /\b(med\s*spa|medspa|medical\s*spa|aesthetics?|laser|botox|filler|injectable|dermatolog|skin\s*(care|clinic|bar|studio)|facial|hydrafacial|lash|brow|microblad|microneedl|threading|waxing|\bwax\b|nails?|nail\s*bar|salon|barber|\bspa\b|wellness|rejuven|\bglow\b|beauty\s*bar|cosmetic|esthetic)\b/i;

// Smoke / vape / tobacco retail ('smoke_vape' in the DB enum). Smoke shops, vape
// stores, tobacco & cigar shops, hookah retail, CBD/kratom shops, head shops.
const SMOKE_SHOP = new Set(["tobacco", "e-cigarette", "e-cigarettes", "cbd"]);
const SMOKE_GTYPE = /tobacco|cigar|hookah|\bvape\b|e_cigarette|smoke_shop/;
// Unambiguous smoke-retail name tokens. Deliberately NOT bare "smoke" (a BBQ
// "Smokehouse" is a restaurant); require shop/vape/tobacco/cigar/hookah/etc.
const SMOKE_NAME = /\b(smoke\s*shop|smokeshop|smoke\s*(?:&|n|and)\s*vape|vape|vapor|vaping|e-?cigs?|e-?cigarettes?|tobacco|cigars?|hookah|shisha|head\s*shop|cbd|kratom|pipe\s*shop|dispensary)\b/i;

/** The verticals we can monitor. Food (restaurant/grocery), personal-care
 *  ('salon' — med spas, day spas, aesthetics, salons, barbers), smoke/vape retail
 *  ('smoke_vape'), and the service verticals fitness / dental / real_estate.
 *  'other' is the catch-all for anything the classifier can't place. Detection is
 *  deterministic first (structured + name signals) then an LLM fallback for the
 *  long tail — see nameVertical() here and smartVertical() in detect.ts. */
export type Vertical =
  | "grocery" | "restaurant" | "salon" | "smoke_vape"
  | "fitness" | "dental" | "real_estate" | "other";

function tagBits(cand: CandidateLike): {
  cls?: string; type?: string; shop?: string; amenity?: string; cuisine?: string;
  leisure?: string; healthcare?: string;
  primaryType?: string; gtypes: string[];
} {
  const raw = cand.raw ?? {};
  const ex = raw.extratags ?? {};
  const primaryType = raw.primaryType ? String(raw.primaryType).toLowerCase() : undefined;
  const gtypes = [raw.primaryType, ...(Array.isArray(raw.types) ? raw.types : [])]
    .filter(Boolean)
    .map((s: any) => String(s).toLowerCase());
  return {
    cls: (raw.osm_class ?? raw.class)?.toLowerCase?.(),
    type: (raw.osm_type_tag ?? raw.type)?.toLowerCase?.(),
    shop: ex.shop?.toLowerCase?.(),
    amenity: ex.amenity?.toLowerCase?.(),
    cuisine: ex.cuisine?.toLowerCase?.(),
    leisure: ex.leisure?.toLowerCase?.(),
    healthcare: ex.healthcare?.toLowerCase?.(),
    primaryType,
    gtypes,
  };
}

/** Vertical from *structured* signals only (OSM tags / Google types), or null
 *  when the data can't say — lets callers separate "known" from "guessed" (e.g.
 *  to propagate a confident brand vertical across sparse same-name listings). */
export function structuredVertical(cand: CandidateLike): Vertical | null {
  const { cls, type, shop, amenity, leisure, healthcare, primaryType, gtypes } = tagBits(cand);

  // 1) OSM structured tags
  if (shop && BEAUTY_SHOP.has(shop)) return "salon";
  if (leisure === "spa") return "salon";
  if (healthcare && /aesthetic|cosmetic|dermat|beauty|spa/.test(healthcare)) return "salon";
  if (shop && SMOKE_SHOP.has(shop)) return "smoke_vape";
  if (shop && GROCERY_SHOP.has(shop)) return "grocery";
  if (cls === "shop" || (type && GROCERY_SHOP.has(type))) return "grocery";
  if (amenity && RESTAURANT_AMENITY.has(amenity)) return "restaurant";
  if (cls === "amenity" && type && RESTAURANT_AMENITY.has(type)) return "restaurant";

  // 2) Google Places types — primaryType is the most authoritative single signal
  //    (e.g. "grocery_store", "asian_grocery_store", "indian_restaurant", "spa").
  if (primaryType) {
    if (SMOKE_GTYPE.test(primaryType)) return "smoke_vape";
    if (BEAUTY_GTYPE.test(primaryType)) return "salon";
    if (GROCERY_GTYPE.test(primaryType)) return "grocery";
    if (RESTAURANT_GTYPE.test(primaryType)) return "restaurant";
  }
  if (gtypes.some((t) => SMOKE_GTYPE.test(t))) return "smoke_vape";
  const gGroc = gtypes.some((t) => GROCERY_GTYPE.test(t));
  const gRest = gtypes.some((t) => RESTAURANT_GTYPE.test(t));
  const gBeauty = gtypes.some((t) => BEAUTY_GTYPE.test(t));
  if (gBeauty && !gGroc && !gRest) return "salon";
  if (gGroc && !gRest) return "grocery";
  if (gRest && !gGroc) return "restaurant";

  return null;
}

/** Best-guess vertical for a place. Uses structured signals first, then the
 *  name, defaulting to restaurant only as a last resort. */
/** Vertical from the NAME (and cuisine tag) alone, or null when the name gives no
 *  signal — so callers can escalate to the LLM instead of guessing "restaurant".
 *  A clear smoke/vape name wins, but a cigar BAR/LOUNGE (a venue) does not. */
export function nameVertical(cand: CandidateLike): Vertical | null {
  const name = cand.name ?? "";
  if (SMOKE_NAME.test(name) && !RESTAURANT_NAME.test(name) && !/\b(bar|lounge|grill|kitchen|caf[eé])\b/i.test(name)) return "smoke_vape";
  // An explicit eatery word (grille, restaurant, kitchen, pizzeria…) is unambiguous
  // and wins over generic grocery words like "market" some restaurant names carry.
  if (RESTAURANT_NAME.test(name)) return "restaurant";
  if (GROCERY_NAME.test(name)) return "grocery";
  if (BEAUTY_NAME.test(name)) return "salon";
  if (tagBits(cand).cuisine) return "restaurant"; // cuisine tag, no shop tag → restaurant
  return null;
}

/** Best-guess vertical, DETERMINISTIC. Structured signals first, then the name; a
 *  clear smoke/vape name overrides a generic grocery structured guess. Defaults to
 *  restaurant as a last resort — for the smart (LLM) fallback see detect.ts. */
export function inferVertical(cand: CandidateLike): Vertical {
  const structured = structuredVertical(cand);
  const nv = nameVertical(cand);
  if (structured !== "salon" && nv === "smoke_vape") return "smoke_vape";
  return structured ?? nv ?? "restaurant";
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

// Beauty / med-spa service subtypes (name + Google type signals). Direct-match
// only for similarity (no broad families) — a med spa's like-for-like rival is
// another place offering the same service line.
const BEAUTY_ALIASES: [RegExp, string][] = [
  [/\b(med\s*spa|medspa|medical\s*spa|aesthetics?|esthetic)\b/i, "medspa"],
  [/\b(botox|filler|injectable|dysport|jeuveau|kybella|tox)\b/i, "injectables"],
  [/\b(laser|ipl|coolsculpt|emsculpt|body\s*contour|hair\s*removal)\b/i, "laser_body"],
  [/\b(facial|hydrafacial|skin\s*care|dermaplan|chemical\s*peel|microneedl|derma)\b/i, "skincare"],
  [/\b(lash|brow|microblad|threading|pmu|permanent\s*makeup)\b/i, "lash_brow"],
  [/\b(nails?|mani|pedi|manicure|pedicure)\b/i, "nails"],
  [/\b(hair\s*salon|barber|blowout|balayage|hair\s*care|colorist)\b/i, "hair"],
  [/\b(wax|sugaring)\b/i, "waxing"],
  [/\b(massage|wellness|iv\s*(drip|therapy)|sauna|cryo)\b/i, "wellness"],
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
  const raw = cand.raw ?? {};
  const ex = raw.extratags ?? {};
  const cuisineTag = ex.cuisine ?? cand.category ?? "";
  for (const tok of normalizeCuisine(String(cuisineTag))) {
    if (CUISINES.includes(tok)) found.add(tok);
  }
  // Google Places types carry cuisine too (e.g. "indian_restaurant",
  // "asian_grocery_store" → indian / asian).
  const gtypes = [raw.primaryType, ...(Array.isArray(raw.types) ? raw.types : [])].filter(Boolean);
  for (const gt of gtypes) for (const tok of normalizeCuisine(String(gt))) if (CUISINES.includes(tok)) found.add(tok);
  // origin tag (e.g. cuisine origin country) + explicit halal diet tag
  if (ex.origin) for (const tok of normalizeCuisine(String(ex.origin))) if (CUISINES.includes(tok)) found.add(tok);
  if (ex["diet:halal"] === "yes") found.add("halal");

  const name = cand.name ?? "";
  for (const [re, key] of NAME_ALIASES) if (re.test(name)) found.add(key);

  // Beauty / med-spa service subtypes — from the name + Google types. Kept
  // separate from cuisines; they only match beauty places so they never leak
  // into food classification, and let discovery rank like-for-like (an
  // injectables-led med spa near other injectables clinics).
  const beautyHay = `${name} ${gtypes.join(" ")}`;
  for (const [re, key] of BEAUTY_ALIASES) if (re.test(beautyHay)) found.add(key);
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

// ── format / service-model ──────────────────────────────────────────────────
// SEPARATE from cuisine: *what kind* of food business this is — a food truck, an
// ice-cream shop, a bakery, a cafe, a bar. A truck's real rivals are trucks and
// quick-serve; an ice-cream shop's are dessert places — not every sit-down
// restaurant within 3km. Kept apart from cuisine so it never muddies the cuisine
// families (an Indian truck is still "indian" for cuisine + "food_truck" here).
const FORMAT_NAME: [RegExp, string][] = [
  [/\b(food|taco|coffee|ice\s*cream|burger)\s*truck\b|\btaqueria\s*truck\b|\bfood\s*cart\b|\bfood\s*trailer\b/i, "food_truck"],
  [/\b(ice\s*cream|gelato|gelateria|creamery|scoop\s*shop|frozen\s*yogurt|froyo|kulfi|paleta|soft\s*serve|snow\s*cone|shave[d]?\s*ice)\b/i, "ice_cream"],
  [/\b(dessert|donut|doughnut|cupcake|patisserie|p[aâ]tisserie|mithai|confection|chocolatier|macaron|churro|cheesecake)\b/i, "dessert"],
  [/\b(bakery|bakehouse|bake\s*shop|boulangerie|bagel)\b/i, "bakery"],
  [/\b(caf[eé]|coffee|espresso|roaster|tea\s*house|chai\s*(bar|house|point)|boba|bubble\s*tea)\b/i, "cafe"],
  [/\b(pub|brewery|brewing|brewpub|taproom|tavern|cantina|cocktail|wine\s*bar|beer\s*garden)\b/i, "bar"],
  [/\b(buffet|all\s*you\s*can\s*eat)\b/i, "buffet"],
  [/\b(fine\s*dining|steakhouse|steak\s*house|chophouse)\b/i, "fine_dining"],
];
// Google Places (New) type signals — authoritative single-word format types.
const FORMAT_GTYPE: [RegExp, string][] = [
  [/ice_cream/, "ice_cream"],
  [/dessert|donut|candy_store|chocolate|confectionery/, "dessert"],
  [/bakery|bagel/, "bakery"],
  [/coffee_shop|\bcafe\b|tea_house|cat_cafe/, "cafe"],
  [/\bbar\b|\bpub\b|brewery|wine_bar|beer_garden|night_club/, "bar"],
  [/fast_food/, "fast_food"],
  [/meal_takeaway|meal_delivery/, "quick_serve"],
  [/buffet/, "buffet"],
  [/fine_dining|steak_house/, "fine_dining"],
];
// OSM amenity / shop tag → format.
const FORMAT_OSM_AMENITY: Record<string, string> = {
  ice_cream: "ice_cream", cafe: "cafe", fast_food: "fast_food",
  bar: "bar", pub: "bar", biergarten: "bar", food_truck: "food_truck",
};
const FORMAT_OSM_SHOP: Record<string, string> = {
  bakery: "bakery", pastry: "dessert", confectionery: "dessert", chocolate: "dessert", coffee: "cafe",
};

/** The service-model / format tokens describing a food business (may be empty).
 *  Signals: OSM amenity/shop, Google Places types, then the name. */
export function extractFormat(cand: CandidateLike): string[] {
  const found = new Set<string>();
  const { amenity, shop, gtypes } = tagBits(cand);
  if (amenity && FORMAT_OSM_AMENITY[amenity]) found.add(FORMAT_OSM_AMENITY[amenity]);
  if (shop && FORMAT_OSM_SHOP[shop]) found.add(FORMAT_OSM_SHOP[shop]);
  for (const gt of gtypes) for (const [re, key] of FORMAT_GTYPE) if (re.test(gt)) found.add(key);
  const name = cand.name ?? "";
  for (const [re, key] of FORMAT_NAME) if (re.test(name)) found.add(key);
  return [...found];
}

// Broad families so near-formats still count as similar (ice cream ↔ bakery).
const FORMAT_FAMILY: Record<string, string> = {
  ice_cream: "sweets", dessert: "sweets", bakery: "sweets",
  cafe: "drinks", bar: "drinks",
  fast_food: "quick", quick_serve: "quick", food_truck: "quick",
};

/** 0..1 similarity between two format sets. 1 = same format, 0.6 = same family. */
export function formatSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  for (const x of b) if (sa.has(x)) return 1;
  const fam = (arr: string[]) => new Set(arr.map((x) => FORMAT_FAMILY[x]).filter(Boolean) as string[]);
  const fa = fam(a);
  const fb = fam(b);
  for (const x of fb) if (fa.has(x)) return 0.6;
  return 0;
}

// Clearly non-food retail/service Google place types (and OSM shops) — used to
// drop off-vertical hits (a clothing store, salon…) from a food search without
// nuking generic-typed food businesses. Matches on TYPE, never the name (a
// grocery may be named "…Boutique").
const NONFOOD_TYPE =
  /clothing|apparel|\bshoe|footwear|jewelry|jeweler|beauty_salon|hair_care|hair_salon|nail_salon|barber|\bgym\b|fitness|yoga_studio|\bbank\b|\batm\b|insurance|pharmacy|drugstore|hardware_store|electronics_store|cell_phone|furniture_store|home_goods|car_repair|car_dealer|auto_parts|gas_station|\bfuel\b|lodging|\bhotel\b|motel|real_estate|\bdoctor|dentist|hospital|\bclinic\b|\bschool\b|university|book_store|florist|pet_store|toy_store|travel_agency|laundry|dry_clean|\btailor\b|optician|beauty|cosmetics/;

/** True when a candidate is clearly a non-food business (drop it from food-vertical
 *  discovery). Conservative: only fires on an explicit off-vertical type. */
export function isNonFood(cand: CandidateLike): boolean {
  const { gtypes, shop } = tagBits(cand);
  if (shop && NONFOOD_TYPE.test(shop) && !GROCERY_SHOP.has(shop)) return true;
  return gtypes.some((t) => NONFOOD_TYPE.test(t));
}

/** A short human label for a subtype set, e.g. ["indian"] → "Indian". */
export function subtypeLabel(subtype: string[]): string | undefined {
  if (!subtype.length) return undefined;
  const pretty = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return subtype.slice(0, 2).map(pretty).join(" / ");
}

/** Human label for a vertical (for chips / copy). */
export function verticalLabel(v: Vertical | string | null | undefined): string {
  switch (v) {
    case "grocery": return "Grocery";
    case "salon": return "Beauty & spa";
    case "restaurant": return "Restaurant";
    case "smoke_vape": return "Smoke & vape";
    case "fitness": return "Fitness & gym";
    case "dental": return "Dental";
    case "real_estate": return "Real estate";
    default: return "Business";
  }
}

/** A category phrase to seed a Google Places text query when discovering
 *  competitors for a vertical. EVERY vertical now returns a real query: food
 *  verticals used to return undefined, which sent Google an empty textQuery so
 *  Places returned nothing and discovery fell back to OSM/Nominatim alone (poor
 *  recall — it missed obvious nearby rivals). Cuisine + format sharpen the query
 *  so Places surfaces like-for-like ("indian restaurant", "ice cream shop").
 *  OSM's nearby mode ignores this query (it uses its own category terms), so its
 *  tuned behaviour is unchanged — this only wakes Google up for food. */
export function verticalQuery(v: Vertical | string, subtype: string[] = [], format: string[] = []): string | undefined {
  if (v === "smoke_vape") return "smoke shop OR vape shop OR tobacco shop OR head shop";
  if (v === "fitness") return "gym OR fitness studio OR yoga studio OR pilates OR crossfit";
  if (v === "dental") return "dentist OR dental clinic OR orthodontist";
  if (v === "real_estate") return "real estate agency OR realtor OR real estate broker";
  if (v === "other") return undefined; // no confident query → OSM nearby fallback

  if (v === "salon") {
    const s = new Set(subtype);
    if (s.has("injectables") || s.has("laser_body") || s.has("skincare") || s.has("medspa"))
      return "med spa aesthetics clinic";
    if (s.has("nails")) return "nail salon";
    if (s.has("hair")) return "hair salon";
    if (s.has("lash_brow")) return "lash brow studio";
    if (s.has("wellness")) return "day spa wellness";
    return "med spa OR day spa OR beauty salon OR aesthetics";
  }

  const cuisine = subtype.find((s) => CUISINES.includes(s));
  const cw = cuisine ? cuisine.replace(/_/g, " ") : "";
  const clean = (q: string) => q.trim().replace(/\s+/g, " ");

  if (v === "grocery") return clean(`${cw} grocery store supermarket`);

  // restaurant — the format decides which kind of place to look for.
  const f = new Set(format);
  const base =
    f.has("ice_cream") ? "ice cream shop" :
    f.has("dessert") || f.has("bakery") ? "bakery dessert shop" :
    f.has("cafe") ? "cafe coffee shop" :
    f.has("bar") ? "bar brewery" :
    f.has("food_truck") ? "food truck" :
    "restaurant";
  return clean(`${cw} ${base}`);
}
