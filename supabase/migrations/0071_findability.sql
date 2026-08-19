-- 0071_findability — the Findability feature's collection tables. Tracks where a
-- workspace's TARGET business ranks in Google search for the real-world terms
-- customers actually type, per keyword, over time — measured against the same
-- competitor set. Snapshots are append-only (one immutable row per
-- workspace×keyword×day) so the signal compounds into the market data asset, the
-- same discipline as market_snapshot. Populated by the metered refresh engine
-- (weekly cron, plan-included; on-demand, credit-charged) — never on render.

-- The tracked search terms per workspace (LLM-generated from the business profile,
-- owner-confirmable later). intent tiers + a revenue weight drive the score.
create table if not exists findability_keyword (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspace(id) on delete cascade,
  organization_id uuid not null,
  term            text not null,                     -- e.g. "emergency dentist round rock"
  intent          text not null default 'everyday',  -- everyday | urgent | high_value
  value_weight    numeric(3,1) not null default 1.0, -- revenue weight (high-value ~3)
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (workspace_id, term)
);
create index if not exists fk_ws_active on findability_keyword(workspace_id) where active;

alter table findability_keyword enable row level security;
drop policy if exists fk_read_own on findability_keyword;
create policy fk_read_own on findability_keyword for select
  using (organization_id in (select organization_id from org_membership where user_id = auth.uid()));

-- One immutable metrics row per (workspace, keyword, day): where you ranked, how
-- confident (did the repeat runs agree?), and where each competitor ranked.
create table if not exists findability_snapshot (
  id               uuid primary key default gen_random_uuid(),
  captured_on      date not null,
  workspace_id     uuid not null references workspace(id) on delete cascade,
  organization_id  uuid not null,
  keyword_id       uuid not null references findability_keyword(id) on delete cascade,
  term             text not null,
  intent           text not null default 'everyday',
  your_rank        integer,                        -- null = not in the top results
  confidence       boolean not null default true,  -- repeat runs agreed
  results_count    integer,
  top_competitor   text,                           -- best-ranked competitor (or #1 result)
  competitor_ranks jsonb not null default '{}',    -- { "<competitor name>": position }
  captured_at      timestamptz not null default now(),
  unique (workspace_id, keyword_id, captured_on)
);
create index if not exists fs_ws_on on findability_snapshot(workspace_id, captured_on);
create index if not exists fs_org_on on findability_snapshot(organization_id, captured_on);

alter table findability_snapshot enable row level security;
drop policy if exists fs_read_own on findability_snapshot;
create policy fs_read_own on findability_snapshot for select
  using (organization_id in (select organization_id from org_membership where user_id = auth.uid()));
