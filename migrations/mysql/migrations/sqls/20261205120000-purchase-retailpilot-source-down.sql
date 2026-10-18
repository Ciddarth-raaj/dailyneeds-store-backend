-- Drops the snapshot and the index. Bills and Accounts' corrections stay; a
-- re-sync after the column came back could no longer tell a correction from
-- a synced value, so it would keep every differing field as Accounts'.
ALTER TABLE `purchase`
  DROP INDEX `idx_purchase_outlet_mrc_no`,
  DROP COLUMN `retailpilot_source`;
