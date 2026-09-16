/**
 * Deal freshness — turn a flyer deal's free-text validity ("Sep 11-13", "valid thru
 * Sun", "today only") plus WHEN it was posted into a real validity window and a
 * live / expiring / expired status.
 *
 * Fixes the time-blindness where an expired weekend sale (its window already passed)
 * still shows as a current competitor price. Same class of bug as showing a festival
 * that's already over — a DATED signal presented without a recency gate.
 *
 * Pure + defensive: never throws. Parses `terms` on the fly when a deal wasn't
 * pre-annotated, so it fixes existing data too. When validity is genuinely unknown,
 * it falls back to a posted-age window (a weekly grocery flyer stays "live" ~9 days,
 * then a newer week's flyer supersedes it) — and errs toward keeping a deal visible
 * rather than hiding a real one.
 */

export type DealStatus = "live" | "expiring" | "expired" | "upcoming";

export interface DatedDeal {
  terms?: string;
  postedAt?: string;
  seenAt?: string;
  validFrom?: string;
  validTo?: string;
}

const MS_DAY = 86_400_000;
const STALE_DAYS = 9;     // no printed end date → a weekly flyer is good ~9 days
const EXPIRING_DAYS = 2;  // within 2 days of the end → "expiring soon"
const GRACE_DAYS = 1;     // a printed end is often honored a day late

const MONTH: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const DOW: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

function endOfDay(y: number, m: number, d: number): Date | undefined {
  const dt = new Date(y, m, d, 23, 59, 59, 999);
  return isNaN(dt.getTime()) || dt.getMonth() !== ((m % 12) + 12) % 12 ? undefined : dt;
}
function nextDow(from: Date, dow: number): Date {
  const d = new Date(from); const diff = (dow - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff); d.setHours(23, 59, 59, 999); return d;
}

/** Parse a validity window from a deal's free-text `terms`, anchored to postedAt
 *  (for the year and for relative phrases like "this weekend"). */
