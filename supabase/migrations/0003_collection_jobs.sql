-- ════════════════════════════════════════════════════════════════════════════
-- Collection job queue — background/queued monitoring (guide §5.3).
-- The client enqueues jobs; a worker drains them, so collection no longer
-- blocks the browser. One job = collect one business for one workspace.
-- ════════════════════════════════════════════════════════════════════════════

create type job_status as enum ('pending', 'running', 'done', 'error');

create table collection_job (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace(id) on delete cascade,
  business_id   uuid not null references business(id) on delete cascade,
  status        job_status not null default 'pending',
  priority      integer not null default 0,   -- target business collected first
  attempts      integer not null default 0,
  result        jsonb,
  error         text,
  claimed_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- one active (pending/running) job per (workspace, business) — enqueue is idempotent
create unique index collection_job_active_uniq
  on collection_job(workspace_id, business_id)
  where status in ('pending', 'running');

create index collection_job_pending
  on collection_job(status, priority desc, created_at)
  where status = 'pending';
create index collection_job_workspace on collection_job(workspace_id, created_at desc);

create trigger collection_job_updated_at
  before update on collection_job
  for each row execute function set_updated_at();

-- Atomically claim the next pending job. FOR UPDATE SKIP LOCKED lets multiple
-- workers (or overlapping cron ticks) run without grabbing the same job.
create or replace function claim_collection_job()
returns collection_job
language plpgsql
as $$
declare
  j collection_job;
begin
  update collection_job
     set status = 'running', attempts = attempts + 1, claimed_at = now(), updated_at = now()
   where id = (
     select id from collection_job
      where status = 'pending'
      order by priority desc, created_at asc
      for update skip locked
      limit 1
   )
  returning * into j;
  return j;   -- null when the queue is empty
end;
$$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table collection_job enable row level security;

-- members can watch their workspace's jobs; all writes go through the
-- service-role worker (no authenticated write policy).
create policy collection_job_ro on collection_job
  for select using (is_workspace_member(workspace_id));
