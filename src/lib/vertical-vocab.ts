/**
 * Vertical-aware UI copy — so progress messages and keyword examples fit the
 * business type instead of being hardcoded to grocery/restaurant. Client-safe
 * (no server imports); used by the collection banner + the findability panel.
 */

/** Two illustrative search terms for the findability "add a term" hint. */
export function keywordExamples(vertical?: string): string {
  const map: Record<string, string> = {
    restaurant: "rumali roti near me, goat biryani delivery",
    grocery: "fresh paneer near me, indian groceries near me",
    salon: "bridal makeup near me, keratin treatment near me",
    smoke_vape: "vape shop near me, hookah lounge near me",
    fitness: "gym near me, yoga classes near me",
    dental: "dentist near me, teeth whitening near me",
    real_estate: "realtor near me, homes for sale near me",
  };
  return map[vertical ?? ""] ?? "your top offering near me, what you sell near me";
}

// Works for any business type — no shelves/flyers assumptions.
const BASE_PHRASES = [
  "Rani's peeking at the competition 👀",
  "Spotting who just dropped their prices 💸",
  "Scanning fresh posts & photos 📸",
  "Seeing what your rivals are promoting 📣",
  "Reading the latest reviews ⭐",
  "Catching the local buzz 🔍",
];

// A couple of flavor lines per vertical, appended to the base set.
const EXTRA_PHRASES: Record<string, string[]> = {
  restaurant: ["Checking who's got the tastiest specials 🍽️", "Reading the neighbours' menus 📖"],
  grocery: ["Reading the neighbours' sale flyers 🧾", "Peeking at the shelves next door 🫣"],
  salon: ["Seeing who's booked out this week 💇", "Checking the latest looks ✨"],
  smoke_vape: ["Scanning the new arrivals 💨"],
  fitness: ["Checking class schedules & offers 🏋️"],
  dental: ["Reading new-patient offers 🦷"],
  real_estate: ["Watching new listings & prices 🏡"],
};

/** Rotating "what Rani's up to" lines, tuned to the business type. */
export function collectingPhrases(vertical?: string): string[] {
  return [...BASE_PHRASES, ...((vertical && EXTRA_PHRASES[vertical]) ?? [])];
}

/**
 * Vertical-aware guidance for GENERATING findability search terms. The three-mode
 * framing (by signature offering, by category, by intent) is universal; only the
 * examples and what "urgent" / "high-value" MEAN change per business type — so a
 * dentist gets "emergency dentist" / "dental implants", not "delivery" / "catering".
 * No vertical is hardcoded in the generator itself; it reads this map.
 */
export interface FindabilityGuide {
  offeringWord: string;   // what "the thing they sell" is called
  examples: string;       // 4–5 real searches a customer of THIS vertical types
  urgent: string;         // what a time-critical / immediate-need search looks like
  highValue: string;      // what the big-ticket / high-margin search looks like
}
const FINDABILITY_GUIDES: Record<string, FindabilityGuide> = {
  restaurant: {
    offeringWord: "menu items / dishes",
    examples: "'rumali roti near me', 'goat mandi cedar park', 'south indian restaurant near me', 'indian food delivery near me', 'indian catering near me'",
    urgent: "open now / delivery / near me",
    highValue: "catering, party trays, bulk / family packs",
  },
  grocery: {
    offeringWord: "products / departments",
    examples: "'fresh paneer near me', 'halal meat near me', 'indian grocery store near me', 'basmati rice near me', 'indian sweets near me'",
    urgent: "open now / near me / same-day",
    highValue: "bulk / cases, specialty & hard-to-find items, catering trays",
  },
  salon: {
    offeringWord: "treatments / services",
    examples: "'bridal makeup near me', 'keratin treatment near me', 'balayage near me', 'lash extensions near me', 'medspa near me'",
    urgent: "same-day / walk-in / near me",
    highValue: "bridal packages, memberships, injectables, laser & body packages",
  },
  dental: {
    offeringWord: "services / procedures",
    examples: "'dentist near me', 'emergency dentist near me', 'teeth whitening <city>', 'dental implants near me', 'invisalign <city>', 'pediatric dentist near me', 'dentist that takes delta dental'",
    urgent: "emergency / same-day / tooth pain / walk-in / open now",
    highValue: "dental implants, invisalign / braces, veneers, cosmetic dentistry, full smile makeover",
  },
  fitness: {
    offeringWord: "classes / programs",
    examples: "'gym near me', 'yoga classes near me', 'personal trainer near me', 'crossfit <city>', 'pilates near me'",
    urgent: "open now / drop-in / near me / trial class",
    highValue: "personal training, memberships, small-group coaching, transformation programs",
  },
  smoke_vape: {
    offeringWord: "products",
    examples: "'vape shop near me', 'hookah lounge near me', 'disposable vapes near me', 'delta 8 near me', 'cigars <city>'",
    urgent: "open now / near me / open late",
    highValue: "bulk / cases, premium brands, hookah lounge, specialty",
  },
  real_estate: {
    offeringWord: "listings / services",
    examples: "'realtor near me', 'homes for sale <city>', 'sell my house fast <city>', 'first time home buyer agent', 'condos for sale <city>'",
    urgent: "sell my house fast / cash offer / need to sell",
    highValue: "luxury homes, listing agent / sell my home, investment properties",
  },
};
const GENERIC_GUIDE: FindabilityGuide = {
  offeringWord: "services / products",
  examples: "'<what you sell> near me', '<your category> <city>', 'best <what you sell> near me'",
  urgent: "open now / same-day / near me / emergency",
  highValue: "your biggest-ticket or highest-margin offering",
};
export function findabilityGuide(vertical?: string): FindabilityGuide {
  return FINDABILITY_GUIDES[vertical ?? ""] ?? GENERIC_GUIDE;
}
