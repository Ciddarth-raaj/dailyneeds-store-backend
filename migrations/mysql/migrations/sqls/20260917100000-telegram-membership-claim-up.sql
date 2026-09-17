-- MANAGED TELEGRAM GROUP MEMBERSHIP - the CLAIM. Phase 3C.
--
-- ADDITIVE ONLY. One new table, no new permission key: MANUAL claims are
-- managed under `manage_telegram_groups`, the key the Group Map already
-- carries, and are deliberately NOT reachable through `employee_edit`.
--
-- ================================ THREE TABLES, THREE DIFFERENT QUESTIONS ==
--
--   telegram_group_mapping                who SHOULD belong, as a rule
--   employee_telegram_group_verification  what Telegram last said (a cache)
--   THIS TABLE                            what we have CLAIMED to manage
--
-- They are separate because they disagree for legitimate reasons and the
-- disagreement is the work: a rule can stop matching while the person is
-- still in the group, and a cache can be stale while the claim is exact.
--
-- ===================================== SOURCE IS PART OF THE IDENTITY ======
--
-- RULE and MANUAL are SEPARATE CLAIMS on the same pair, which is what makes
-- "the rule stopped matching but somebody granted this by hand" expressible
-- without a flag that has to be interpreted. Ending one source never touches
-- the other, and a person is removed only when NO source wants them there.
--
-- THE UNIQUE TRIPLE IS THE NATURAL KEY, so a claim is RE-OPENED IN PLACE
-- rather than re-inserted. Insert-a-new-row-per-spell would collide with
-- this key the first time somebody became eligible again; history lives in
-- `employee_telegram_group_membership_event`, which is append-only.
--
-- ============================================= WHY REMOVAL_PENDING EXISTS ==
--
-- ACTIVE           the business wants this membership
-- REMOVAL_PENDING  the business does not, and Telegram cleanup is still
--                  outstanding or has failed
-- CLOSED           removal confirmed, or the person was confirmed absent
--
-- Without the middle state a claim we could not act on has nowhere to live:
-- closing it would erase the only record that somebody should no longer be
-- in a group, and leaving it ACTIVE would say we still want them there.
-- Re-eligibility while REMOVAL_PENDING returns the row to ACTIVE and cancels
-- the intent, so a change that undoes itself never kicks anybody.
--
-- NO TELEGRAM IDENTIFIER IS STORED HERE. No user id, chat id, mobile or
-- invite hash - the identity table owns the first, the registry the second,
-- and nothing here needs either.

CREATE TABLE IF NOT EXISTS `employee_telegram_group_membership` (
  `employee_telegram_group_membership_id` INT NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL,
  `telegram_group_id` INT NOT NULL,
  `source` ENUM('RULE','MANUAL') NOT NULL,
  `state` ENUM('ACTIVE','REMOVAL_PENDING','CLOSED') NOT NULL DEFAULT 'ACTIVE',
  `intent_reason` ENUM('RULE_NO_LONGER_MATCHES','MANUAL_REVOKED','EMPLOYMENT_ENDED',
                       'GROUP_RETIRED','RETAINED_BY_OTHER_SOURCE') NULL DEFAULT NULL
    COMMENT 'why this source stopped being wanted; survives into CLOSED as the reason it ended',
  `close_outcome` ENUM('REMOVED','ALREADY_ABSENT','RETAINED_BY_OTHER_SOURCE','GROUP_DELETED')
    NULL DEFAULT NULL,
  `adopted_from_existing_member` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1=they were already in the group when we first claimed it, confirmed live',
  `removal_requested_at` DATETIME NULL DEFAULT NULL,
  `closed_at` DATETIME NULL DEFAULT NULL,
  `created_by` INT NULL,
  `updated_by` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`employee_telegram_group_membership_id`),
  UNIQUE KEY `uq_etgm_claim` (`employee_id`,`telegram_group_id`,`source`),
  KEY `idx_etgm_group_state` (`telegram_group_id`,`state`),
  KEY `idx_etgm_employee_state` (`employee_id`,`state`),
  KEY `idx_etgm_state` (`state`),
  CONSTRAINT `fk_etgm_group` FOREIGN KEY (`telegram_group_id`)
    REFERENCES `telegram_group_registry` (`telegram_group_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
