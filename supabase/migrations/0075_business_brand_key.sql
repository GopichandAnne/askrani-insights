-- 0075_business_brand_key — location-aware entity model, step 1. Multi-location
-- competitors (India Bazaar Cedar Park / Round Rock, Desi District, Tarka…) are the
-- COMMON case for our ICP, not an edge case (~1 in 4 competitors carry a branch
-- marker). brand_key is a normalized brand stem (name minus its location suffix), so
-- branches of one brand can be grouped: deduped in a competitor set (no more listing
-- "Desi District" and "Desi District - Cedar Park" twice), rolled up for brand-level
-- intelligence, and eventually linked as parent brand → locations. Computed at
-- upsert; null when the name has no distinctive stem. Backfilled lazily on re-collect.

alter table business add column if not exists brand_key text;
create index if not exists business_brand_key on business(brand_key) where brand_key is not null;
