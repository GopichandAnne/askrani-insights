-- 0070_vertical_profile — LLM-derived market-intel config for verticals that have
-- no hand-tuned entry (the competitor-discovery search phrase + the industry
-- hashtags). Generated once per vertical by the classifier-tier LLM and cached
-- here, so a brand-new business type gets sharp discovery + industry content with
-- zero code. The hand-tuned verticals (restaurant/grocery/salon/smoke_vape/
-- fitness/dental/real_estate) never touch this table — their curated, cuisine-
-- aware queries win. Global reference data: service-role only (RLS on, no policies).

create table if not exists vertical_profile (
  vertical        text primary key,
  discovery_query text,
  hashtags        text[] not null default '{}',
  updated_at      timestamptz not null default now()
);

alter table vertical_profile enable row level security;
