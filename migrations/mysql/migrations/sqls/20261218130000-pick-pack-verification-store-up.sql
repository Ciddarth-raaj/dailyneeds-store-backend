-- Pick & Pack Verification: one line per article per store. The
-- Verification report uploaded on Warehouse Reports > Daily Uploads writes a
-- line for each store an article was short at, so each store gets its own
-- remark. Lines from before this (one per article, stores summed) keep
-- store NULL.
ALTER TABLE pick_pack_verifications
  ADD COLUMN store VARCHAR(100) NULL COMMENT 'RetailPilot store name, from the Verification report' AFTER job_type,
  ADD INDEX idx_pick_pack_verifications_date_job_store (date, job_type, store);
