-- Reverses the bank name-mismatch review columns and the PF/ESI flags.
--
-- Only what the up added, and in the order MySQL requires: the rows that use
-- the new status value are moved off it BEFORE the enum stops accepting it,
-- or the MODIFY would silently truncate them to ''.
--
-- REJECTED becomes NAME_MISMATCH again rather than FAILED. That is where a
-- rejected account came from, it is the state that asks for a human decision,
-- and it is not payroll-ready either - so reversing the feature cannot let
-- somebody be paid against an account a reviewer had turned down. The stated
-- reason and reviewer are lost with the columns below; that is the honest
-- consequence of dropping them, and the append-only
-- `employee_bank_verification_attempt` log still carries the decision.
UPDATE `employee_bank_verification`
   SET `status` = 'NAME_MISMATCH'
 WHERE `status` = 'REJECTED';

ALTER TABLE `employee_bank_verification`
  MODIFY COLUMN `status`
    ENUM('NOT_PROVIDED','PENDING','VERIFIED','NAME_MISMATCH','DUPLICATE_ACCOUNT','FAILED')
    NOT NULL DEFAULT 'NOT_PROVIDED';

-- Each drop is guarded, so a half-applied up can still be reversed.
SET @drop_override_kind = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'override_kind') = 1,
  'ALTER TABLE `employee_bank_verification` DROP COLUMN `override_kind`',
  'DO 0');
PREPARE drop_stmt FROM @drop_override_kind;
EXECUTE drop_stmt;
DEALLOCATE PREPARE drop_stmt;

SET @drop_rejected_by = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'rejected_by_employee_id') = 1,
  'ALTER TABLE `employee_bank_verification` DROP COLUMN `rejected_by_employee_id`',
  'DO 0');
PREPARE drop_stmt FROM @drop_rejected_by;
EXECUTE drop_stmt;
DEALLOCATE PREPARE drop_stmt;

SET @drop_rejected_at = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'rejected_at') = 1,
  'ALTER TABLE `employee_bank_verification` DROP COLUMN `rejected_at`',
  'DO 0');
PREPARE drop_stmt FROM @drop_rejected_at;
EXECUTE drop_stmt;
DEALLOCATE PREPARE drop_stmt;

SET @drop_rejection_reason = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_bank_verification'
      AND `COLUMN_NAME` = 'rejection_reason') = 1,
  'ALTER TABLE `employee_bank_verification` DROP COLUMN `rejection_reason`',
  'DO 0');
PREPARE drop_stmt FROM @drop_rejection_reason;
EXECUTE drop_stmt;
DEALLOCATE PREPARE drop_stmt;

-- Dropping these discards whatever HR has recorded about who is in the PF and
-- ESI schemes. There is nowhere else to put it - nothing else in the schema
-- holds this - so it is the honest consequence of reversing the feature.
SET @drop_pf_applicable = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'pf_applicable') = 1,
  'ALTER TABLE `new_employee` DROP COLUMN `pf_applicable`',
  'DO 0');
PREPARE drop_stmt FROM @drop_pf_applicable;
EXECUTE drop_stmt;
DEALLOCATE PREPARE drop_stmt;

SET @drop_esi_applicable = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'esi_applicable') = 1,
  'ALTER TABLE `new_employee` DROP COLUMN `esi_applicable`',
  'DO 0');
PREPARE drop_stmt FROM @drop_esi_applicable;
EXECUTE drop_stmt;
DEALLOCATE PREPARE drop_stmt;
