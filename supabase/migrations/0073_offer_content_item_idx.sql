-- Offer dedup relies on deleting an existing content item's offers before
-- re-inserting the freshly scraped set (collect.ts insertOffers). That delete
-- filters by (business_id, content_item_id) but the offer table had no index on
-- content_item_id, so on a business with thousands of offers the delete scanned
-- the whole business partition and hit the 8s statement timeout — deleting 0 rows
-- and letting every scan re-append the menu (one restaurant reached 14k+ offers,
-- and its prices vanished from the report's capped read). This index makes the
-- per-content-item delete a fast index lookup.
create index if not exists offer_content_item on offer(content_item_id);
