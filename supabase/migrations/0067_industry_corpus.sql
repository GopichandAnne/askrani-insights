-- Industry corpus — a SHARED, per-vertical pool of the best-performing content
-- discovered nationally under the vertical's hashtags (discovery-first: the top
-- posts/accounts EMERGE from engagement, not a hand-curated list). Amortized
-- across every workspace of that vertical (a restaurant corpus serves all
-- restaurant workspaces). Populated by /api/industry/refresh (Apify hashtag
-- scraping — gated + cost-bearing), read by the "best in your industry" synthesis.
create table if not exists industry_post (
  id            uuid primary key default gen_random_uuid(),
  vertical      text not null,                     -- restaurant | salon | grocery
  subtype       text[] not null default '{}',      -- cuisine/service tags it surfaced for
  platform      text not null,                     -- instagram | tiktok
  hashtag       text,                              -- the seed tag it came in under
  external_ref  text not null,                     -- post id/url — dedup key
  url           text,
  author_handle text,
  caption       text,
  likes         integer,
  comments      integer,
  views         integer,
  eng           bigint not null default 0,         -- views + likes*3 + comments*5
  published_at  timestamptz,
  scraped_at    timestamptz not null default now(),
  unique (platform, external_ref)
);
create index if not exists industry_post_vertical_eng on industry_post (vertical, eng desc);

-- Shared/global data, not tenant-scoped: lock it to the service role (workers
-- read/write it; no anon or authenticated access). RLS on with no policy = only
-- the service-role key can touch it, which is exactly what the synthesis uses.
alter table industry_post enable row level security;
