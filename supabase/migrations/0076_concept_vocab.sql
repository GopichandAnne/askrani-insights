-- Global per-vertical VOCABULARY — a shared cache of the concept/kind/unit-basis
-- assignments the detector learns, amortized across every workspace of a vertical
-- (like industry_post). Today each workspace bootstraps its own concept map from
-- zero (goals.conceptCanon / groceryKinds / unitBasis), so a NEW business is slow
-- and inconsistent on its first run. This shared table lets a new workspace INHERIT
-- the established vocabulary instantly and resolve consistently.
--
-- FROZEN + additive: first writer wins (insert on conflict do nothing), so an
-- assignment stays stable across all workspaces once set. Service-role only (workers
-- read/write during warm; no tenant access) — RLS enabled with no policy, same as
-- industry_post. The per-workspace goals maps remain as a read-fallback, so nothing
-- breaks before/without this migration.
create table if not exists concept_vocab (
  vertical      text not null,
  kind          text not null,          -- 'concept' | 'grocery_kind' | 'unit_basis'
  surface_key   text not null,          -- normalized surface form / item key
  value         jsonb not null,         -- {concept,demand_type} | {kind} | {family,basis}
  first_seen_at timestamptz not null default now(),
  primary key (vertical, kind, surface_key)
);
create index if not exists concept_vocab_lookup on concept_vocab (vertical, kind);

alter table concept_vocab enable row level security; -- no policy = service-role only
