-- RetailPilot debit notes (POST /debit-note/retailpilot-sync).
-- mprh_pr_refno is the debit note's number - the Tally voucher number - and
-- RetailPilot numbers debit notes per store and financial year
-- (Warehouse 1407..., Moolakulam 50..., Kathirkamam 51...), so the same
-- number appears at two outlets. A table-wide UNIQUE on mprh_pr_refno
-- would refuse the second one. Tally's responses are already matched on
-- voucher number + outlet (debit_note_tally_response: VoucherNo, CostCentre).
--
-- The unique index on mprh_pr_refno alone is named differently by
-- environment (or missing), so it is found in information_schema:
--   - found: dropped, and replaced by UNIQUE (store_id, mprh_pr_no,
--     mprh_pr_refno). That key holds every row the old one did, so it cannot
--     fail on existing data, and the GoFrugal bulk import's ON DUPLICATE KEY
--     still finds its own rows.
--   - not found: nothing kept refno unique, so existing rows may repeat;
--     a plain index on the same columns is added instead.
-- Either way the sync's lookup (outlet + mprh_pr_no) uses the new index.
-- Re-running is harmless: the new index is only added when absent.

SET @old_idx = (
  SELECT index_name
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'debit_note'
    AND index_name != 'PRIMARY'
    AND non_unique = 0
  GROUP BY index_name
  HAVING COUNT(*) = 1 AND MAX(column_name) = 'mprh_pr_refno'
  LIMIT 1
);

SET @have_new = (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'debit_note'
    AND index_name = 'uniq_debit_note_store_pr'
);

SET @dn_key_sql = CASE
  WHEN @have_new > 0 AND @old_idx IS NOT NULL THEN
    CONCAT('ALTER TABLE `debit_note` DROP INDEX `', @old_idx, '`')
  WHEN @have_new > 0 THEN 'SELECT 1'
  WHEN @old_idx IS NOT NULL THEN
    CONCAT('ALTER TABLE `debit_note` DROP INDEX `', @old_idx, '`, ',
           'ADD UNIQUE KEY `uniq_debit_note_store_pr` (`store_id`, `mprh_pr_no`, `mprh_pr_refno`)')
  ELSE
    'ALTER TABLE `debit_note` ADD KEY `uniq_debit_note_store_pr` (`store_id`, `mprh_pr_no`, `mprh_pr_refno`)'
END;

PREPARE dn_key_stmt FROM @dn_key_sql;
EXECUTE dn_key_stmt;
DEALLOCATE PREPARE dn_key_stmt;
