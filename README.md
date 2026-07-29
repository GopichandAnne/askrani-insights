# local-intel

A local-business intelligence platform: monitor publicly available local-business
activity, turn unstructured content (websites, menus, flyers, reviews, social
posts) into **vertical-specific structured intelligence**, and recommend the next
best action — every observation carrying its source, observed time and confidence.

Built from the *Local Business Intelligence Platform — End-to-End Implementation
Guide*. This repo is the **working foundation**: one real, verified thread through
every layer (discover → collect → extract → benchmark → recommend), with the
provider/vertical/model layers structured for expansion. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the section-by-section map of
what's built, stubbed, and deferred.

**First vertical:** restaurant.
**Stack:** Next.js (App Router) + Supabase (Postgres + PostGIS + pgvector) + Claude.
**Deferred by decision:** live Meta OAuth connector (schema/shape kept; connector not wired).

---

## Quick start

```bash
npm install
cp .env.example .env.local     # fill in keys (see below)
npm run dev                    # http://localhost:3000
```

The app runs with **zero keys** — the website crawler and the whole intelligence
pipeline work without any paid account. Add keys to unlock more sources/models.

### Verify it works (no accounts needed)

```bash
npm run selftest               # deterministic: JSON-LD → offers → recommendations
npm run crawl -- https://example.com 3   # exercise the live website crawler
```

Then open **/onboarding**, enter your restaurant's website + a few competitor
URLs, and hit *Run live analysis* — it crawls each site, extracts structured
offers, benchmarks you, and produces prioritized recommendations, all live.

---

## Environment / keys

| Key | Unlocks | Needed to run? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `..._ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Persistence, auth, RLS tenant isolation | For saving data |
| `ANTHROPIC_API_KEY` | Multimodal extraction (captions, flyers, images, videos) | For the AI layer |
| `OPENAI_API_KEY` | Optional secondary model behind the same abstraction | No |
| `GOOGLE_MAPS_API_KEY` | Google Places **discovery** + **Reviews/Photos** adapter | No |
| `APIFY_TOKEN` | Public IG/FB/TikTok collection (Apify Actors) | No |
| `BRIGHTDATA_API_TOKEN` | Enterprise fallback / bulk datasets (skeleton) | No |

Adapters **self-activate** when their key is present and are otherwise omitted
(see `/admin` for live provider health). Nothing hard-fails on a missing key.

---

## Supabase setup

1. Create a Supabase project. Enable extensions are handled by the migration.
2. Apply migrations (either via the SQL editor, or the CLI):

```bash
supabase link --project-ref <your-ref>
supabase db push          # applies supabase/migrations/*.sql
# then optionally load starter taxonomy:
#   run supabase/seed.sql in the SQL editor
```

The schema (`supabase/migrations/0001_core_schema.sql`) is the canonical data
model (guide §8); `0002_rls.sql` enforces tenant isolation (guide §13.1).

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run selftest` | End-to-end intelligence-layer test with fixtures |
| `npm run crawl -- <url> [maxPages]` | Run the website crawler and print normalized observations |

---

## Layout

```
src/
  app/                     # Next.js routes (Today, feed, offers, competitors,
                           #   recommendations, onboarding, admin)
  components/              # TrustChip (confidence/provenance), ComingOnline
  lib/
    supabase/              # RLS-enforced client/server + service-role worker client
    providers/             # adapter framework — every source behind one interface
      website/             #   real: crawler + JSON-LD/menu/PDF extraction
      google/              #   real (key-gated): Places discovery + reviews/photos
      apify/  brightdata/  #   social collection (key-gated)
      registry.ts          #   the only place adapters are instantiated
    extraction/            # LLM abstraction, extraction contract, vertical
                           #   modules (restaurant), validation, pipeline
    recommend/             # decision engine (priority scoring, guardrails)
supabase/migrations/       # canonical data model + RLS
scripts/                   # crawl + selftest runners
docs/ARCHITECTURE.md       # guide §1–18 → code map, and what's next
```

## What's next (see ARCHITECTURE.md for detail)

- Auth + persistence: sign-in, org/workspace creation, persist the onboarding
  analysis into the schema (currently an ephemeral live preview).
- Continuous monitoring: schedule collection runs (the guide's Temporal
  `BusinessMonitoringWorkflow`; a queue/cron adapter for the Supabase stack).
- Wire the data screens (feed/offers/competitors/recommendations) to persisted rows.
- Playwright rendering fallback for JS-only sites (hook is marked in the crawler).
- Grocery vertical module; then the §7.4 expansion verticals.
