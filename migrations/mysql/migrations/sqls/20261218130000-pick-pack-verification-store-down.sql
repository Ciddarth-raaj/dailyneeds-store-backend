-- Reverses 20261218130000-pick-pack-verification-store-up.sql. Lines keep
-- their quantities but lose which store they were for.
ALTER TABLE pick_pack_verifications
  DROP INDEX idx_pick_pack_verifications_date_job_store,
  DROP COLUMN store;
