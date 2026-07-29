-- ════════════════════════════════════════════════════════════════════════════
-- local-intel — canonical data model
-- Implements guide Section 8 (Canonical Data Model) with the Section 8.2 data
-- principles baked into the schema, not bolted on later:
--   • Never overwrite history (valid_from/valid_to/observed_at/superseded_by)
--   • Raw payload stored separately from normalized facts
--   • Every normalized fact carries provenance, evidence and extraction version
--   • Tenant isolation for private data; public observations shared globally
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "postgis";    -- geography for locations / geo overlap
create extension if not exists "vector";     -- pgvector for canonical-entity embeddings
create extension if not exists "pg_trgm";    -- fuzzy business/entity matching

-- ─── Enumerations ───────────────────────────────────────────────────────────

-- Provenance labels — guide 13.2. Every derived fact traces to one of these.
create type provenance_label as enum (
  'OWNER_AUTHORIZED_API',
  'OFFICIAL_PUBLIC_API',
  'META_BUSINESS_DISCOVERY',
  'MANAGED_PUBLIC_PROVIDER_APIFY',
  'LICENSED_DATASET_BRIGHTDATA',
  'PUBLIC_WEBSITE_HTTP',
  'PUBLIC_WEBSITE_BROWSER',
  'USER_SUBMITTED',
  'MANUAL_ANALYST',
  'INFERRED_FROM_MULTIPLE_SOURCES'
);

-- How firmly a fact is established — surfaced in the UI (guide 6.4 / 10.4).
create type inference_type as enum ('direct', 'inferred', 'corroborated');

create type plan_tier as enum ('starter', 'growth', 'pro', 'agency');

create type member_role as enum ('owner', 'admin', 'member', 'analyst', 'viewer');

create type vertical as enum (
  'restaurant', 'grocery',
  -- expansion framework (guide 7.4), modeled now so entities validate later
  'salon', 'fitness', 'dental', 'real_estate', 'smoke_vape', 'other'
);

create type competitor_relation as enum ('primary', 'secondary', 'aspirational', 'excluded');

create type monitoring_tier as enum ('priority', 'standard', 'discovery');

create type connection_kind as enum ('authorized', 'public');

create type recommendation_status as enum (
  'proposed', 'saved', 'approved', 'launched', 'dismissed', 'expired'
);

create type effort_level as enum ('low', 'medium', 'high');

create type review_status as enum ('pending', 'confirmed', 'corrected', 'rejected');

-- Market event taxonomy — Appendix B.
create type event_group as enum (
  'promotion', 'offering', 'price', 'content', 'reputation', 'operations', 'market'
);

-- ─── Tenancy: organization / membership / workspace ─────────────────────────

create table organization (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  plan                plan_tier not null default 'starter',
  billing_customer_id text,                         -- Stripe customer id
  settings            jsonb not null default '{}',
  created_at          timestamptz not null default now()
);

