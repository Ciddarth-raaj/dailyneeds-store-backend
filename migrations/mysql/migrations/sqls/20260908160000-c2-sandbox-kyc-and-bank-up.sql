-- Stage 0C / C2 — Sandbox Aadhaar OKYC and Penny-Less bank verification.
-- ADDITIVE ONLY. No employee row is written, and `new_employee` gains no
-- column: the bank columns it already has (`account_no`, `ifsc`,
-- `bank_name`) are adequate and B3 already protects them, so the VERIFICATION
-- METADATA is added beside them rather than migrating them out.

-- ------------------------------------------------- Aadhaar OTP session
-- The OKYC flow is two provider calls with a wait in between, so the
-- verification row now starts life as `initiated` and only becomes
-- `verified` when Sandbox confirms the OTP. Without this state a row would
-- have to be created as `verified` before it was, which is exactly the
-- confusion the state machine exists to prevent.
ALTER TABLE `employee_aadhaar_verification`
  MODIFY COLUMN `status`
    ENUM('initiated','verified','failed','expired','consumed') NOT NULL;

-- The columns below are added one statement at a time, each skipped if it is
-- already there. MySQL has no `ADD COLUMN IF NOT EXISTS`, and a migration
-- that cannot be re-run is a migration that cannot be recovered halfway
-- through - which is precisely when it matters. A stored procedure would say
-- this in a quarter of the lines, but it would need DELIMITER, which is a
-- mysql-client directive the migration runner does not speak.

-- `provider_reference_id` — Sandbox's handle for the OTP attempt, needed by the verify call. Stored
--   rather than returned, so a browser never carries it.
SET @add_provider_reference_id = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_aadhaar_verification'
      AND `COLUMN_NAME` = 'provider_reference_id') = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD COLUMN `provider_reference_id` VARCHAR(128) NULL AFTER `provider_reference`',
  'DO 0');
PREPARE add_stmt FROM @add_provider_reference_id;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- `provider_transaction_id` — Provider transaction id, for raising a support ticket with Sandbox.
SET @add_provider_transaction_id = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_aadhaar_verification'
      AND `COLUMN_NAME` = 'provider_transaction_id') = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD COLUMN `provider_transaction_id` VARCHAR(128) NULL AFTER `provider_reference_id`',
  'DO 0');
PREPARE add_stmt FROM @add_provider_transaction_id;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- `failure_category` — A stable internal category, never the provider's own message.
SET @add_failure_category = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_aadhaar_verification'
      AND `COLUMN_NAME` = 'failure_category') = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD COLUMN `failure_category` VARCHAR(64) NULL AFTER `failure_reason`',
  'DO 0');
