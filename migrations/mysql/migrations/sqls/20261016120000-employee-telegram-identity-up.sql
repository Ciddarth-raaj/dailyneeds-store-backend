-- EMPLOYEE TELEGRAM IDENTITY - Phase 2. Three new tables, nothing else.
--
-- ADDITIVE ONLY. No existing table, column, row, index or permission is
-- touched. `new_employee` is READ BY FOREIGN KEY ONLY - no employee data is
-- copied here, and in particular the employee's mobile number is NOT stored
-- in these tables as a second copy to drift; what is kept is the number that
-- was VERIFIED, which is a fact about the verification and not a contact
-- detail anybody may edit.
--
-- NO BACKFILL IS NEEDED OR POSSIBLE. Nobody is employee-Telegram-linked
-- today, so every active employee is simply Telegram Pending by the absence
-- of a row - the same derivation the Aadhaar status already uses, and the
-- reason the ~200 existing employees need no migration of their own.
--
-- IT IS NOT `telegram_links`. That table is keyed by `user_id` - a dnds.co.in
-- LOGIN - and most employees have no login at all. Password-reset linking
-- keeps it and is untouched; an employee identity that depended on it could
-- not exist for the people this feature is for.

-- ========================================================== identity ======
--
-- ONE ROW PER CONNECTION, AND HISTORY IS KEPT. A reconnect does not rewrite
-- the old row: it stamps `disconnected_at` on it and inserts a new one, so
-- "who was this employee's Telegram account in March" is still answerable and
-- an audit of a removal has something to point at.
--
-- THE THREE UNIQUENESS RULES ARE ENFORCED BY THE DATABASE, NOT BY CODE.
-- Application checks are good error messages; two requests can pass one at the
-- same instant and only an index decides. Each rule is a STORED GENERATED
-- COLUMN that holds its value only while the row is active and NULL once it is
-- disconnected, with a UNIQUE KEY over it - MySQL allows many NULLs in a
-- unique index, so history never collides. This is the pattern
-- `employee_employment_period.open_marker` already uses in this schema for
-- "one open period per employee"; it is not a new idea being introduced here.
--
--   active_employee_marker    ONE active identity per employee
--   active_telegram_marker    ONE employee per Telegram account
--   active_chat_marker        ONE employee per private chat
--
-- The middle one is the security rule: it is what makes it impossible for one
-- Telegram account to be quietly moved onto a second employee's record.
--
-- `verified_mobile` IS THE NORMALISED TEN DIGITS THAT MATCHED, kept so a
-- future question ("which number did this verification actually accept?") has
-- an answer without re-reading a column somebody may have edited since. It is
-- never displayed by any endpoint added in this phase.
CREATE TABLE IF NOT EXISTS `employee_telegram_identity` (
  `employee_telegram_id` INT NOT NULL AUTO_INCREMENT,
  `employee_id`          INT NOT NULL,
  `telegram_user_id`     BIGINT NOT NULL COMMENT 'Telegram user id as the bot observed it - never typed in by anybody',
  `private_chat_id`      BIGINT NOT NULL COMMENT 'the 1:1 chat between the employee and the bot',
  `telegram_username`    VARCHAR(64) NULL DEFAULT NULL COMMENT 'display only - a username is not proof of anything and is never matched on',
  `verified_mobile`      VARCHAR(15) NOT NULL COMMENT 'the normalised 10-digit number that matched at verification time',
  `connected_at`         DATETIME NOT NULL,
  `disconnected_at`      DATETIME NULL DEFAULT NULL,
  `disconnect_reason`    VARCHAR(64) NULL DEFAULT NULL,
  `created_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `active_employee_marker` INT GENERATED ALWAYS AS
     (CASE WHEN `disconnected_at` IS NULL THEN `employee_id` ELSE NULL END) STORED,
  `active_telegram_marker` BIGINT GENERATED ALWAYS AS
     (CASE WHEN `disconnected_at` IS NULL THEN `telegram_user_id` ELSE NULL END) STORED,
  `active_chat_marker` BIGINT GENERATED ALWAYS AS
     (CASE WHEN `disconnected_at` IS NULL THEN `private_chat_id` ELSE NULL END) STORED,
  PRIMARY KEY (`employee_telegram_id`),
  UNIQUE KEY `uq_eti_active_employee` (`active_employee_marker`),
  UNIQUE KEY `uq_eti_active_telegram` (`active_telegram_marker`),
  UNIQUE KEY `uq_eti_active_chat` (`active_chat_marker`),
  KEY `idx_eti_employee` (`employee_id`),
  KEY `idx_eti_telegram_user` (`telegram_user_id`),
  CONSTRAINT `fk_eti_employee` FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================ tokens ======
--
-- The one-time secret behind `t.me/<bot>?start=e_<token>`.
--
-- ONLY THE HASH IS STORED, exactly as `telegram_link_tokens` does for password
-- reset: the row is useless to anyone who reads the table, and a database
-- backup cannot be turned back into working QR codes.
--
-- THE SUBJECT IS THE EMPLOYEE, NEVER THE PERSON WHO GENERATED IT. A manager or
-- an HR user creates the link while the employee scans it on their own phone,
-- so `employee_id` is bound at issue time and `issued_by_user_id` carries no
-- authority at all - it is there so an audit can say who asked.
--
-- `pending_*` IS THE SECOND HALF OF THE FLOW, AND IT LIVES ON THIS ROW rather
-- than in a fourth table. Between `/start` and the shared contact we know the
-- employee, the Telegram user and the chat, but NOT that the mobile matches -
-- and a half-verified row must never appear in the identity table above. The
-- consumed token row already names the employee and is already short-lived, so
-- it is the natural place for that state; a separate table would be another
-- migration, another cleanup job and another thing to keep in step.
--
-- IT IS IN THE DATABASE AND NOT IN MEMORY, deliberately. The employee scans
-- the QR, then looks for the button; an API restart in between must not lose
-- the session and leave them tapping a button that answers nothing.
CREATE TABLE IF NOT EXISTS `employee_telegram_link_tokens` (
  `token_hash`        CHAR(64) NOT NULL COMMENT 'sha256 of the token - the token itself is shown once and never stored',
  `employee_id`       INT NOT NULL,
  `issued_by_user_id` INT NULL DEFAULT NULL COMMENT 'audit only - carries no authority over the employee',
  `expires_at`        DATETIME NOT NULL,
  `consumed_at`       DATETIME NULL DEFAULT NULL COMMENT 'claimed by one UPDATE - a replayed deep link finds nothing',
  `pending_telegram_user_id` BIGINT NULL DEFAULT NULL,
  `pending_chat_id`         BIGINT NULL DEFAULT NULL,
  `pending_username`        VARCHAR(64) NULL DEFAULT NULL,
  `pending_expires_at`      DATETIME NULL DEFAULT NULL,
  `pending_outcome`   VARCHAR(32) NULL DEFAULT NULL COMMENT 'why the pending verification ended - VERIFIED, MOBILE_MISMATCH, ...',
  `created_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`token_hash`),
  KEY `idx_etlt_employee` (`employee_id`),
  -- The contact message names a Telegram user, not a token, so this is the
  -- index that finds the pending verification it belongs to.
  KEY `idx_etlt_pending` (`pending_telegram_user_id`, `pending_expires_at`),
  CONSTRAINT `fk_etlt_employee` FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================= audit ======
--
-- Append-only, and it holds IDENTIFIERS ONLY.
--
-- There is deliberately no column a token, a mobile number, a message body or
-- a contact card could be written into: the schema is the guarantee, not a
-- convention somebody has to remember at each call site. `detail` is a short
-- fixed code from `constants/employee_telegram.js`, not free text from a user.
CREATE TABLE IF NOT EXISTS `employee_telegram_audit` (
  `audit_id`         BIGINT NOT NULL AUTO_INCREMENT,
  `employee_id`      INT NULL DEFAULT NULL COMMENT 'null when the event could not be tied to an employee',
  `event`            VARCHAR(32) NOT NULL,
  `telegram_user_id` BIGINT NULL DEFAULT NULL,
  `actor_user_id`    INT NULL DEFAULT NULL COMMENT 'the signed-in user who acted, where there was one',
  `detail`           VARCHAR(64) NULL DEFAULT NULL COMMENT 'a fixed code, never free text and never a value',
  `created_at`       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`audit_id`),
  KEY `idx_eta_employee` (`employee_id`, `created_at`),
  KEY `idx_eta_event` (`event`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
