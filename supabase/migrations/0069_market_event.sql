-- Market event log — the append-only record of the ARTIFACTS a local market
-- produces over time (companion to market_snapshot's metrics). Each row is a
-- distinct derived artifact — a competitor deal/promo, an ad move, a breakout
-- post, a rising content format, an unmet-demand theme — with the date first
-- seen (and last seen, for duration). This is what makes SEASONALITY queryable:
-- "what deals did local Indian groceries run last Diwali?". DERIVED only (our
-- extracted text/labels) — never raw third-party media — so it stays ToS-clean.
-- Append-only: a row is created once (first_seen_on immutable) and preserved;
-- re-seeing it only extends last_seen_on. Written each cycle by lib/panel.ts.
create table if not exists market_event (
  id uuid primary key default gen_random_uuid(),
  first_seen_on date not null,
  last_seen_on date not null,
  workspace_id uuid references workspace(id) on delete cascade,
  organization_id uuid,
  business_id uuid references business(id) on delete set null,  -- the rival it's about (null = market-level)
  vertical text not null,
  subtype text,
  city text,
  geohash text,
  kind text not null,          -- deal | ad_move | breakout | winning_format | demand
  rival text,                  -- competitor name (denormalized for readability)
  title text not null,         -- the artifact ("Free kheer & gulab jamun for Diwali")
  detail text,
  metric numeric,              -- optional (price, engagement multiple)
  url text,
  fingerprint text not null,   -- kind:rival:title — dedup key within a workspace
  captured_at timestamptz not null default now()
);
-- one row per (workspace, fingerprint): first sighting is preserved, re-sightings
-- extend last_seen_on. Benchmarks/seasonality dedup across workspaces by fingerprint.
create unique index if not exists market_event_ws_fp on market_event (workspace_id, fingerprint);
-- seasonal + geo query axes
create index if not exists market_event_seasonal on market_event (vertical, kind, first_seen_on);
create index if not exists market_event_geo      on market_event (vertical, geohash, first_seen_on);
create index if not exists market_event_org      on market_event (organization_id, first_seen_on);

alter table market_event enable row level security;
drop policy if exists me_read_own on market_event;
create policy me_read_own on market_event for select
  using (organization_id in (select organization_id from org_membership where user_id = auth.uid()));
