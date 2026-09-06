-- Rollback for the Stage 0A user columns.
--
-- Accounts that only hold a modern hash have no SHA-1 value to restore, so
-- their legacy column is set to an empty string before NOT NULL is
-- reinstated. Those accounts cannot sign in after rollback (SHA1(x) is never
-- empty); that is the correct outcome for a credential the old code never
-- knew, and is why rollback of this migration must be paired with restoring
-- the pre-migration backup rather than run on its own once modern hashes
-- exist. See docs/auth-stage0a-implementation.md.
DROP INDEX `idx_user_employee_id` ON `user`;
DROP INDEX `idx_user_username` ON `user`;

UPDATE `user` SET `password` = '' WHERE `password` IS NULL;

ALTER TABLE `user`
  DROP COLUMN `credential_rotated_at`,
  DROP COLUMN `is_system_account`,
  DROP COLUMN `token_valid_from`,
  DROP COLUMN `last_login_at`,
  DROP COLUMN `last_failed_login_at`,
  DROP COLUMN `locked_until`,
  DROP COLUMN `failed_login_count`,
  DROP COLUMN `password_flag_reason`,
  DROP COLUMN `must_change_password`,
  DROP COLUMN `password_migrated_at`,
  DROP COLUMN `password_algo`,
  DROP COLUMN `password_hash`,
  MODIFY `password` TEXT NOT NULL;
