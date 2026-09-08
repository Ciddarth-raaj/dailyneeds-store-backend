-- Reverses the duplicate-account guard. Any row sitting in DUPLICATE_ACCOUNT
-- becomes PENDING first: without the state it cannot be represented, and
-- PENDING is the honest fallback - unverified, not verified.
UPDATE `employee_bank_verification` SET `status` = 'PENDING' WHERE `status` = 'DUPLICATE_ACCOUNT';

ALTER TABLE `employee_bank_verification`
  DROP INDEX `idx_bank_verification_fingerprint`,
  DROP COLUMN `override_reason`,
  DROP COLUMN `override_at`,
  DROP COLUMN `override_by_employee_id`,
  DROP COLUMN `duplicate_of_employee_id`;

ALTER TABLE `employee_bank_verification`
  MODIFY COLUMN `status`
    ENUM('NOT_PROVIDED','PENDING','VERIFIED','NAME_MISMATCH','FAILED')
    NOT NULL DEFAULT 'NOT_PROVIDED';

ALTER TABLE `employee_bank_verification_attempt` DROP COLUMN `override_reason`;

-- Only the key this migration introduced.
DELETE FROM `permissions` WHERE `permission_key` = 'override_duplicate_bank_account';
DELETE FROM `all_permissions` WHERE `permission_key` = 'override_duplicate_bank_account';
