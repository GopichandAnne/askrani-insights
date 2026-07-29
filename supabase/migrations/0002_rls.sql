-- ════════════════════════════════════════════════════════════════════════════
-- Row-Level Security — tenant isolation (guide 13.1)
--
-- Model:
--   • Private, tenant-owned rows (workspaces, recommendations, campaigns,
--     outcomes, benchmarks, competitor sets, authorized connectors, corrections)
--     are visible/editable ONLY to members of the owning organization.
--   • Public market intelligence (businesses, locations, content, evidence,
--     observations, offers, canonical entities, global events) is readable by
--     any authenticated user — "public observations may be shared globally with
--     workspace-specific access views" (guide 8.2).
--   • Raw payloads, provider runs and ingestion writes are service-role only.
--     Collection/extraction workers use the service-role key and bypass RLS.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Membership helpers ─────────────────────────────────────────────────────

create or replace function is_org_member(org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_membership m
    where m.organization_id = org and m.user_id = auth.uid()
  );
$$;

create or replace function is_workspace_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace w
    join org_membership m on m.organization_id = w.organization_id
    where w.id = ws and m.user_id = auth.uid()
  );
$$;

-- ─── Enable RLS everywhere ──────────────────────────────────────────────────

alter table organization      enable row level security;
alter table org_membership     enable row level security;
alter table workspace          enable row level security;
alter table business           enable row level security;
alter table location           enable row level security;
alter table external_identity  enable row level security;
alter table competitor_edge    enable row level security;
alter table source_connection  enable row level security;
alter table provider_run       enable row level security;
alter table raw_payload        enable row level security;
alter table content_item       enable row level security;
alter table evidence           enable row level security;
alter table observation        enable row level security;
alter table observation_evidence enable row level security;
alter table canonical_entity   enable row level security;
alter table offer              enable row level security;
alter table market_event       enable row level security;
alter table benchmark          enable row level security;
alter table recommendation     enable row level security;
alter table campaign           enable row level security;
alter table outcome            enable row level security;
alter table correction         enable row level security;

-- ─── Private / tenant-owned ────────────────────────────────────────────────

create policy org_select on organization
  for select using (is_org_member(id));

create policy membership_self on org_membership
  for select using (user_id = auth.uid());

create policy workspace_rw on workspace
  for all using (is_org_member(organization_id))
  with check (is_org_member(organization_id));

create policy competitor_edge_rw on competitor_edge
  for all using (is_workspace_member(workspace_id))
  with check (is_workspace_member(workspace_id));

create policy benchmark_ro on benchmark
  for select using (is_workspace_member(workspace_id));

create policy recommendation_rw on recommendation
  for all using (is_workspace_member(workspace_id))
  with check (is_workspace_member(workspace_id));

create policy campaign_rw on campaign
  for all using (is_workspace_member(workspace_id))
  with check (is_workspace_member(workspace_id));

create policy outcome_rw on outcome
  for all using (is_workspace_member(workspace_id))
  with check (is_workspace_member(workspace_id));

-- Authorized connectors are org-private; global public sources (org is null)
-- are readable by any authenticated user.
create policy source_connection_ro on source_connection
  for select using (organization_id is null or is_org_member(organization_id));
create policy source_connection_rw on source_connection
  for all using (organization_id is not null and is_org_member(organization_id))
  with check (organization_id is not null and is_org_member(organization_id));

create policy correction_insert on correction
  for insert with check (auth.uid() is not null);
create policy correction_select on correction
  for select using (corrected_by = auth.uid() or corrected_by is null);

-- ─── Public market intelligence (authenticated read) ───────────────────────

create policy business_ro         on business          for select using (auth.uid() is not null);
create policy location_ro         on location          for select using (auth.uid() is not null);
create policy external_identity_ro on external_identity for select using (auth.uid() is not null);
create policy content_item_ro     on content_item      for select using (auth.uid() is not null);
create policy evidence_ro         on evidence          for select using (auth.uid() is not null);
create policy observation_ro      on observation       for select using (auth.uid() is not null);
create policy observation_evidence_ro on observation_evidence for select using (auth.uid() is not null);
create policy canonical_entity_ro on canonical_entity  for select using (auth.uid() is not null);
create policy offer_ro            on offer             for select using (auth.uid() is not null);

-- Global events (workspace_id null) are public; workspace events are scoped.
create policy market_event_ro on market_event
  for select using (workspace_id is null or is_workspace_member(workspace_id));

-- ─── Service-role only (no authenticated policies) ─────────────────────────
-- raw_payload, provider_run and all ingestion writes have no user-facing
-- policies, so anon/authenticated cannot touch them. The service-role key used
-- by workers bypasses RLS entirely. This keeps acquisition provenance and cost
-- data off every customer query path.
