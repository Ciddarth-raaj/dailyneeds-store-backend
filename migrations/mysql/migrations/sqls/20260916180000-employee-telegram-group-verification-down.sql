-- Removes ONLY what the verification-cache migration created.
--
-- One table. Dropping it loses no fact that is not re-derivable: every row
-- is a cached answer the employee detail screen will ask Telegram for again.
-- No permission is revoked because none was created, and the identity,
-- registry, mapping, join-attempt and employee tables are untouched.

DROP TABLE IF EXISTS `employee_telegram_group_verification`;