PREPARE add_stmt FROM @add_failure_category;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- `otp_attempts` — The attempt limit's counter.
SET @add_otp_attempts = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_aadhaar_verification'
      AND `COLUMN_NAME` = 'otp_attempts') = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD COLUMN `otp_attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER `failure_category`',
  'DO 0');
PREPARE add_stmt FROM @add_otp_attempts;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- `initiated_by_employee_id` — The session belongs to the HR user who started it; another actor may not
--   finish it.
SET @add_initiated_by_employee_id = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_aadhaar_verification'
      AND `COLUMN_NAME` = 'initiated_by_employee_id') = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD COLUMN `initiated_by_employee_id` INT NULL AFTER `otp_attempts`',
  'DO 0');
PREPARE add_stmt FROM @add_initiated_by_employee_id;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- `initiated_at` — When the OTP was sent, which is what the expiry is measured from.
SET @add_initiated_at = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_aadhaar_verification'
      AND `COLUMN_NAME` = 'initiated_at') = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD COLUMN `initiated_at` TIMESTAMP NULL DEFAULT NULL AFTER `initiated_by_employee_id`',
  'DO 0');
PREPARE add_stmt FROM @add_initiated_at;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- `session_token` — An opaque handle for the client. The numeric verification_id is a
--   sequence and therefore guessable; this is not.
SET @add_session_token = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_aadhaar_verification'
      AND `COLUMN_NAME` = 'session_token') = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD COLUMN `session_token` CHAR(64) NULL AFTER `initiated_at`',
  'DO 0');
PREPARE add_stmt FROM @add_session_token;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- The token is the session's handle, so two sessions may not share one.
-- NULL is exempt from a UNIQUE key in MySQL, which is what lets the
-- pre-existing rows keep a NULL token.
SET @has_token_key = (
  SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
   WHERE `TABLE_SCHEMA` = DATABASE()
     AND `TABLE_NAME` = 'employee_aadhaar_verification'
     AND `INDEX_NAME` = 'uq_aadhaar_verification_session_token'
);
SET @token_key_sql = IF(
  @has_token_key = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD UNIQUE KEY `uq_aadhaar_verification_session_token` (`session_token`)',
  'DO 0'
);
PREPARE token_key_stmt FROM @token_key_sql;
EXECUTE token_key_stmt;
DEALLOCATE PREPARE token_key_stmt;

-- ------------------------------------------------------ bank verification
-- One row per employee, holding the outcome of the last Penny-Less check.
--
-- `account_fingerprint` is what makes invalidation reliable: it is a keyed
-- HMAC of (account_number, ifsc), so when either changes the fingerprint
-- changes and the stored verification no longer describes the account on
-- file. Comparing it is how the application knows a VERIFIED status has gone
-- stale, without ever holding the account number here.
CREATE TABLE IF NOT EXISTS `employee_bank_verification` (
  `bank_verification_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`          INT NOT NULL,
  `status`               ENUM('NOT_PROVIDED','PENDING','VERIFIED','NAME_MISMATCH','FAILED')
                         NOT NULL DEFAULT 'NOT_PROVIDED',
  -- Keyed HMAC of the account+IFSC the verification was performed against.
  `account_fingerprint`  CHAR(64) NULL,
  `account_last4`        CHAR(4) NULL,
  `ifsc`                 VARCHAR(11) NULL,
  -- What the bank returned. A name, not an identifier - and the whole point
  -- of the check, so it is stored in full.
  `name_at_bank`         VARCHAR(255) NULL,
  `account_exists`       TINYINT(1) NULL,
  `name_match_verdict`   ENUM('MATCH','REVIEW','MISMATCH') NULL,
  `name_match_reason`    VARCHAR(255) NULL,
  `name_match_score`     DECIMAL(4,3) NULL,
  `provider`             VARCHAR(45) NULL,
  `provider_transaction_id` VARCHAR(128) NULL,
  `provider_status`      VARCHAR(64) NULL,
  `failure_category`     VARCHAR(64) NULL,
  `verified_at`          TIMESTAMP NULL DEFAULT NULL,
  `last_attempted_at`    TIMESTAMP NULL DEFAULT NULL,
  -- Who accepted a REVIEW verdict, and when. A confirmation nobody can be
  -- named for is not a confirmation.
  `confirmed_by_employee_id` INT NULL,
  `confirmed_at`         TIMESTAMP NULL DEFAULT NULL,
  `confirmation_note`    VARCHAR(255) NULL,
  `created_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`bank_verification_id`),
  UNIQUE KEY `uq_bank_verification_employee` (`employee_id`),
  KEY `idx_bank_verification_status` (`status`),
  CONSTRAINT `fk_bank_verification_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every attempt, kept. The current status lives above; this is the audit
-- trail of how it got there, including the failures.
CREATE TABLE IF NOT EXISTS `employee_bank_verification_attempt` (
  `attempt_id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`          INT NOT NULL,
  `account_fingerprint`  CHAR(64) NULL,
  `account_last4`        CHAR(4) NULL,
  `ifsc`                 VARCHAR(11) NULL,
  `outcome`              VARCHAR(32) NOT NULL,
  `account_exists`       TINYINT(1) NULL,
  `name_at_bank`         VARCHAR(255) NULL,
  `name_match_verdict`   VARCHAR(16) NULL,
  `failure_category`     VARCHAR(64) NULL,
  `provider`             VARCHAR(45) NULL,
  `provider_transaction_id` VARCHAR(128) NULL,
  `requested_by_employee_id` INT NULL,
  `created_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`attempt_id`),
  KEY `idx_bank_attempt_employee` (`employee_id`, `created_at`),
  CONSTRAINT `fk_bank_attempt_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------ permissions
-- Running a paid external verification, and accepting a name that did not
-- quite match, are separate decisions from editing an employee. Declared
-- only; granted to nobody, so no designation gains anything when this runs.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'verify_employee_bank' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'verify_employee_bank');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'confirm_bank_name_mismatch' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'confirm_bank_name_mismatch');
