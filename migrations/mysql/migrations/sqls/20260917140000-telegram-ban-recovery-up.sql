-- BANS WE OURSELVES LEFT IN PLACE. Phase 3C.
--
-- ADDITIVE ONLY. One small table, no permission, nothing existing touched.
--
-- ============================== WHY TELEGRAM'S ANSWER IS NOT ENOUGH ========
--
-- Removal here is `banChatMember` followed immediately by the
-- `unbanChatMember` that undoes it: the person is removed, not banished, so
-- a rejoin or a later grant needs nobody to remember anything. When the
-- second call fails, the person is left BANNED, and Telegram reports that
-- as `kicked`.
--
-- `kicked` PROVES ONLY THAT AN ACCOUNT IS BANNED. It does not say who
-- banned it or why. An administrator who deliberately banned somebody -
-- after an incident, at somebody's request - shows up in exactly the same
-- word. Unbanning on the strength of that status would silently undo a
-- human decision this system knows nothing about, in a real group, and the
-- only trace would be the person walking back in.
--
-- So the recovery path asks THIS TABLE instead: is there an outstanding ban
-- that WE issued and have not yet lifted? Only then is an unban ours to
-- perform. A `kicked` account with no row here is somebody else's decision,
-- and is left exactly as it is for a person to look at.
--
-- ================================================= WHAT IS STORED =========
--
-- The identity ROW ID and the group id, and the time we banned. No Telegram
-- user id, no chat id, no mobile, no token - the identity table owns the
-- first and the registry the second, and the only question this table
-- answers is "did we do this, and is it still outstanding".
--
-- ONE ROW PER IDENTITY PER GROUP, because that is the granularity a ban has.
-- Written only AFTER our ban succeeds; deleted only after the unban that
-- clears it succeeds. Both foreign keys cascade, so retiring an identity or
-- deleting a group takes its outstanding recovery rows with it rather than
-- leaving instructions about somebody who no longer exists.

CREATE TABLE IF NOT EXISTS `employee_telegram_group_ban_recovery` (
  `employee_telegram_group_ban_recovery_id` INT NOT NULL AUTO_INCREMENT,
  `employee_telegram_id` INT NOT NULL
    COMMENT 'OUR identity row id - never a Telegram user id',
  `telegram_group_id` INT NOT NULL,
  `employee_id` INT NOT NULL COMMENT 'denormalised, for reading the audit trail',
  `banned_at` DATETIME NOT NULL COMMENT 'when OUR banChatMember succeeded',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`employee_telegram_group_ban_recovery_id`),
  UNIQUE KEY `uq_etgbr_identity_group` (`employee_telegram_id`,`telegram_group_id`),
  KEY `idx_etgbr_employee` (`employee_id`),
  KEY `idx_etgbr_group` (`telegram_group_id`),
  CONSTRAINT `fk_etgbr_identity` FOREIGN KEY (`employee_telegram_id`)
    REFERENCES `employee_telegram_identity` (`employee_telegram_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_etgbr_group` FOREIGN KEY (`telegram_group_id`)
    REFERENCES `telegram_group_registry` (`telegram_group_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
