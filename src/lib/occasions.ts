/**
 * A small, deterministic calendar of upcoming occasions — the "timing" input that
 * lets the assistant suggest moves like a real local advisor ("Valentine's is in 9
 * days — run a couples deal"). No external API: fixed dates + nth-weekday / last-
 * weekday rules + Easter (Computus). US-centric for v1. These are for TIMING only,
 * never treated as facts about competitors.
 */

export interface Occasion { name: string; whenISO: string; inDays: number; note: string; audience?: string }

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m, day));
const nthWeekday = (y: number, m: number, weekday: number, n: number) => {
  const first = new Date(Date.UTC(y, m, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(y, m, 1 + shift + (n - 1) * 7));
};
const lastWeekday = (y: number, m: number, weekday: number) => {
  const last = new Date(Date.UTC(y, m + 1, 0));
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(y, m + 1, 0 - shift));
};
const easter = (y: number) => {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, dd = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - dd - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, mth = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mth + 114) / 31), day = ((h + l - 7 * mth + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
};

type Gen = (y: number) => Date;
const OCCASIONS: { name: string; gen: Gen; note: string }[] = [
  { name: "New Year's Day", gen: (y) => d(y, 0, 1), note: "fresh-start / new-year offers" },
  { name: "Valentine's Day", gen: (y) => d(y, 1, 14), note: "couples / date-night angle" },
  { name: "Super Bowl Sunday", gen: (y) => nthWeekday(y, 1, 0, 2), note: "game-day platters, party & group orders" },
  { name: "St. Patrick's Day", gen: (y) => d(y, 2, 17), note: "green / themed special" },
  { name: "Easter", gen: easter, note: "family gatherings, brunch, kids" },
  { name: "Cinco de Mayo", gen: (y) => d(y, 4, 5), note: "festive themed promo" },
  { name: "Mother's Day", gen: (y) => nthWeekday(y, 4, 0, 2), note: "treats/gifts for moms, brunch — a peak day" },
  { name: "Memorial Day", gen: (y) => lastWeekday(y, 4, 1), note: "long-weekend / summer-kickoff deal" },
  { name: "Father's Day", gen: (y) => nthWeekday(y, 5, 0, 3), note: "gifts / treats for dads" },
  { name: "Independence Day", gen: (y) => d(y, 6, 4), note: "cookout / red-white-blue, group orders" },
  { name: "Back to School", gen: (y) => d(y, 7, 15), note: "families, routines, lunch & after-school" },
  { name: "Labor Day", gen: (y) => nthWeekday(y, 8, 1, 1), note: "end-of-summer long-weekend deal" },
  { name: "Halloween", gen: (y) => d(y, 9, 31), note: "costume / themed, kids & families" },
  { name: "Thanksgiving", gen: (y) => nthWeekday(y, 10, 4, 4), note: "pre-orders / catering, gratitude angle" },
  { name: "Black Friday", gen: (y) => new Date(nthWeekday(y, 10, 4, 4).getTime() + 86400000), note: "biggest-deal day, gift cards" },
  { name: "Small Business Saturday", gen: (y) => new Date(nthWeekday(y, 10, 4, 4).getTime() + 2 * 86400000), note: "shop-local, loyal-customer thank-you" },
  { name: "Christmas", gen: (y) => d(y, 11, 25), note: "holiday gifting, pre-orders, catering" },
  { name: "New Year's Eve", gen: (y) => d(y, 11, 31), note: "party / group, celebration menu" },
];

/**
 * Cultural / religious festivals — lunar/observance dates don't follow simple
 * weekday rules, so they're fixed per year (widely-published dates; refresh the
 * table as years roll). Each carries an `audience` cue so the festival PLANNER can
 * pick the ones that fit a given business (Diwali for a desi grocery, Lunar New
 * Year for an Asian market) rather than blasting all of them. Approximate to the
 * day; treat as timing, not a hard religious authority.
 */
const FIXED: { name: string; audience: string; note: string; dates: Record<number, string> }[] = [
  { name: "Lunar New Year", audience: "East/Southeast Asian", note: "festive hampers, red-packet gifting, celebration menus", dates: { 2026: "2026-02-17", 2027: "2027-02-06", 2028: "2028-01-26" } },
  { name: "Ramadan (begins)", audience: "Muslim", note: "iftar bundles, dates & sweets, evening hours — a month-long season", dates: { 2026: "2026-02-18", 2027: "2027-02-08", 2028: "2028-01-28" } },
  { name: "Holi", audience: "South Asian", note: "colors, sweets & snacks, group celebration", dates: { 2026: "2026-03-03", 2027: "2027-03-22", 2028: "2028-03-11" } },
  { name: "Eid al-Fitr", audience: "Muslim", note: "celebration feasts, sweets, gifting — end of Ramadan, a peak day", dates: { 2026: "2026-03-20", 2027: "2027-03-10", 2028: "2028-02-27" } },
  { name: "Vaisakhi", audience: "South Asian (Punjabi/Sikh)", note: "harvest festival, community meals & sweets", dates: { 2026: "2026-04-14", 2027: "2027-04-14", 2028: "2028-04-13" } },
  { name: "Eid al-Adha", audience: "Muslim", note: "feast of sacrifice, meat & catering, family gatherings", dates: { 2026: "2026-05-27", 2027: "2027-05-16", 2028: "2028-05-05" } },
  { name: "Rosh Hashanah", audience: "Jewish", note: "new-year sweets (apples & honey), holiday meals", dates: { 2026: "2026-09-11", 2027: "2027-10-01", 2028: "2028-09-20" } },
  { name: "Navratri / Dussehra", audience: "South Asian", note: "nine nights of festivities, fasting-friendly + sweets", dates: { 2026: "2026-10-20", 2027: "2027-10-09", 2028: "2028-09-27" } },
  { name: "Diwali", audience: "South Asian", note: "sweets, gift boxes & hampers, festive shopping — the biggest season", dates: { 2026: "2026-11-08", 2027: "2027-10-29", 2028: "2028-10-17" } },
  { name: "Día de los Muertos", audience: "Hispanic/Latino", note: "pan de muerto, marigolds, family remembrance", dates: { 2026: "2026-11-02", 2027: "2027-11-02", 2028: "2028-11-02" } },
  { name: "Hanukkah (begins)", audience: "Jewish", note: "eight nights, latkes & sufganiyot, gifting", dates: { 2026: "2026-12-04", 2027: "2027-12-24", 2028: "2028-12-12" } },
];

function inDaysFrom(now: Date, iso: string): number {
  const [y, m, dd] = iso.split("-").map(Number);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.UTC(y, m - 1, dd) - today) / 86400000);
}

