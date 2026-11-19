-- RetailPilot debit notes keep their reconciliation slug (REC-0SSLW7, ...)
-- in mprh_pr_no, which is text. Where this database has mprh_pr_no as a
-- number (GoFrugal's purchase-return numbers), every slug was stored as 0,
-- and the sync's first run collapsed all its debit notes into that one row.
--
-- 1. mprh_pr_no becomes VARCHAR(50) - only where it is a number type; the
--    existing GoFrugal numbers convert to their text form unchanged. Where it
--    is already text, nothing changes.
-- 2. The row(s) that first run wrote under mprh_pr_no 0 go: created by the
--    sync today (2026-11-19 or later), never approved, never saved by
--    Accounts, and holding RetailPilot's GSTIN-split JSON for a slug it lost.
--    The next sync writes each debit note again under its own slug.

SET @pr_no_type = (
  SELECT data_type FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'debit_note' AND column_name = 'mprh_pr_no'
);

SET @pr_no_sql = IF(
  @pr_no_type IN ('tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'double', 'float'),
  'ALTER TABLE `debit_note` MODIFY `mprh_pr_no` VARCHAR(50) NOT NULL',
  'SELECT 1'
);
PREPARE pr_no_stmt FROM @pr_no_sql;
EXECUTE pr_no_stmt;
DEALLOCATE PREPARE pr_no_stmt;

SET @cleanup_sql = IF(
  @pr_no_type IN ('tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'double', 'float'),
  'DELETE dn FROM `debit_note` dn
     LEFT JOIN `debit_note_internal` dni ON dni.debit_note_id = dn.debit_note_id
    WHERE dn.mprh_pr_no = ''0''
      AND dn.created_at >= ''2026-11-19''
      AND dn.is_approved = 0
      AND dni.debit_note_id IS NULL',
  'SELECT 1'
);
PREPARE cleanup_stmt FROM @cleanup_sql;
EXECUTE cleanup_stmt;
DEALLOCATE PREPARE cleanup_stmt;
