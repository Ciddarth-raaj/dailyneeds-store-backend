-- Pick & Pack Write Off: one line per article per store. The Picking report
-- uploaded on Warehouse Reports > Daily Uploads writes a line for each store
-- an article was short at, so each store gets its own remark. Lines from
-- before this (one per article, stores summed, or imported by hand) keep
-- store NULL.
ALTER TABLE pick_pack_write_off
  ADD COLUMN store VARCHAR(100) NULL COMMENT 'RetailPilot store name, from the Picking report' AFTER date,
  ADD INDEX idx_pick_pack_write_off_date_store (date, store);
