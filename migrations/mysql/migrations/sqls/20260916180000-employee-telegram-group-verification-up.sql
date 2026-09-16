-- Employee Telegram group MEMBERSHIP VERIFICATION CACHE - Phase 3B.
--
-- ADDITIVE ONLY. One new table, no permission, and no existing table,
-- column or grant touched.
--
-- ============================== WHAT THIS IS, AND WHAT IT IS NOT ===========
--
-- IT IS THE ANSWER TELEGRAM LAST GAVE, WITH THE TIME IT GAVE IT. It exists
-- because the employee dashboard cannot ask Telegram: completion needs a
-- readiness check and a membership check per required group per employee,
-- which for a few hundred employees is thousands of Bot API calls on every
-- page load, sharing one rate-limited token with the three-second
-- password-reset poller.
--
-- IT IS NOT THE AUTHORITY. The employee detail screen asks Telegram every
-- time and fails closed when it cannot - that is the verdict. This is a work
-- queue: it says who to go and look at, and it is explicitly LAST-VERIFIED
-- rather than live. Nothing in the join or approval path reads it.
--
-- ================== BOUND TO THE IDENTITY ROW, NOT TO THE EMPLOYEE =========
--
-- `employee_telegram_id` is the whole reason a reconnect cannot leave stale
-- completion behind. Phase 2 does not update an identity when somebody
-- reconnects - it stamps `disconnected_at` on the old row and INSERTS A NEW
-- ONE - so a verification keyed to the identity row simply stops matching
-- the moment the employee connects a different Telegram account. The
-- dashboard then reports VERIFICATION_PENDING until the new account has
-- actually been checked, which is the truth: we have never verified THAT
-- account in THAT group.
--
-- Keyed to the employee alone, a verification made against an account the
-- employee no longer uses would keep them looking Complete forever. The
-- foreign key cascades, so retiring an identity row takes its verifications
-- with it rather than leaving orphans a later employee id could collide with.
--
-- =============================== WHAT IS DELIBERATELY ABSENT ===============
--
-- No Telegram user id, no chat id, no username, no mobile, no invite URL or
-- hash. The question this table answers is "was this person in that group
-- when we last looked", and the answer is a word and a timestamp. A cache
-- that also held identifiers would be a second place to leak them, for no
-- benefit to the only query that reads it.
--
-- `readiness_status` IS STORED BECAUSE "NOT JOINED" AND "COULD NOT BE
-- MANAGED" ARE DIFFERENT and the dashboard must not merge them into one
-- amber tile. A row is only ever written from a DEFINITIVE answer;
-- TELEGRAM_UNAVAILABLE is never written, because "we could not ask" would
-- otherwise overwrite a real verification with an absence of one.

CREATE TABLE IF NOT EXISTS `employee_telegram_group_verification` (
  `employee_telegram_group_verification_id` INT NOT NULL AUTO_INCREMENT,
  `employee_telegram_id` INT NOT NULL
    COMMENT 'the IDENTITY ROW this was verified against - a reconnect inserts a new identity, so its verifications stop matching',
  `employee_id` INT NOT NULL COMMENT 'denormalised for the dashboard bulk read only',
  `telegram_group_id` INT NOT NULL,
  `membership` ENUM('JOINED','NOT_JOINED') NOT NULL,
  `readiness_status` VARCHAR(32) NOT NULL
    COMMENT 'the readiness Telegram reported when this was taken. TELEGRAM_UNAVAILABLE is never stored',
  `verified_at` DATETIME NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`employee_telegram_group_verification_id`),
  UNIQUE KEY `uq_etgv_identity_group` (`employee_telegram_id`, `telegram_group_id`),
  KEY `idx_etgv_employee` (`employee_id`),
  KEY `idx_etgv_group` (`telegram_group_id`),
  CONSTRAINT `fk_etgv_identity` FOREIGN KEY (`employee_telegram_id`)
    REFERENCES `employee_telegram_identity` (`employee_telegram_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_etgv_group` FOREIGN KEY (`telegram_group_id`)
    REFERENCES `telegram_group_registry` (`telegram_group_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
