-- Reverse of the M4 salary revision migration.
--
-- Guarded so it can be re-run, and it drops ONLY what this migration added:
-- the unique key, the generated marker that carries it, and the three real
-- columns. Nothing else in `employee_salary` is touched: no row is deleted, no
-- status is rewound, and the approved history the table exists to keep is left
-- exactly as it is.
--
-- Dropping these columns DOES lose the recorded business reasons and the
-- record of who amended which proposal, which is what reversing the migration
-- means; the revisions themselves, their amounts, their approvals and their
-- rejections all survive it.
--
-- THE INDEX GOES FIRST, because the generated column it is built on cannot be
-- dropped while it does. Dropping the key removes the one-pending-proposal
-- invariant from the database; the usecase check survives in code until that
-- is rolled back too.
SET @drop_revision_reason = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'revision_reason') = 1,
  'ALTER TABLE `employee_salary` DROP COLUMN `revision_reason`',
  'DO 0');
PREPARE drop_revision_reason_stmt FROM @drop_revision_reason;
EXECUTE drop_revision_reason_stmt;
DEALLOCATE PREPARE drop_revision_reason_stmt;

SET @drop_pending_unique = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `INDEX_NAME` = 'uq_salary_pending_proposal') = 1,
  'ALTER TABLE `employee_salary` DROP INDEX `uq_salary_pending_proposal`',
  'DO 0');
PREPARE drop_pending_unique_stmt FROM @drop_pending_unique;
EXECUTE drop_pending_unique_stmt;
DEALLOCATE PREPARE drop_pending_unique_stmt;

SET @drop_pending_marker = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'pending_proposal_marker') = 1,
  'ALTER TABLE `employee_salary` DROP COLUMN `pending_proposal_marker`',
  'DO 0');
PREPARE drop_pending_marker_stmt FROM @drop_pending_marker;
EXECUTE drop_pending_marker_stmt;
DEALLOCATE PREPARE drop_pending_marker_stmt;

SET @drop_changed_at = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'changed_at') = 1,
  'ALTER TABLE `employee_salary` DROP COLUMN `changed_at`',
  'DO 0');
PREPARE drop_changed_at_stmt FROM @drop_changed_at;
EXECUTE drop_changed_at_stmt;
DEALLOCATE PREPARE drop_changed_at_stmt;

SET @drop_changed_by = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'
      AND `COLUMN_NAME` = 'changed_by') = 1,
  'ALTER TABLE `employee_salary` DROP COLUMN `changed_by`',
  'DO 0');
PREPARE drop_changed_by_stmt FROM @drop_changed_by;
EXECUTE drop_changed_by_stmt;
DEALLOCATE PREPARE drop_changed_by_stmt;
