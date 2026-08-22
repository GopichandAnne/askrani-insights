-- ════════════════════════════════════════════════════════════════════════════
-- 0072 · Team membership — make org_membership team-ready
--
-- The join table + member_role enum + RLS-through-membership already existed
-- (0001/0002). This migration is pure RLS hardening (the team feature already
-- functions without it, since add/list/remove run via the service-role client):
--   1. an is_org_owner() helper (owner = can manage the team),
--   2. co-member visibility (members can see the roster of orgs they belong to;
--      previously each user could see only their own membership row),
--   3. owner-gated writes on org_membership as defense-in-depth (any direct
--      client write must be by an owner of that org).
--
-- Roles used by the app are 'owner' (full control incl. team + billing) and
-- 'member' (operate, no team/billing management); the enum keeps its other values
-- for future tiers. Bootstrap inserts (ensureOrgForUser) run as service-role and
-- are unaffected by the write policies below. Safe to apply anytime; idempotent.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) owner helper ------------------------------------------------------------
create or replace function is_org_owner(org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_membership m
    where m.organization_id = org and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

-- 2) co-member visibility (replaces the self-only read) -----------------------
drop policy if exists membership_self on org_membership;
create policy membership_read on org_membership
  for select using (is_org_member(organization_id));

-- 3) owner-gated writes (defense-in-depth; app writes via service role) --------
drop policy if exists membership_insert_owner on org_membership;
create policy membership_insert_owner on org_membership
  for insert with check (is_org_owner(organization_id));

drop policy if exists membership_update_owner on org_membership;
create policy membership_update_owner on org_membership
  for update using (is_org_owner(organization_id)) with check (is_org_owner(organization_id));

drop policy if exists membership_delete_owner on org_membership;
create policy membership_delete_owner on org_membership
  for delete using (is_org_owner(organization_id));
