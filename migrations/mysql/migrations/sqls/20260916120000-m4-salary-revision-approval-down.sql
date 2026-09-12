-- Reverse of the M4 salary revision migration.
--
-- Guarded so it can be re-run, and it drops ONLY the column this migration
-- added. Nothing else in `employee_salary` is touched: no row is deleted, no
-- status is rewound, and the approved history the table exists to keep is left
-- exactly as it is.
--
-- Dropping this column DOES lose the recorded business reasons, which is what
-- reversing the migration means; the revisions themselves, their amounts,
-- their approvals and their rejections all survive it.
SET @drop_revision_reason = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'revision_reason') = 1,
  'ALTER TABLE `employee_salary` DROP COLUMN `revision_reason`',
  'DO 0');
PREPARE drop_revision_reason_stmt FROM @drop_revision_reason;
EXECUTE drop_revision_reason_stmt;
DEALLOCATE PREPARE drop_revision_reason_stmt;
