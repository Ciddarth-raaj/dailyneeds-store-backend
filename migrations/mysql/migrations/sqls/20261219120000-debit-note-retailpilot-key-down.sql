-- Takes away the (store_id, mprh_pr_no, mprh_pr_refno) index. A table-wide
-- UNIQUE on mprh_pr_refno is put back only where the up migration found one:
-- that is when the new index is unique. Fails (and changes nothing) once two
-- outlets hold debit notes with the same number: delete or renumber those
-- first.
SET @new_unique = (
  SELECT MIN(non_unique) = 0
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'debit_note'
    AND index_name = 'uniq_debit_note_store_pr'
);

SET @dn_key_sql = CASE
  WHEN @new_unique = 1 THEN
    'ALTER TABLE `debit_note` DROP INDEX `uniq_debit_note_store_pr`, ADD UNIQUE KEY `mprh_pr_refno` (`mprh_pr_refno`)'
  WHEN @new_unique = 0 THEN
    'ALTER TABLE `debit_note` DROP INDEX `uniq_debit_note_store_pr`'
  ELSE 'SELECT 1'
END;

PREPARE dn_key_stmt FROM @dn_key_sql;
EXECUTE dn_key_stmt;
DEALLOCATE PREPARE dn_key_stmt;