/** Every upcoming occasion — the rule-based US calendar PLUS cultural/religious
 *  festivals — within `windowDays`, soonest first, each tagged with an audience.
 *  The planner reasons over these to pick what fits a specific business. */
export function upcomingOccasionsAll(now = new Date(), windowDays = 75, limit = 12): Occasion[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: Occasion[] = [];
  for (const o of OCCASIONS) {
    for (const y of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
      const dt = o.gen(y);
      const inDays = Math.round((Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - today) / 86400000);
      if (inDays >= 0 && inDays <= windowDays) { out.push({ name: o.name, whenISO: dt.toISOString().slice(0, 10), inDays, note: o.note, audience: "general" }); break; }
    }
  }
  for (const f of FIXED) {
    for (const y of [now.getUTCFullYear(), now.getUTCFullYear() + 1, now.getUTCFullYear() + 2]) {
      const iso = f.dates[y];
      if (!iso) continue;
      const inDays = inDaysFrom(now, iso);
      if (inDays >= 0 && inDays <= windowDays) { out.push({ name: f.name, whenISO: iso, inDays, note: f.note, audience: f.audience }); break; }
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays).slice(0, limit);
}

/** Occasions within the next `windowDays`, soonest first — now includes cultural
 *  festivals so downstream LLM callers (content plan, assistant) get the right
 *  timing for diaspora businesses too. `vertical` reserved (callers pass it). */
export function upcomingOccasions(_vertical?: string, now = new Date(), windowDays = 45, limit = 4): Occasion[] {
  return upcomingOccasionsAll(now, windowDays, limit);
}
