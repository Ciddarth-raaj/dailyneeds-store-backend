-- Stage 0A / Deployment A: authentication columns on `user`.
--
-- Additive only, and ONE statement: a single ALTER TABLE either completes or
-- does not, on MySQL 5.7 and 8.0 alike, so a failure cannot leave half of
-- these columns in place (safety correction pass, deployment gate 4).
--
-- Additive only. Every new column is NULL or has a default, so nothing that
-- reads `user` today changes behaviour. The one modification is making the
-- legacy `password` column nullable: an account whose credential lives in
-- `password_hash` has no SHA-1 value to store, and must not be given one.
--
-- password_algo   'sha1' for every existing row (the only algorithm in use
--                 before this migration); 'scrypt' once a modern hash is set.
-- is_system_account  1 marks a break-glass/system login that has no
--                 new_employee row. Never set by any API; only by the
--                 dedicated script in scripts/auth/break-glass.js.
ALTER TABLE `user`
  MODIFY `password` TEXT NULL,
  ADD COLUMN `password_hash` VARCHAR(255) NULL AFTER `password`,
  ADD COLUMN `password_algo` VARCHAR(16) NOT NULL DEFAULT 'sha1' AFTER `password_hash`,
  ADD COLUMN `password_migrated_at` DATETIME NULL AFTER `password_algo`,
  ADD COLUMN `must_change_password` TINYINT(1) NOT NULL DEFAULT 0 AFTER `password_migrated_at`,
  ADD COLUMN `password_flag_reason` VARCHAR(32) NULL AFTER `must_change_password`,
  ADD COLUMN `failed_login_count` INT NOT NULL DEFAULT 0 AFTER `password_flag_reason`,
  ADD COLUMN `locked_until` DATETIME NULL AFTER `failed_login_count`,
  ADD COLUMN `last_failed_login_at` DATETIME NULL AFTER `locked_until`,
  ADD COLUMN `last_login_at` DATETIME NULL AFTER `last_failed_login_at`,
  ADD COLUMN `token_valid_from` DATETIME NULL AFTER `last_login_at`,
  ADD COLUMN `is_system_account` TINYINT(1) NOT NULL DEFAULT 0 AFTER `token_valid_from`,
  ADD COLUMN `credential_rotated_at` DATETIME NULL AFTER `is_system_account`,
  ADD INDEX `idx_user_username` (`username`),
  ADD INDEX `idx_user_employee_id` (`employee_id`);
