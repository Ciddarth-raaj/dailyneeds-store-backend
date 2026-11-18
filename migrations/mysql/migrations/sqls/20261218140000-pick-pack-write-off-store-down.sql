-- Reverses 20261218140000-pick-pack-write-off-store-up.sql. Lines keep their
-- quantities but lose which store they were for.
ALTER TABLE pick_pack_write_off
  DROP INDEX idx_pick_pack_write_off_date_store,
  DROP COLUMN store;
