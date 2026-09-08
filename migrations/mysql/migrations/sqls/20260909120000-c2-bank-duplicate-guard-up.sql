-- Stage 0C / C2 hardening — duplicate bank accounts, and the audited override.
--
-- ADDITIVE ONLY. No employee row, period, event or existing verification is
-- written, and nothing is deleted. Every statement is guarded so the whole
-- file can be re-run without error.
--
-- Runs after 20260908160000, which created the two tables this alters.

-- ---------------------------------------------------- the duplicate status
-- Two ACTIVE employees verified against one bank account is either a
-- data-entry error or one person drawing two salaries. Neither should be
-- silently payroll-ready, and neither is a FAILED verification: the bank
-- answered, and the answer was fine. It needs its own state.
ALTER TABLE `employee_bank_verification`
  MODIFY COLUMN `status`
    ENUM('NOT_PROVIDED','PENDING','VERIFIED','NAME_MISMATCH','DUPLICATE_ACCOUNT','FAILED')
    NOT NULL DEFAULT 'NOT_PROVIDED';

-- ------------------------------------------------- the duplicate and override
-- MySQL has no `ADD COLUMN IF NOT EXISTS`, and a migration that cannot be
-- re-run is one that cannot be recovered halfway through - which is exactly
-- when it matters.
--
--   `duplicate_of_employee_id`  who else is already verified against this
--                               account. Recorded so a screen can name them
--                               without re-running the query.
--   `override_by_employee_id`   who allowed it. An override nobody can be
--                               named for is not an audit trail.
--   `override_at`               when.
--   `override_reason`           why. Required by the usecase, not optional.
SET @add_duplicate_of = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'duplicate_of_employee_id') = 0,
  'ALTER TABLE `employee_bank_verification` ADD COLUMN `duplicate_of_employee_id` INT NULL AFTER `failure_category`',
  'DO 0');
PREPARE add_stmt FROM @add_duplicate_of;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

SET @add_override_by = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'override_by_employee_id') = 0,
  'ALTER TABLE `employee_bank_verification` ADD COLUMN `override_by_employee_id` INT NULL AFTER `confirmation_note`',
  'DO 0');
PREPARE add_stmt FROM @add_override_by;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

SET @add_override_at = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'override_at') = 0,
  'ALTER TABLE `employee_bank_verification` ADD COLUMN `override_at` TIMESTAMP NULL DEFAULT NULL AFTER `override_by_employee_id`',
  'DO 0');
PREPARE add_stmt FROM @add_override_at;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

SET @add_override_reason = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'override_reason') = 0,
  'ALTER TABLE `employee_bank_verification` ADD COLUMN `override_reason` VARCHAR(255) NULL AFTER `override_at`',
  'DO 0');
PREPARE add_stmt FROM @add_override_reason;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- The attempt log carries the override too, so the audit survives a later
-- re-verification clearing the columns above on the current row.
SET @add_attempt_reason = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification_attempt'
      AND `COLUMN_NAME` = 'override_reason') = 0,
  'ALTER TABLE `employee_bank_verification_attempt` ADD COLUMN `override_reason` VARCHAR(255) NULL AFTER `failure_category`',
  'DO 0');
PREPARE add_stmt FROM @add_attempt_reason;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- ---------------------------------------------------------------- the index
-- The duplicate check looks up by fingerprint on every verification. Without
-- this it is a full scan of the verification table, which is small today and
-- will not be.
SET @has_fp_index = (
  SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
   WHERE `TABLE_SCHEMA` = DATABASE()
     AND `TABLE_NAME` = 'employee_bank_verification'
     AND `INDEX_NAME` = 'idx_bank_verification_fingerprint'
);
SET @fp_index_sql = IF(
  @has_fp_index = 0,
  'ALTER TABLE `employee_bank_verification` ADD KEY `idx_bank_verification_fingerprint` (`account_fingerprint`)',
  'DO 0'
);
PREPARE fp_index_stmt FROM @fp_index_sql;
EXECUTE fp_index_stmt;
DEALLOCATE PREPARE fp_index_stmt;

-- ------------------------------------------------------------- permission
-- Declared only, and granted to NOBODY - not even HR Executive. The usual
-- cause of a duplicate is a mistyped account, and the person who typed it
-- should not be the person who waves it through. An administrator reaches
-- this through the `user_type = 2` bypass, which needs no row.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'override_duplicate_bank_account' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'override_duplicate_bank_account');
