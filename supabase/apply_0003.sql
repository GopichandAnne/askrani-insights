-- Idempotent apply of the collection job queue (migration 0003).
-- Safe to run even if some objects already exist. Paste into the Supabase
-- SQL Editor and Run. Ends by forcing a PostgREST schema-cache reload.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type job_status as enum ('pending', 'running', 'done', 'error');
  end if;
end $$;

create table if not exists collection_job (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace(id) on delete cascade,
  business_id   uuid not null references business(id) on delete cascade,
  status        job_status not null default 'pending',
  priority      integer not null default 0,
  attempts      integer not null default 0,
  result        jsonb,
  error         text,
  claimed_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists collection_job_active_uniq
  on collection_job(workspace_id, business_id)
  where status in ('pending', 'running');
create index if not exists collection_job_pending
  on collection_job(status, priority desc, created_at)
  where status = 'pending';
create index if not exists collection_job_workspace
  on collection_job(workspace_id, created_at desc);

drop trigger if exists collection_job_updated_at on collection_job;
create trigger collection_job_updated_at
  before update on collection_job
  for each row execute function set_updated_at();

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
  return j;
end;
$$;

alter table collection_job enable row level security;
drop policy if exists collection_job_ro on collection_job;
create policy collection_job_ro on collection_job
  for select using (is_workspace_member(workspace_id));

-- force PostgREST to pick up the new table/function immediately
notify pgrst, 'reload schema';
