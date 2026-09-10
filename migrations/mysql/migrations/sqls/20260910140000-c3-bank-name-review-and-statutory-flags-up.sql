-- Stage 0C / C3 follow-up — the bank name-mismatch REVIEW, and the PF/ESI
-- applicability flags.
--
-- ADDITIVE ONLY. No employee row, verification, period or event is written,
-- nothing is deleted, and no existing value changes meaning. Every statement
-- is guarded so the whole file can be re-run without error - MySQL has no
-- `ADD COLUMN IF NOT EXISTS`, and a migration that cannot be re-run is one
-- that cannot be recovered halfway through, which is exactly when it matters.
--
-- Runs after 20260909120000, which added the override columns this extends.

-- ============================================================ the bank review
--
-- WHY `REJECTED` IS A STATUS AND NOT A FLAG.
-- Until now a name mismatch had exactly one exit: confirm it, or leave it
-- sitting there forever. That is what made the screen say "this cannot be
-- confirmed by anybody" with no action beside it. A review has three real
-- outcomes - the account IS theirs, the details are WRONG, or the account is
-- not usable at all - and only the third has nowhere to go today.
--
-- It is not FAILED: FAILED means the check itself did not complete, and it
-- invites "Retry Verification". A rejected account was checked successfully
-- and a human decided against it; retrying the provider would spend a paid
-- call to be told the same thing. It is not PENDING either, which means
-- "nobody has looked yet".
--
-- Like every other non-VERIFIED status it is NOT payroll-ready, so a bank
-- payout stays blocked. `resolveEffectiveStatus` derives readiness from the
-- status alone, so that needs no rule of its own here.
ALTER TABLE `employee_bank_verification`
  MODIFY COLUMN `status`
    ENUM('NOT_PROVIDED','PENDING','VERIFIED','NAME_MISMATCH','DUPLICATE_ACCOUNT','REJECTED','FAILED')
    NOT NULL DEFAULT 'NOT_PROVIDED';

-- ---------------------------------------------------- which override this was
-- `override_by_employee_id` / `override_at` / `override_reason` already
-- record WHO waived a check, WHEN and WHY. What they cannot say is WHICH
-- check was waived, and from now on there are two: a shared account, and a
-- name the bank spelled differently. An override nobody can classify is not
-- much better than one nobody can name, and payroll has to be able to tell a
-- name-mismatch override from a duplicate one at a glance.
--
-- NULL on every existing row, deliberately. The only overrides written before
-- this migration were duplicate overrides, but backfilling that assumption
-- would be a migration asserting something about audited decisions it did not
-- witness. The rows that matter are in the append-only attempt log, which
-- recorded `ADMIN_OVERRIDE` against each one; new rows say so in this column.
SET @add_override_kind = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'override_kind') = 0,
  'ALTER TABLE `employee_bank_verification` ADD COLUMN `override_kind` ENUM(''DUPLICATE_ACCOUNT'',''NAME_MISMATCH'') NULL AFTER `override_reason`',
  'DO 0');
PREPARE add_stmt FROM @add_override_kind;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- ------------------------------------------------------- who rejected it, why
-- The same shape as the override trio, for the same reason: a rejection that
-- nobody is named for, with no stated reason, is not an audit trail. The
-- reason is required by the usecase, not optional.
SET @add_rejected_by = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'rejected_by_employee_id') = 0,
  'ALTER TABLE `employee_bank_verification` ADD COLUMN `rejected_by_employee_id` INT NULL AFTER `override_kind`',
  'DO 0');
PREPARE add_stmt FROM @add_rejected_by;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

SET @add_rejected_at = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'rejected_at') = 0,
  'ALTER TABLE `employee_bank_verification` ADD COLUMN `rejected_at` TIMESTAMP NULL DEFAULT NULL AFTER `rejected_by_employee_id`',
  'DO 0');
PREPARE add_stmt FROM @add_rejected_at;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

SET @add_rejection_reason = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'rejection_reason') = 0,
  'ALTER TABLE `employee_bank_verification` ADD COLUMN `rejection_reason` VARCHAR(255) NULL AFTER `rejected_at`',
  'DO 0');
PREPARE add_stmt FROM @add_rejection_reason;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- ================================================ PF and ESI applicability
--
-- Two columns on the employee master, beside the numbers they qualify.
--
-- WHY NULLABLE, AND WHY THERE IS NO BACKFILL.
-- Today an employee with no PF number is displayed as "not recorded", which
-- runs together two different facts: nobody has typed the number in yet, and
-- this employee is not in the scheme at all. Only the second is a finished
-- state, and the schema cannot tell them apart because it has never been
-- asked.
--
-- So NULL is a real value here and it means exactly "nobody has said yet".
-- Defaulting all 630 existing employees to 1, or to 0, would be a migration
-- deciding a statutory fact about real people - one that changes what payroll
-- must file - on no evidence at all. HR states it per employee; until they
-- do, the screen says "not recorded" about the flag rather than inventing an
-- answer.
--
-- TINYINT(1) rather than an ENUM, matching `new_employee.status`,
-- `online_portal` and every other yes/no already on this table.
--
-- SAFE FOR THE NIGHTLY SYNC. `services/synker.js` builds its
-- `INSERT ... ON DUPLICATE KEY UPDATE` from the keys present in the Digisme
-- payload, and neither of these is one of them, so the 07:00 sync can neither
-- set nor clear them. A locally recorded flag survives it the way `salary`
-- and the bank columns already do.
SET @add_pf_applicable = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'pf_applicable') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `pf_applicable` TINYINT(1) NULL DEFAULT NULL COMMENT ''1=in the PF scheme, 0=not applicable, NULL=not recorded''',
  'DO 0');
PREPARE add_stmt FROM @add_pf_applicable;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

SET @add_esi_applicable = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'esi_applicable') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `esi_applicable` TINYINT(1) NULL DEFAULT NULL COMMENT ''1=in the ESI scheme, 0=not applicable, NULL=not recorded''',
  'DO 0');
PREPARE add_stmt FROM @add_esi_applicable;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;
