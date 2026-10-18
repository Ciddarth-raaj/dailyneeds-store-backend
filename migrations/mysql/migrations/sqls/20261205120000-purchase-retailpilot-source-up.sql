-- RetailPilot purchases.
--   retailpilot_source  the values the sync last wrote to the bill (JSON), so
--                       a re-sync can tell Accounts' corrections from its own
--                       values and keep them (utils/retailpilot_merge.js).
--                       NULL for every existing row: GoFrugal bills are never
--                       matched by the RetailPilot sync.
--   idx_purchase_outlet_mrc_no  the sync finds a bill by outlet + invoice
--                       slug (mmh_mrc_no) on every run; not unique, so old
--                       GoFrugal rows cannot make it fail.
-- Both are in-place (no table copy) on MySQL 5.7 InnoDB.
ALTER TABLE `purchase`
  ADD COLUMN `retailpilot_source` TEXT NULL,
  ADD INDEX `idx_purchase_outlet_mrc_no` (`retail_outlet_id`, `mmh_mrc_no`);