export function parseValidity(terms?: string, postedAt?: string): { validFrom?: string; validTo?: string } {
  const t = (terms ?? "").toLowerCase().trim();
  if (!t) return {};
  const anchor = postedAt ? new Date(postedAt) : new Date();
  if (isNaN(anchor.getTime())) return {};
  const yr = anchor.getFullYear();
  const iso = (d?: Date) => (d ? d.toISOString() : undefined);

  // 1) numeric range — 9/12-9/14, 09/12 – 09/14, 9/12 to 9/14
  let m = t.match(/(\d{1,2})\/(\d{1,2})\s*(?:[-–—]|to)\s*(\d{1,2})\/(\d{1,2})/);
  if (m) {
    const from = endOfDay(yr, +m[1] - 1, +m[2]); let to = endOfDay(yr, +m[3] - 1, +m[4]);
    if (from && to && to < from) to = endOfDay(yr + 1, +m[3] - 1, +m[4]);
    return { validFrom: iso(from), validTo: iso(to) };
  }
  // 2) month-name range — "sep 11-13", "sep 11th - sep 13th", "september 11 to 13"
  m = t.match(/([a-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:[-–—]|to)\s*(?:([a-z]{3,9})\.?\s*)?(\d{1,2})(?:st|nd|rd|th)?/);
  if (m && MONTH[m[1]] != null) {
    const m1 = MONTH[m[1]]; const m2 = m[3] && MONTH[m[3]] != null ? MONTH[m[3]] : m1;
    const from = endOfDay(yr, m1, +m[2]); let to = endOfDay(yr, m2, +m[4]);
    if (from && to && to < from) to = endOfDay(yr + 1, m2, +m[4]);
    return { validFrom: iso(from), validTo: iso(to) };
  }
  // 3) single end — "thru 9/14", "ends sep 14", "valid until 14"
  m = t.match(/(?:thru|through|til|till|until|ends?|valid\s+(?:thru|through|until|to))\s+(?:([a-z]{3,9})\.?\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:\/(\d{1,2}))?/);
  if (m) {
    if (m[3] != null) return { validTo: iso(endOfDay(yr, +m[2] - 1, +m[3])) };      // thru 9/14
    if (m[1] && MONTH[m[1]] != null) return { validTo: iso(endOfDay(yr, MONTH[m[1]], +m[2])) }; // ends sep 14
    if (m[2] != null) return { validTo: iso(endOfDay(yr, anchor.getMonth(), +m[2])) };          // thru 14 (this month)
  }
  // 4) end on a weekday — "thru sunday", "valid thru sun", "ends fri"
  m = t.match(/(?:thru|through|til|till|until|ends?|valid\s+(?:thru|through|until))\s+([a-z]{3,9})/);
  if (m && DOW[m[1]] != null) return { validTo: iso(nextDow(anchor, DOW[m[1]])) };
  // 5) relative windows
  if (/\btoday(?:\s+only)?\b/.test(t)) { const e = new Date(anchor); e.setHours(23, 59, 59, 999); return { validTo: iso(e) }; }
  if (/\b(?:this\s+)?weekend\b/.test(t)) return { validTo: iso(nextDow(anchor, 0)) };             // through Sunday
  if (/\bthis\s+week\b/.test(t)) return { validTo: iso(new Date(anchor.getTime() + 6 * MS_DAY)) };
  return {};
}

/** live / expiring / expired / upcoming, computed at READ time. Parses `terms` when
 *  the deal wasn't pre-annotated with validTo, so old cached deals get judged too. */
export function dealStatus(deal: DatedDeal, now: Date = new Date()): DealStatus {
  const nowMs = now.getTime();
  let { validFrom, validTo } = deal;
  if (!validTo && !validFrom && deal.terms) { const v = parseValidity(deal.terms, deal.postedAt); validFrom = v.validFrom; validTo = v.validTo; }

  if (validFrom) { const f = new Date(validFrom).getTime(); if (!isNaN(f) && nowMs < f) return "upcoming"; }
  if (validTo) {
    const to = new Date(validTo).getTime();
    if (!isNaN(to)) {
      if (nowMs > to + GRACE_DAYS * MS_DAY) return "expired";
      if (nowMs > to - EXPIRING_DAYS * MS_DAY) return "expiring";
      return "live";
    }
  }
  // no explicit validity → a weekly flyer stays current for ~STALE_DAYS from posting
  const posted = deal.postedAt || deal.seenAt;
  if (posted) {
    const age = (nowMs - new Date(posted).getTime()) / MS_DAY;
    if (!isNaN(age)) {
      if (age > STALE_DAYS + GRACE_DAYS) return "expired";
      if (age > STALE_DAYS - EXPIRING_DAYS) return "expiring";
      return "live";
    }
  }
  return "live"; // everything unknown → don't hide a possibly-real deal
}

/** True when a deal is still worth showing as a CURRENT price (live or expiring). */
export function isLiveDeal(deal: DatedDeal, now: Date = new Date()): boolean {
  const s = dealStatus(deal, now);
  return s === "live" || s === "expiring";
}

/** Keep only currently-valid deals — drops expired and not-yet-started (upcoming).
 *  Generic over the caller's row type (which carries extra fields like rival/item). */
export function liveDeals<T extends object>(deals: T[] | undefined, now: Date = new Date()): T[] {
  return (deals ?? []).filter((d) => isLiveDeal(d as DatedDeal, now));
}

/** Short human freshness label for display: "ends today", "thru Sun", "thru Sep 20". */
export function freshnessLabel(deal: DatedDeal, now: Date = new Date()): string | undefined {
  let { validTo } = deal;
  if (!validTo && deal.terms) validTo = parseValidity(deal.terms, deal.postedAt).validTo;
  if (validTo) {
    const to = new Date(validTo);
    if (!isNaN(to.getTime())) {
      const days = Math.ceil((to.getTime() - now.getTime()) / MS_DAY);
      if (days < 0) return "ended";
      if (days === 0) return "ends today";
      if (days === 1) return "ends tomorrow";
      if (days <= 6) return `thru ${to.toLocaleDateString("en-US", { weekday: "short" })}`;
      return `thru ${to.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    }
  }
  if (deal.postedAt) { const p = new Date(deal.postedAt); if (!isNaN(p.getTime())) return `posted ${p.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`; }
  return undefined;
}
