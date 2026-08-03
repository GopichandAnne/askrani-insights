-- First-party, cookieless product analytics. Server-side only; captures funnel
-- milestones (explore searches, signups, workspace creation, collection starts)
-- so we own the numbers without a third party or a consent banner.
--
-- Apply: paste this into the Supabase SQL editor and run (no PII is stored;
-- props holds only coarse, non-identifying context).

create table if not exists public.analytics_event (
  id          uuid primary key default gen_random_uuid(),
  event       text not null,
  path        text,
  org_id      uuid references public.organization(id) on delete set null,
  props       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists analytics_event_event_time_idx
  on public.analytics_event (event, created_at desc);
create index if not exists analytics_event_time_idx
  on public.analytics_event (created_at desc);

-- Writes/reads go through the service-role key (server-side only); no anon access.
alter table public.analytics_event enable row level security;
