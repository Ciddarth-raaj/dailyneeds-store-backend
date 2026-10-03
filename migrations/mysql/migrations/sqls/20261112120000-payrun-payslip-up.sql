-- Payslip Publish + Telegram notification + Telegram Mini App "My Payslips".
--
-- ADDITIVE ONLY. Two new tables and one nullable column on the lifecycle log.
-- No existing row is written: no month is published, unpublished, unlocked or
-- recalculated by this migration, and no payslip is created for anybody.
--
-- WHAT IS STORED, AND WHAT IS NOT. A payslip is an IMMUTABLE SNAPSHOT of the
-- stored approved calculation, frozen at Publish: the exact JSON text, its
-- SHA-256 and the template version. NO PDF IS STORED - the PDF is rendered on
-- demand from this snapshot, so the Mini App detail and the PDF always show
-- the same figures. Nothing here is a file, a URL or an S3 key.
--
-- `snapshot_json` IS TEXT, NOT JSON. MySQL's JSON type re-serialises what it
-- stores (key order, whitespace), and the SHA-256 beside it is over the exact
-- bytes that were frozen. Storing the text keeps the hash verifiable.
--
-- Every statement is guarded so the file can be re-run without error.

CREATE TABLE IF NOT EXISTS `payrun_payslip` (
  `payslip_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- THE ID THE MINI APP USES. Random, never sequential: a self-service caller
  -- names a payslip by this, and the owner check still applies on top.
  `payslip_ref` CHAR(32) NOT NULL,
  `payrun_employee_id` BIGINT UNSIGNED NOT NULL,
  -- NOT a foreign key: a later Unpublish -> Unlock -> Reset may delete the
  -- calculation row, and the archived payslip must outlive it.
  `payrun_calculation_id` BIGINT UNSIGNED NOT NULL,
  `employee_id`  INT NOT NULL,
  `period_year`  SMALLINT NOT NULL,
  `period_month` TINYINT NOT NULL COMMENT '1-12',
  `payslip_version` INT NOT NULL COMMENT '1, 2, ... per employee month; a republish is a new version',
  `calculation_version`  INT NOT NULL,
  `calculation_revision` INT NOT NULL,
  `calculation_hash` CHAR(32) NOT NULL,
  `source_hash`      CHAR(32) NOT NULL,
  `inputs_hash`      CHAR(32) NOT NULL,
  `snapshot_schema_version` SMALLINT NOT NULL,
  `template_version` VARCHAR(32) NOT NULL,
  `snapshot_json`   MEDIUMTEXT NOT NULL COMMENT 'frozen at Publish; never updated',
  `snapshot_sha256` CHAR(64) NOT NULL,
  `status` ENUM('ACTIVE','ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
  `published_by`      INT NULL DEFAULT NULL,
  `published_by_user` INT NULL DEFAULT NULL,
  `published_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `archived_by`      INT NULL DEFAULT NULL,
  `archived_by_user` INT NULL DEFAULT NULL,
  `archived_at` TIMESTAMP NULL DEFAULT NULL,
  `archive_reason` VARCHAR(500) NULL DEFAULT NULL,
  -- PROOF OF ACCESS ONLY - the employee opened the detail in the Mini App.
  -- It is not an acceptance or an agreement and nothing reads it as one.
  `first_viewed_at` TIMESTAMP NULL DEFAULT NULL,
  `last_viewed_at`  TIMESTAMP NULL DEFAULT NULL,
  `view_count` INT NOT NULL DEFAULT 0,
  -- AT MOST ONE ACTIVE PAYSLIP PER EMPLOYEE MONTH, in the database.
  `active_payrun_marker` BIGINT UNSIGNED GENERATED ALWAYS AS
     (CASE WHEN `status` = 'ACTIVE' THEN `payrun_employee_id` ELSE NULL END) STORED,
  PRIMARY KEY (`payslip_id`),
  UNIQUE KEY `uq_payrun_payslip_ref` (`payslip_ref`),
  UNIQUE KEY `uq_payrun_payslip_version` (`payrun_employee_id`, `payslip_version`),
  UNIQUE KEY `uq_payrun_payslip_active` (`active_payrun_marker`),
  KEY `idx_payrun_payslip_employee` (`employee_id`, `status`),
  KEY `idx_payrun_payslip_month` (`period_year`, `period_month`),
  CONSTRAINT `fk_payrun_payslip_payrun`
    FOREIGN KEY (`payrun_employee_id`) REFERENCES `payrun_employee` (`payrun_employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='immutable published payslip snapshots; ARCHIVED rows are kept as history';

-- ONE ROW PER NOTIFICATION ATTEMPT - AN OUTBOX. Publish inserts attempt 1 as
-- QUEUED in the SAME transaction that publishes, so a committed publication
-- always has its notification queued and a rolled-back one never does. The
-- in-process worker (usecase/payslip_notification.js) claims QUEUED rows
-- (-> SENDING, with a claim token), sends, and records the outcome; the HTTP
-- request that published never waits on Telegram.
--
-- Publication and notification are separate facts: a failed or impossible
-- notification never unpublishes. The message carries no salary figure, and
-- neither does this table.
--
-- AT MOST ONE PENDING (QUEUED / SENDING) ATTEMPT PER PAYSLIP, in the database:
-- two Retry clicks cannot queue two sends.
CREATE TABLE IF NOT EXISTS `payrun_payslip_notification` (
  `notification_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `payslip_id`  BIGINT UNSIGNED NOT NULL,
  `employee_id` INT NOT NULL,
  `attempt_no`  INT NOT NULL,
  `trigger_type` ENUM('PUBLISH','RETRY') NOT NULL,
  `result` ENUM('QUEUED','SENDING','SENT','FAILED','NO_TELEGRAM_LINK') NOT NULL DEFAULT 'QUEUED',
  `employee_telegram_id` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT 'the identity row used; server-resolved at send time',
  `private_chat_id` BIGINT NULL DEFAULT NULL COMMENT 'internal only; never sent to a browser',
  `telegram_message_id` BIGINT NULL DEFAULT NULL,
  `failure_code`   VARCHAR(64)  NULL DEFAULT NULL,
  `failure_reason` VARCHAR(255) NULL DEFAULT NULL,
  `requested_by`      INT NULL DEFAULT NULL,
  `requested_by_user` INT NULL DEFAULT NULL,
  `queued_at`    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `claim_token`  CHAR(32) NULL DEFAULT NULL COMMENT 'which worker pass owns a SENDING row',
  `attempted_at` TIMESTAMP(3) NULL DEFAULT NULL COMMENT 'claimed for sending',
  `completed_at` TIMESTAMP(3) NULL DEFAULT NULL,
  `pending_payslip_marker` BIGINT UNSIGNED GENERATED ALWAYS AS
     (CASE WHEN `result` IN ('QUEUED','SENDING') THEN `payslip_id` ELSE NULL END) STORED,
  PRIMARY KEY (`notification_id`),
  UNIQUE KEY `uq_payslip_notification_attempt` (`payslip_id`, `attempt_no`),
  UNIQUE KEY `uq_payslip_notification_pending` (`pending_payslip_marker`),
  KEY `idx_payslip_notification_queue` (`result`, `notification_id`),
  KEY `idx_payslip_notification_employee` (`employee_id`),
  CONSTRAINT `fk_payslip_notification_payslip`
    FOREIGN KEY (`payslip_id`) REFERENCES `payrun_payslip` (`payslip_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='append-only outbox: each Telegram payslip-available notification attempt';

-- WHICH PAYSLIP A PUBLISH CREATED OR AN UNPUBLISH ARCHIVED, on the lifecycle log.
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_lifecycle_audit'
                  AND `COLUMN_NAME` = 'payslip_id') = 0,
  'ALTER TABLE `payrun_employee_lifecycle_audit` ADD COLUMN `payslip_id` BIGINT UNSIGNED NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
