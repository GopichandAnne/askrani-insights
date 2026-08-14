/**
 * A small, deterministic calendar of upcoming occasions — the "timing" input that
 * lets the assistant suggest moves like a real local advisor ("Valentine's is in 9
 * days — run a couples deal"). No external API: fixed dates + nth-weekday / last-
 * weekday rules + Easter (Computus). US-centric for v1. These are for TIMING only,
 * never treated as facts about competitors.
 */

export interface Occasion { name: string; whenISO: string; inDays: number; note: string }

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

/** Occasions within the next `windowDays`, soonest first. `vertical` is reserved
 *  for future per-vertical filtering; today all listed occasions are broadly useful. */
export function upcomingOccasions(_vertical?: string, now = new Date(), windowDays = 45, limit = 4): Occasion[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: Occasion[] = [];
  for (const o of OCCASIONS) {
    for (const y of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
      const dt = o.gen(y);
      const inDays = Math.round((Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - today) / 86400000);
      if (inDays >= 0 && inDays <= windowDays) { out.push({ name: o.name, whenISO: dt.toISOString().slice(0, 10), inDays, note: o.note }); break; }
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays).slice(0, limit);
}
