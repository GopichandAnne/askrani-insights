-- ═══════════════════════════════════════════════════════════════════════════
-- 0077 — monitor_queue: the superadmin's curated monitoring-candidate list.
--
-- The monitoring queue (/monitor/queue) lets the operator confirm/correct each
-- business's social handles + facets before collecting. Those edits must SURVIVE a
-- reload — "I fixed a handle you got wrong, come back later, it's still fixed" — so
-- the whole candidate list is persisted here as one JSON document (a small,
-- single-operator ops list; no need for per-row rows). Seeded from a code default on
-- first load; every edit overwrites the document.
--
-- Service-role only (RLS on, no policy) — the page is superadmin-gated and reads/
-- writes with the service key.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists monitor_candidate (
  id          text primary key default 'default',
  candidates  jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table monitor_candidate enable row level security; -- no policy = service-role only
