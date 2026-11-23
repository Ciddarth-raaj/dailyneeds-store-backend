-- A Tally response stored before responses were linked to their debit note
-- is matched on voucher number + outlet, and an incoming one is looked up
-- the same way when its MasterID does not name the debit note
-- (repository/debit_note_tally.js). 20261221120000 removed the unique key
-- that indexed (store_id, mprh_pr_refno); this puts a plain index back.
-- Added only where missing.
SET @have = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'debit_note'
    AND index_name = 'idx_debit_note_store_refno'
);
SET @sql = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `debit_note` ADD INDEX `idx_debit_note_store_refno` (`store_id`, `mprh_pr_refno`)');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
