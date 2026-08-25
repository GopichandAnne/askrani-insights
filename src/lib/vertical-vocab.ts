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
