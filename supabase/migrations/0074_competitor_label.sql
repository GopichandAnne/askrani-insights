-- 0074_competitor_label — the competitor-discovery feedback flywheel. Every time an
-- owner confirms, removes (with a reason), or adds a competitor, we bank a labeled
-- relationship row: "for THIS business (vertical X, market Y), is business B a real
-- competitor — yes/no, and why?". This is proprietary Competitive Relationship Data:
-- at volume it lets us LEARN the discovery weights instead of guessing them, and it
-- doubles as a trust-building onboarding moment ("did Rani get your market right?").
-- Append-only; one row per confirmation event. Writes are service-role; reads are
-- org-scoped like the rest of the schema.

create table if not exists competitor_label (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references workspace(id) on delete cascade,
  organization_id        uuid not null,
  subject_business_id    uuid references business(id) on delete set null, -- the owner's business ("you")
  competitor_business_id uuid references business(id) on delete set null, -- the rival being judged (null for a free-text add not yet resolved)
  competitor_name        text,                                            -- captured name (esp. for adds / removed rows)
  label                  text not null,                                   -- 'confirmed' | 'rejected' | 'added'
  reason                 text,                                            -- why rejected: different_customers | too_far | different_price | different_concept | other
  vertical               text,                                           -- the subject's vertical at label time (for per-vertical learning)
  created_by             uuid,
  created_at             timestamptz not null default now()
);
create index if not exists cl_ws on competitor_label(workspace_id, created_at desc);
create index if not exists cl_org on competitor_label(organization_id, created_at desc);
create index if not exists cl_pair on competitor_label(subject_business_id, competitor_business_id);

alter table competitor_label enable row level security;
drop policy if exists cl_read_own on competitor_label;
create policy cl_read_own on competitor_label for select
  using (organization_id in (select organization_id from org_membership where user_id = auth.uid()));
