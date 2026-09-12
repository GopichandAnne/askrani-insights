# Time-awareness of dated opportunities

Anything the product presents as *an opportunity the owner should act on* that is tied
to a date — a festival, a holiday, a seasonal item — must be gated on the calendar, not
surfaced merely because the signal exists. A competitor's **past** Raksha Bandhan promo
must not appear as a current opportunity in September.

The dated calendar is `src/lib/occasions.ts`. It is the single source of truth:
- `upcomingOccasionsAll(now, windowDays, limit)` — upcoming occasions only (`inDays ≥ 0`).
- `nearestOccasion(text, now)` — resolves a free-text festival mention (e.g. "Celebrate
  Rakhi", "welcome Ganpati Bappa home") to the calendar occurrence **nearest today**, with
  a **signed** day count (negative = passed, positive = upcoming). Use this to tell a past
  festival from an upcoming one.

Festival dates for the lunar/observance occasions are **approximate to the day and must be
verified and refreshed yearly** (see the `FIXED` table). The past-vs-upcoming *gate* is
robust to a few days' drift; only the "in N days" label needs the precise date.

## Audit — every pillar that touches time-bound content

Swept 2026-09-12. Result: the "past festival as a current opportunity" bug existed in
exactly one place (the detector) and is fixed; every other time-bound surface is safe by
construction.

| Pillar | How it handles time | Verdict |
|---|---|---|
| `fallingbehind.ts` | festival-shaped concepts require a still-upcoming occasion (75-day run-up, 3-day grace) via `nearestOccasion`; past-only ones dropped, kept ones reframed to the occasion + timing and urgency-ranked. Stamps `freshestAt`. | **fixed** (was the bug) |
| `contentplan.ts` | `upcomingOccasions(…45d)` — only upcoming occasions offered to the model | safe (calendar-driven) |
| `festival.ts` | `upcomingOccasionsAll(75)` — upcoming-only (reference implementation) | safe |
| `digest.ts` (festival lane) | reads the time-aware festival pillar, filters `inDays ≤ 30`; plans are `inDays ≥ 0` by construction | safe |
| `attention.ts` | ingests `buildDigest(...).items`, so its "occasion" card *is* the time-aware festival lane; competitor price-drops use `recencyBoost` on timestamps | safe |
| `trending.ts` | recency `cutoff = now − days` window | safe |
| `winning.ts` / `demand.ts` | offering-gaps (catering, kids menu) — not date-bound | out of scope |

Traced chains: `attention → buildDigest → goals.festival → upcomingOccasionsAll` (upcoming
only), and `festival.ts` only ever feeds the LLM occasions with `inDays ≥ 0`. So no past
festival can reach the owner through digest or attention.

## Known minor (not fixed)

`deals.ts` / the digest deals lane *report* recent competitor posts with a free-text `when`
("thru Sunday"). A rival's recently-captured festival promo shows as *recent competitor
activity* (reporting), not as a dated recommendation for the owner — and it's regenerated
from recent captures. Low severity. If deals should also drop expired-occasion promos,
gate the deals lane on `nearestOccasion` the same way `fallingbehind` does.

## Rule for new features

Before surfacing anything a festival/holiday/season makes actionable, resolve it through
`occasions.ts` and gate on upcoming — never on signal presence alone.