-- Links Supabase auth.users to an organization with a role.
create table org_membership (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organization(id) on delete cascade,
  user_id         uuid not null,                    -- auth.users.id
  role            member_role not null default 'member',
  created_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index org_membership_user on org_membership(user_id);

create table workspace (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organization(id) on delete cascade,
  name               text not null,
  target_business_id uuid,                           -- FK added after business exists
  vertical           vertical not null default 'restaurant',
  -- market_geometry: the territory this workspace watches (PostGIS polygon).
  market_geometry    geography(Polygon, 4326),
  goals              jsonb not null default '{}',
  -- per-workspace monthly budgets (guide 16.3): provider / ai / storage in USD.
  budgets            jsonb not null default '{"provider":0,"ai":0,"storage":0}',
  created_at         timestamptz not null default now()
);
create index workspace_org on workspace(organization_id);

-- ─── Business graph ─────────────────────────────────────────────────────────

create table business (
  id             uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  category       text,
  subcategory    text,
  vertical       vertical,
  website        text,
  phone          text,
  status         text not null default 'active',     -- active | closed | merged | unverified
  -- confidence in the canonical resolution itself (guide 1.2 onboarding step 2).
  confidence     numeric(5,4) not null default 0.5,
  merged_into    uuid references business(id),       -- dedup: soft-merge, never destroy
  attributes     jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index business_name_trgm on business using gin (canonical_name gin_trgm_ops);
create index business_website on business(website);

alter table workspace
  add constraint workspace_target_business_fk
  foreign key (target_business_id) references business(id);

create table location (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references business(id) on delete cascade,
  address      text,
  geo          geography(Point, 4326),
  timezone     text,
  service_area geography(Polygon, 4326),             -- delivery / catchment area
  is_primary   boolean not null default true,
  created_at   timestamptz not null default now()
);
create index location_business on location(business_id);
create index location_geo on location using gist (geo);

-- Platform handles/URLs for a business (IG, FB, GBP, website, TikTok, Yelp…).
create table external_identity (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references business(id) on delete cascade,
  platform          text not null,                   -- 'instagram' | 'google' | 'website' | ...
  external_id       text,
  url               text,
  handle            text,
  verification_state text not null default 'unverified', -- unverified | observed | owner_verified
  created_at        timestamptz not null default now(),
  unique (business_id, platform, coalesce(external_id, url, handle))
);
create index external_identity_business on external_identity(business_id);
create index external_identity_lookup on external_identity(platform, external_id);

-- Competitor set for a workspace, with explainable component scores (Section 9).
create table competitor_edge (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace(id) on delete cascade,
  competitor_id uuid not null references business(id) on delete cascade,
  relation      competitor_relation not null default 'secondary',
  tier          monitoring_tier not null default 'standard',
  score         numeric(6,4) not null default 0,
  -- component breakdown so the user can understand & edit the set (guide 9.2).
  score_components jsonb not null default '{}',
  rationale     text,
  active_from   timestamptz not null default now(),
  active_to     timestamptz,
  created_at    timestamptz not null default now(),
  unique (workspace_id, competitor_id)
);
create index competitor_edge_workspace on competitor_edge(workspace_id);

-- ─── Source connections & acquisition provenance ────────────────────────────

create table source_connection (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid references organization(id) on delete cascade, -- null = platform-global public source
  business_id       uuid references business(id) on delete set null,
  kind              connection_kind not null,        -- authorized | public
  provider          text not null,                   -- 'website' | 'apify' | 'brightdata' | 'google_gbp' | 'meta' ...
  scopes            text[] not null default '{}',
  credential_ref    text,                             -- Secrets Manager / Supabase Vault reference, NOT the secret
  connected_by      uuid,                             -- auth.users.id (for authorized connectors)
  health            text not null default 'unknown',  -- ok | degraded | failing | revoked
  expires_at        timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index source_connection_org on source_connection(organization_id);

-- Every external run: vendor, cost, versions — powers cost model (16) & replay.
create table provider_run (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  actor_or_job    text,                               -- actor_id / dataset id / endpoint
  input_hash      text not null,                      -- idempotency (guide 5.3)
  result_count    integer,
  cost_usd        numeric(10,4),
  status          text not null default 'started',    -- started | succeeded | failed | partial
  schema_version  text,
  error           text,
  workspace_id    uuid references workspace(id) on delete set null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index provider_run_provider_time on provider_run(provider, started_at desc);
create unique index provider_run_idempotency on provider_run(provider, input_hash);

-- Raw payload stored separately from normalized facts (guide 8.2). Object body
-- lives in Storage; this row is the provenance + pointer + retention class.
create table raw_payload (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null,
  provenance     provenance_label not null,
  source_url     text,
  object_path    text,                                -- Storage key (raw/ prefix)
  content_hash   text not null,                       -- dedup across customers
  provider_run_id uuid references provider_run(id) on delete set null,
  fetched_at     timestamptz not null default now(),
  retention_class text not null default 'standard',   -- standard | media | audit
  created_at     timestamptz not null default now()
);
create unique index raw_payload_dedup on raw_payload(provider, content_hash);

-- ─── Content, evidence, observations ────────────────────────────────────────

-- A post / page / document — the unit that gets processed. Public content_items
-- are shared across workspaces (collect once, reuse many — guide 16.3).
create table content_item (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references business(id) on delete set null,
  platform      text not null,                        -- instagram | website | google | pdf ...
  external_ref  text,                                 -- post id / page url / doc id
  provenance    provenance_label not null,
  url           text,
  text          text,
  media         jsonb not null default '[]',          -- [{media_id, type, storage_path, perceptual_hash}]
  published_at  timestamptz,
  observed_at   timestamptz not null default now(),
  raw_payload_id uuid references raw_payload(id) on delete set null,
  -- fingerprints for change detection & dedup (guide 5.4 / 8.2)
  dom_hash      text,
  perceptual_hash text,
  created_at    timestamptz not null default now(),
  unique (platform, external_ref)
);
create index content_item_business_time on content_item(business_id, published_at desc);

-- Evidence binds an extracted field back to its source span/box/timestamp
-- (guide 6.4). An observation may never exist without evidence (Appendix D).
create table evidence (
  id             uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references content_item(id) on delete cascade,
  kind           text not null,                       -- caption_span | ocr_block | image_bbox | transcript_ts | dom_element
  -- bbox as [x,y,w,h] normalized 0..1; span as {start,end}; ts as seconds.
  locator        jsonb not null default '{}',
  text           text,
  media_id       text,
  created_at     timestamptz not null default now()
);
create index evidence_content on evidence(content_item_id);

-- Typed facts. History-preserving: new values supersede, never overwrite.
create table observation (
  id               uuid primary key default gen_random_uuid(),
  content_item_id  uuid references content_item(id) on delete set null,
  business_id      uuid not null references business(id) on delete cascade,
  observation_type text not null,                     -- 'offer' | 'hours_change' | 'rating_change' | ...
  value            jsonb not null,
  confidence       numeric(5,4) not null,
  inference        inference_type not null default 'direct',
  provenance       provenance_label not null,
  schema_version   text not null,
  model_version    text,
  observed_at      timestamptz not null,
  valid_from       timestamptz,
  valid_to         timestamptz,
  superseded_by    uuid references observation(id),
  -- review routing when confidence is below the auto-publish threshold (6.4).
  review           review_status not null default 'confirmed',
  created_at       timestamptz not null default now()
);
create index observation_business_type_time
  on observation(business_id, observation_type, observed_at desc);
create index observation_review_open on observation(review) where review = 'pending';

-- Many evidence rows can support one observation.
create table observation_evidence (
  observation_id uuid not null references observation(id) on delete cascade,
  evidence_id    uuid not null references evidence(id) on delete cascade,
  primary key (observation_id, evidence_id)
);

-- ─── Canonical taxonomy (products / dishes / services / events) ─────────────

create table canonical_entity (
  id          uuid primary key default gen_random_uuid(),
  vertical    vertical not null,
  kind        text not null,                          -- 'dish' | 'product' | 'service' | 'event'
  name        text not null,
  aliases     text[] not null default '{}',
  attributes  jsonb not null default '{}',            -- cuisine, brand, size_unit, dietary_tags…
  -- embedding for fuzzy linking (guide 6.4 catalog validation / 9.1 overlap).
  embedding   vector(1536),
  created_at  timestamptz not null default now()
);
create index canonical_entity_name_trgm on canonical_entity using gin (name gin_trgm_ops);
create index canonical_entity_vertical_kind on canonical_entity(vertical, kind);
-- ANN index for embedding similarity (cosine).
create index canonical_entity_embedding on canonical_entity
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ─── Offers, events, benchmarks ─────────────────────────────────────────────

create table offer (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references business(id) on delete cascade,
  content_item_id     uuid references content_item(id) on delete set null,
  canonical_entity_id uuid references canonical_entity(id) on delete set null,
  entity_text         text not null,                  -- keep original label (guide 8.2)
  offer_type          text,                           -- sale | combo | happy_hour | new_dish ...
  pricing             jsonb not null default '{}',    -- {type, amount, currency, unit, conditions[]}
  conditions          text[] not null default '{}',
  validity_start      date,
  validity_end        date,
  confidence          numeric(5,4) not null default 0.5,
  provenance          provenance_label not null,
  observed_at         timestamptz not null default now(),
  valid_from          timestamptz not null default now(),
  valid_to            timestamptz,                    -- price history: closed when superseded
  superseded_by       uuid references offer(id),
  created_at          timestamptz not null default now()
);
create index offer_business_time on offer(business_id, observed_at desc);
create index offer_entity on offer(canonical_entity_id);

create table market_event (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references workspace(id) on delete cascade,
  business_id   uuid references business(id) on delete set null,
  event_group   event_group not null,
  event_type    text not null,                        -- Appendix B specific type
  significance  numeric(5,4) not null default 0.5,
  summary       text,
  details       jsonb not null default '{}',
  time_start    timestamptz,
  time_end      timestamptz,
  created_at    timestamptz not null default now()
);
create index market_event_workspace_time on market_event(workspace_id, created_at desc);

create table benchmark (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  metric       text not null,                         -- posting_cadence | promo_mix | rating ...
  peer_set     jsonb not null default '{}',           -- which competitors are in the comparison
  subject_value numeric,
  percentile   numeric(5,2),
  period_start date,
  period_end   date,
  computed_at  timestamptz not null default now()
);
create index benchmark_workspace_metric on benchmark(workspace_id, metric, computed_at desc);

-- ─── Recommendations, campaigns, outcomes ───────────────────────────────────

create table recommendation (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspace(id) on delete cascade,
  category        text not null,                      -- promotion | content | pricing | menu ... (10.1)
  title           text not null,
  action          text not null,
  why_now         jsonb not null default '[]',        -- string[] rationale bullets
  evidence_ids    uuid[] not null default '{}',       -- observation/benchmark ids
  expected_impact jsonb not null default '{}',        -- {metric, range_pct:[lo,hi], confidence}
  effort          effort_level not null default 'medium',
  urgency         text,                               -- this_week | this_month | watch
  priority        numeric(10,4) not null default 0,   -- scoring output (10.2)
  experiment      jsonb,                              -- {primary_metric, guardrail, duration_days}
  status          recommendation_status not null default 'proposed',
  dismissal_reason text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index recommendation_workspace_status on recommendation(workspace_id, status, priority desc);

create table campaign (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id) on delete cascade,
  recommendation_id uuid references recommendation(id) on delete set null,
  brief        text,
  assets       jsonb not null default '[]',
  channels     text[] not null default '{}',
  schedule     jsonb not null default '{}',
  status       text not null default 'draft',
  created_at   timestamptz not null default now()
);
create index campaign_workspace on campaign(workspace_id);

create table outcome (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspace(id) on delete cascade,
  recommendation_id uuid references recommendation(id) on delete set null,
  campaign_id     uuid references campaign(id) on delete set null,
  metrics         jsonb not null default '{}',
  revenue         numeric(12,2),
  user_feedback   text,
  recorded_at     timestamptz not null default now()
);
create index outcome_workspace on outcome(workspace_id);

-- ─── Human review / correction queue (guide 6.4, ticket 20) ─────────────────

create table correction (
  id              uuid primary key default gen_random_uuid(),
  observation_id  uuid references observation(id) on delete cascade,
  offer_id        uuid references offer(id) on delete cascade,
  field           text,
  old_value       jsonb,
  new_value       jsonb,
  corrected_by    uuid,                               -- auth.users.id (analyst) or null for customer
  note            text,
  -- corrections become labeled training examples (guide 6.4 "Human correction").
  becomes_label   boolean not null default true,
  created_at      timestamptz not null default now()
);
create index correction_observation on correction(observation_id);

-- updated_at trigger for recommendation
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger recommendation_updated_at
  before update on recommendation
  for each row execute function set_updated_at();
