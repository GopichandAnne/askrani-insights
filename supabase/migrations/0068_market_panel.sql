-- Market panel — the append-only, compounding data asset. One immutable metrics
-- row per (workspace, business, day). METRICS ONLY (no raw third-party text) so
-- it's aggregatable and free of Google/Yelp/Meta resale-ToS issues. Written each
-- collection cycle by lib/panel.ts (snapshotMarket), never overwritten/deleted.
create table if not exists market_snapshot (
  id uuid primary key default gen_random_uuid(),
  captured_on date not null,
  business_id uuid not null references business(id) on delete cascade,
  workspace_id uuid references workspace(id) on delete set null,
  organization_id uuid,
  vertical text not null,
  subtype text,
  city text,
  geohash text,                       -- ~5-char = neighborhood market cell
  is_target boolean not null default false,
  rating numeric(2,1),
  review_count integer,
  rating_rank integer,                -- workspace-relative (within its set)
  market_size integer,
  avg_price numeric(10,2),
  price_index numeric(6,3),
  discoverability_pct integer,
  platforms text[],
  deals_active integer,
  ads_active integer,
  post_cadence_7d numeric(7,2),
  avg_engagement numeric(14,2),
  top_themes jsonb,
  top_formats jsonb,
  extra jsonb,
  captured_at timestamptz not null default now()
);

-- append-only grain: one snapshot per (workspace, business, day). A business
-- that's a target in its own workspace AND a competitor in another is recorded
-- correctly from each perspective (is_target/rank are workspace-relative).
-- Benchmarks dedup by business_id.
drop index if exists market_snapshot_biz_day; -- earlier (business_id, captured_on) grain
create unique index if not exists market_snapshot_ws_biz_day on market_snapshot (workspace_id, business_id, captured_on);
-- the three query axes for benchmarks
create index if not exists market_snapshot_market on market_snapshot (vertical, geohash, captured_on);
create index if not exists market_snapshot_org    on market_snapshot (organization_id, captured_on);

-- org members read their own rows; writes are service-role only
alter table market_snapshot enable row level security;
drop policy if exists ms_read_own on market_snapshot;
create policy ms_read_own on market_snapshot for select
  using (organization_id in (select organization_id from org_membership where user_id = auth.uid()));
