-- Reverses the bank tables and the two permission keys. The Aadhaar status
-- ENUM is returned to its C2 shape; any row still sitting in 'initiated' is
-- moved to 'failed' first, because that is what an unfinished OTP session is.
DROP TABLE IF EXISTS `employee_bank_verification_attempt`;
DROP TABLE IF EXISTS `employee_bank_verification`;

-- Only the two keys this migration introduced, by name. Every other grant -
-- including the C2 lifecycle keys, `add_employees` and anything an
-- administrator granted by hand - is untouched.
DELETE FROM `permissions` WHERE `permission_key` IN ('verify_employee_bank','confirm_bank_name_mismatch');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('verify_employee_bank','confirm_bank_name_mismatch');

UPDATE `employee_aadhaar_verification` SET `status` = 'failed' WHERE `status` = 'initiated';
ALTER TABLE `employee_aadhaar_verification`
  DROP INDEX `uq_aadhaar_verification_session_token`,
  DROP COLUMN `session_token`,
  DROP COLUMN `initiated_at`,
  DROP COLUMN `initiated_by_employee_id`,
  DROP COLUMN `otp_attempts`,
  DROP COLUMN `failure_category`,
  DROP COLUMN `provider_transaction_id`,
  DROP COLUMN `provider_reference_id`;
ALTER TABLE `employee_aadhaar_verification`
  MODIFY COLUMN `status` ENUM('verified','failed','consumed','expired') NOT NULL;
