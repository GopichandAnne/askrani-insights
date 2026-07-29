# Architecture — guide → code map

How each section of the *Local Business Intelligence Platform* implementation
guide maps onto this codebase. Status legend:

- **Built** — implemented and verified in this repo.
- **Partial** — core implemented; documented extension points remain.
- **Scaffolded** — interface + shape in place, activates with keys/contract.
- **Deferred** — intentionally not built yet (with reason).

The build strategy is **thin vertical slice first**: one real thread through
every layer, narrow before wide. That's why (e.g.) the restaurant module is deep
while grocery is a registry entry, and the website adapter is real while social
adapters are key-gated.

| Guide section | Status | Where |
|---|---|---|
| **1. Product scope & personas** | Partial | Public-tier value is live (no auth needed to analyze); authorized tier deferred with Meta. |
| **2. Modules & user journeys** | Partial | Onboarding journey (2.2) runs live in `app/onboarding`; weekly loop (2.3) is the pipeline + engine, not yet scheduled. |
| **3. Vendor & data-source strategy** | Built (framework) | `lib/providers/*` — adapter per source, provenance labels, cost estimates. Website real; Google real (key-gated); Apify real (key-gated); Bright Data scaffolded. |
| **4. System architecture** | Adapted | Guide's FastAPI/Temporal/ECS mapped to Next.js + Supabase per decision. Services (4.2) become route handlers + `lib` modules + (future) queue workers. |
| **5. Data acquisition & orchestration** | Partial | Source hierarchy (5.1) + collection policies (5.2) encoded; website crawler strategy (5.4) fully built; Temporal workflow (5.3) → a scheduler adapter is the next increment. |
| **6. Multimodal content intelligence** | Built | `lib/extraction/*` — pipeline (6.1), content types (6.2), extraction contract (6.3), accuracy controls incl. confidence thresholds + validation + review routing (6.4). |
| **7. Vertical intelligence modules** | Partial | Shared `VerticalModule` interface (7.1); restaurant module deep (7.3); grocery + expansion (7.2/7.4) are registry slots. |
| **8. Canonical data model** | Built | `supabase/migrations/0001_core_schema.sql` — all §8.1 entities, §8.2 principles (history, provenance, tenant isolation), §8.3 example tables. |
| **9. Competitor graph & discovery** | Partial | `discoverCandidates` merges/ranks across adapters; `competitor_edge` stores explainable `score_components`. Full ranking model (9.2) is the next engine to wire on persist. |
| **10. Recommendation & decision engine** | Built | `lib/recommend/engine.ts` — taxonomy (10.1), priority scoring (10.2), recommendation object (10.3), guardrails (10.4: no guaranteed revenue, value-over-price-match, evidence-bound). |
| **11. Customer-authorized intelligence** | Deferred | Schema + connector shape present (`source_connection`). Live OAuth (incl. Meta) not wired — per decision. |
| **12. Application, API & UX** | Partial | Screens (12.1): Today, feed, offers, competitors, recommendations, onboarding, admin. `TrustChip` enforces "always show source + confidence". REST API (12.2) is the next surface. |
| **13. Security, privacy, compliance** | Partial | RLS tenant isolation (13.1) in `0002_rls.sql`; provenance labels (13.2) as a Postgres enum + on every observation. Secrets/rotation/DPA are ops workstreams. |
| **14. Infra, DevOps, observability** | Partial | Local dev runs today; CI gates (14.2) incl. fixture contract tests started (`selftest`). Metrics (14.3) map to `provider_run` + PostHog later. |
| **15. QA & evaluation** | Partial | `selftest` is the seed of the golden-dataset harness (15.1); metric thresholds (15.2) are the acceptance targets to build the eval runner against. |
| **16. Cost model & pricing guardrails** | Partial | `provider_run.cost_usd` + `estimateCost()` implement "compute actual marginal cost, don't hard-code prices" (16.1). Per-workspace `budgets` column for 16.3 caps. |
| **17. Roadmap & team** | Reference | This slice covers Phase 0 + the core of Phase 1 (restaurant instead of grocery, per decision). |
| **18. Runbooks** | Reference | Provider degradation / extraction-quality / OAuth-failure procedures are the operational targets; canary + health surface exists at `/admin`. |
| **App. A Provider adapter contract** | Built | `lib/providers/types.ts` mirrors the interface verbatim. |
| **App. B Event types** | Built (enum) | `event_group` enum + `market_event.event_type`. Event *detection* wires on persisted history. |
| **App. C Extraction prompt blueprint** | Built | `RestaurantModule.buildSystemPrompt` + validator pass in `pipeline` / `restaurant.validate`. |
| **App. D API acceptance criteria** | Enforced (schema) | "No observation without evidence", history preserved, provider/model versions queryable — enforced by the data model + pipeline. |

## Key design choices

**Every source is replaceable.** Downstream code never sees a provider's native
shape — adapters emit `RawObservation` (guide 3.2/8.2). Adding a source = one
adapter file + one line in `registry.ts`.

**Cheapest stage that answers the question.** The pipeline trusts JSON-LD/menu
markup directly (no model cost) and only invokes the multimodal model on
unstructured content (guide 16.3 tiering). Verified in `selftest`.

**Never hide uncertainty.** Confidence + inference type + provenance ride on
every observation and render via `TrustChip` everywhere (guide Final Principles).

**Model provider is swappable.** Claude is primary; OpenAI is a drop-in
secondary behind `lib/extraction/llm.ts` (guide 3.1).

**Deferred: live Meta connector.** The authorized-intelligence schema and
connector abstraction exist; only the live Meta OAuth (app-review-gated) is left
unwired — the single explicit exclusion.

## Done since foundation

- **Auth + persistence** ✅ — Supabase Auth (email+password), session-refresh
  middleware, org bootstrap on first sign-in (`lib/auth.ts`), and
  `persistAnalysis` (`lib/persist.ts`) writing businesses, content_items, offers,
  competitor_edges and recommendations into the canonical model. Onboarding
  auto-saves when signed in.
- **Read screens wired** ✅ — feed / offers / competitors / recommendations read
  the signed-in user's active workspace via the RLS client; recommendations
  support approve / save / dismiss (with recorded reason).

## The next increment (in order)

1. **Scheduled monitoring** — a collection scheduler (cron/queue) running
   `BusinessMonitoringWorkflow`-equivalent runs per policy (guide 5.2/5.3),
   writing to `provider_run` + `raw_payload` + the pipeline, so the feed grows
   without a manual re-run.
2. **Event & significance detection** — diff new observations against history to
   emit `market_event` rows (Appendix B) into the feed.
3. **Competitor discovery v1** persisted with full `score_components` (guide 9.2)
   instead of onboarding's offer-overlap-only score.
4. **Playwright fallback** for JS-only sites (hook marked in `crawler.ts`).
5. **Grocery module**, then §7.4 expansion verticals.
