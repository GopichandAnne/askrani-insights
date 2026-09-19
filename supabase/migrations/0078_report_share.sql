-- ═══════════════════════════════════════════════════════════════════════════
-- 0078 — report_share: a public, tokenized share link for a workspace's report.
--
-- The Insights launch lead magnet: we mint an unguessable token that maps to a
-- workspace, and email `insights.askrani.ai/r/<token>` to a prospect. The page is
-- PUBLIC (no login) and shows the read-only market read. On "Claim" (P1), the
-- token binds the workspace to the account that signs up through it.
--
-- Service-role only (RLS on, no policy): the public page reads by token via the
-- service key (there's no user session to scope it), and minting is admin-only.
-- Nothing here is user-writable directly.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists report_share (
  id            uuid primary key default gen_random_uuid(),
  token         text unique not null,                 -- URL-safe random, ≥128-bit
  workspace_id  uuid not null references workspace(id) on delete cascade,
  status        text not null default 'active',       -- active | revoked
  created_by    uuid,                                 -- our admin (auth.users id)
  claimed_by    uuid,                                 -- set on claim (P1)
  claimed_at    timestamptz,
  view_count    integer not null default 0,
  expires_at    timestamptz,                          -- optional link expiry
  created_at    timestamptz not null default now()
);

create index if not exists report_share_workspace_idx on report_share (workspace_id);

alter table report_share enable row level security; -- no policy = service-role only
