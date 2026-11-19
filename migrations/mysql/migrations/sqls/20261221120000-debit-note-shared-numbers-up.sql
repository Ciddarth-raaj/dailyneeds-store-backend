-- RetailPilot debit notes that share their number with an older debit note
-- at the same outlet (RetailPilot's numbers run on into the range GoFrugal
-- used: Warehouse 1407, 1408, 1421, ...). Accounts asked for them to be
-- imported all the same.
--
-- 1. debit_note: every unique key on mprh_pr_refno that does not include
--    mprh_pr_no goes - in production one named `store_id` on
--    (store_id, mprh_pr_refno), which refused them. Names differ by
--    environment, so they are found in information_schema (three passes:
--    one key each). (store_id, mprh_pr_no, mprh_pr_refno) stays indexed
--    (uniq_debit_note_store_pr, 20261219120000).
-- 2. debit_note_tally_response: a unique key on the voucher number without
--    MasterID - (VoucherNo, CostCentre) - would let Tally's response to a
--    RetailPilot debit note overwrite the response to the older debit note
--    with the same number. It becomes UNIQUE (VoucherNo, CostCentre,
--    MasterID): each exported debit note keeps its own response. Where
--    responses already repeat (production does) it is a plain index instead.
--    (Prefix lengths keep the key inside InnoDB's 767-byte column limit.)
-- Safe to run again.

SET @k = (
  SELECT index_name FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'debit_note'
    AND non_unique = 0 AND index_name NOT IN ('PRIMARY', 'uniq_debit_note_store_pr')
  GROUP BY index_name
  HAVING SUM(column_name = 'mprh_pr_refno') > 0 AND SUM(column_name = 'mprh_pr_no') = 0
  LIMIT 1
);
SET @sql = IF(@k IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `debit_note` DROP INDEX `', @k, '`'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @k = (
  SELECT index_name FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'debit_note'
    AND non_unique = 0 AND index_name NOT IN ('PRIMARY', 'uniq_debit_note_store_pr')
  GROUP BY index_name
  HAVING SUM(column_name = 'mprh_pr_refno') > 0 AND SUM(column_name = 'mprh_pr_no') = 0
  LIMIT 1
);
SET @sql = IF(@k IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `debit_note` DROP INDEX `', @k, '`'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @k = (
  SELECT index_name FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'debit_note'
    AND non_unique = 0 AND index_name NOT IN ('PRIMARY', 'uniq_debit_note_store_pr')
  GROUP BY index_name
  HAVING SUM(column_name = 'mprh_pr_refno') > 0 AND SUM(column_name = 'mprh_pr_no') = 0
  LIMIT 1
);
SET @sql = IF(@k IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `debit_note` DROP INDEX `', @k, '`'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @k = (
  SELECT index_name FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'debit_note_tally_response'
    AND non_unique = 0 AND index_name NOT IN ('PRIMARY', 'uniq_dntr_voucher_master')
  GROUP BY index_name
  HAVING SUM(column_name = 'VoucherNo') > 0 AND SUM(column_name = 'MasterID') = 0
  LIMIT 1
);
SET @sql = IF(@k IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `debit_note_tally_response` DROP INDEX `', @k, '`'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @k = (
  SELECT index_name FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'debit_note_tally_response'
    AND non_unique = 0 AND index_name NOT IN ('PRIMARY', 'uniq_dntr_voucher_master')
  GROUP BY index_name
  HAVING SUM(column_name = 'VoucherNo') > 0 AND SUM(column_name = 'MasterID') = 0
  LIMIT 1
);
SET @sql = IF(@k IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `debit_note_tally_response` DROP INDEX `', @k, '`'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @k = (
  SELECT index_name FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'debit_note_tally_response'
    AND non_unique = 0 AND index_name NOT IN ('PRIMARY', 'uniq_dntr_voucher_master')
  GROUP BY index_name
  HAVING SUM(column_name = 'VoucherNo') > 0 AND SUM(column_name = 'MasterID') = 0
  LIMIT 1
);
SET @sql = IF(@k IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `debit_note_tally_response` DROP INDEX `', @k, '`'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @have = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'debit_note_tally_response'
    AND index_name = 'uniq_dntr_voucher_master'
);
-- Production already holds repeated responses (same voucher, outlet and
-- MasterID), so there the key is a plain index: responses keep being
-- appended, as they were. Where none repeat it is unique.
SET @repeats = (
  SELECT COUNT(*) FROM (
    SELECT 1 FROM `debit_note_tally_response`
    GROUP BY LEFT(`VoucherNo`, 100), LEFT(`CostCentre`, 100), LEFT(`MasterID`, 150)
    HAVING COUNT(*) > 1
  ) r
);
SET @sql = CASE
  WHEN @have > 0 THEN 'SELECT 1'
  WHEN @repeats > 0 THEN
    'ALTER TABLE `debit_note_tally_response` ADD KEY `uniq_dntr_voucher_master` (`VoucherNo`(100), `CostCentre`(100), `MasterID`(150))'
  ELSE
    'ALTER TABLE `debit_note_tally_response` ADD UNIQUE KEY `uniq_dntr_voucher_master` (`VoucherNo`(100), `CostCentre`(100), `MasterID`(150))'
END;
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
