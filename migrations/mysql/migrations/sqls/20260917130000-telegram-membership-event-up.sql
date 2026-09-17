-- MANAGED MEMBERSHIP AUDIT - typed, append-only. Phase 3C.
--
-- ADDITIVE ONLY. One new table, no permission, nothing existing touched.
--
-- ============================== TYPED COLUMNS, NOT A FREE-FORM JSON BLOB ===
--
-- There is deliberately NO `detail_json`. An audit row on a membership
-- decision is written on paths that have a chat id, a Telegram user id and an
-- invite URL in scope, and a free-text field is where those leak: not by
-- design, but by somebody one day writing `detail: err.message`. Every
-- column here is either a number we own or a value from a closed vocabulary,
-- so there is nowhere for an identifier or an error string to go.
--
-- `employee_telegram_id` IS OUR IDENTITY ROW ID, NEVER A TELEGRAM USER ID.
-- It is how a historical identity is named - "the account they used before
-- they reconnected" - without storing anything Telegram would recognise.
--
-- NOTHING READS THIS TO MAKE A DECISION. Claims and live Telegram answers
-- decide; this records what was decided, for a person reading afterwards.

CREATE TABLE IF NOT EXISTS `employee_telegram_group_membership_event` (
  `employee_telegram_group_membership_event_id` BIGINT NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL,
  `telegram_group_id` INT NULL COMMENT 'NULL only for employee-wide events',
  `source` ENUM('RULE','MANUAL') NULL,
  `employee_telegram_id` INT NULL
    COMMENT 'OUR identity row id - never a Telegram user id',
  `event_type` ENUM('CLAIM_OPENED','CLAIM_REOPENED','CLAIM_REMOVAL_REQUESTED',
                    'CLAIM_REMOVAL_CANCELLED','CLAIM_CLOSED','ADOPTED',
                    'REMOVE_ATTEMPTED','REMOVED','ALREADY_ABSENT','REMOVE_FAILED',
                    'SKIPPED_NOT_READY','SKIPPED_NO_IDENTITY',
                    'IDENTITY_REUSED_BY_OTHER_EMPLOYEE') NOT NULL,
  `detail_code` VARCHAR(48) NULL
    COMMENT 'closed vocabulary - constants/telegram_membership_claim.js. Never free text',
  `telegram_membership_job_id` BIGINT NULL,
  `actor_employee_id` INT NULL COMMENT 'NULL when the worker acted, not a person',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`employee_telegram_group_membership_event_id`),
  KEY `idx_etgme_employee` (`employee_id`,`created_at`),
  KEY `idx_etgme_group` (`telegram_group_id`,`created_at`),
  KEY `idx_etgme_job` (`telegram_membership_job_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
