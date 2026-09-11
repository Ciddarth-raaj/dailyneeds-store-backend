-- Biomax historical pull - backend scaffolding (preparation only).
--
-- ADDITIVE ONLY. Three new tables, two new nullable/defaulted columns on
-- biomax_punch, one permission key. No row of any existing table is
-- written, no existing column is altered or dropped, and every Part 1 punch
-- keeps its bytes exactly as received. Guarded so the file re-runs cleanly.
--
-- NOTHING HERE SENDS A COMMAND TO A DEVICE. The tables let the API record a
-- request for backdated punches (GET_LOG_DATA) and let the receiver keep,
-- byte for byte, whatever a device answers. Turning a stored block into
-- punches is deliberately NOT built: the FKDataHS102 historical record
-- layout has not been captured off real hardware and is not guessed here.
-- No attendance is calculated by anything this migration creates.
--
-- Design: docs/biomax-historical-pull.md.

-- ==================================================== 1. pull requests ====
-- One row per administrator request: "device X, punches from A to B".
-- Owned by exactly one device (biomax_device_id, plus dev_id copied
-- verbatim so a result is matched on the string the device actually sends).
--
-- Status flow, and nothing else:
--   REQUESTED       created; the GET_LOG_DATA command is queued (PENDING)
--   WAITING_DEVICE  the device polled and was handed the command (sent_at)
--   RECEIVING       the first send_cmd_result block arrived (first_result_at)
--   COMPLETED       every block is in - set ONLY once the real protocol's
--                   completion semantics are proven; nothing sets it today
--   FAILED          reserved (failed_at, failure_reason) - nothing sets it
--                   until the device's cmd_return_code vocabulary is captured
CREATE TABLE IF NOT EXISTS `biomax_historical_pull` (
  `biomax_historical_pull_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `biomax_device_id`  INT NOT NULL,
  `dev_id`            VARCHAR(32) NOT NULL COMMENT 'Cloud ID verbatim at request time - results are matched on this string',
  `requested_from`    DATETIME NOT NULL COMMENT 'IST wall clock, inclusive',
  `requested_to`      DATETIME NOT NULL COMMENT 'IST wall clock, inclusive - never in the future',
  `status`            ENUM('REQUESTED','WAITING_DEVICE','RECEIVING','COMPLETED','FAILED') NOT NULL DEFAULT 'REQUESTED',
  `trans_id`          VARCHAR(40) NOT NULL COMMENT 'unique per request - the one id that follows the command to the device and back',
  `requested_by`      INT NULL COMMENT 'new_employee.employee_id of the administrator',
  `requested_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `sent_at`           DATETIME(3) NULL COMMENT 'when the device was handed the command on a poll',
  `first_result_at`   DATETIME(3) NULL,
  `completed_at`      DATETIME(3) NULL,
  `failed_at`         DATETIME(3) NULL,
  `failure_reason`    VARCHAR(255) NULL,
  `punches_returned`  INT NOT NULL DEFAULT 0 COMMENT 'decoded punches - stays 0 until a decoder exists',
  `new_punches`       INT NOT NULL DEFAULT 0 COMMENT 'rows the pull ADDED to biomax_punch',
  `duplicate_punches` INT NOT NULL DEFAULT 0 COMMENT 'punches already present from live ingestion (same dev_id, user_id, io_time_raw)',
  `created_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`biomax_historical_pull_id`),
  UNIQUE KEY `uq_bhp_trans_id` (`trans_id`),
  KEY `idx_bhp_dev_status` (`dev_id`, `status`),
  KEY `idx_bhp_requested_at` (`requested_at`),
  CONSTRAINT `fk_bhp_device` FOREIGN KEY (`biomax_device_id`) REFERENCES `biomax_device` (`biomax_device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ==================================================== 2. command queue ====
-- What the receiver may hand a device when it polls (receive_cmd). One row
-- per command; today the only command that can exist is GET_LOG_DATA, and
-- the ENUM makes any other value a database error, not a policy. The
-- dangerous commands (CLEAR_LOG_DATA, CLEAR_ENROLL_DATA, DELETE_USER,
-- RESET_FK, SET_WEB_SERVER_INFO) are refused in code AND cannot be stored.
--
-- Delivery is leased, not fire-and-forget: the receiver claims a command
-- (PENDING, or SENT whose lease expired without any result block, while
-- attempt_count is below the cap) inside one transaction with SELECT ...
-- FOR UPDATE and an UPDATE guarded on status and attempt_count, so racing
-- polls never both receive it. A re-send carries the SAME trans_id
-- (GET_LOG_DATA is read-only and result blocks are deduplicated). The first
-- MATCHED result block marks it ANSWERED and it is never sent again.
CREATE TABLE IF NOT EXISTS `biomax_device_command` (
  `biomax_device_command_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `biomax_historical_pull_id` BIGINT UNSIGNED NOT NULL,
  `trans_id`          VARCHAR(40) NOT NULL,
  `dev_id`            VARCHAR(32) NOT NULL COMMENT 'the ONLY device this command may be handed to',
  `cmd_code`          ENUM('GET_LOG_DATA') NOT NULL,
  `begin_time`        CHAR(14) NOT NULL COMMENT 'YYYYMMDDHHMMSS, device-local IST, as the device expects',
  `end_time`          CHAR(14) NOT NULL,
  `status`            ENUM('PENDING','SENT','ANSWERED','FAILED') NOT NULL DEFAULT 'PENDING' COMMENT 'FAILED is reserved - nothing sets it yet',
  `attempt_count`     INT NOT NULL DEFAULT 0 COMMENT 'how many polls were handed this command',
  `created_at`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `first_sent_at`     DATETIME(3) NULL,
  `sent_at`           DATETIME(3) NULL COMMENT 'latest hand-out - the lease runs from here',
  `answered_at`       DATETIME(3) NULL COMMENT 'first MATCHED result block',
  `sent_to_ip`        VARCHAR(45) NULL COMMENT 'source IP of the latest poll that took the command',
  PRIMARY KEY (`biomax_device_command_id`),
  UNIQUE KEY `uq_bdc_trans_id` (`trans_id`),
  KEY `idx_bdc_dev_status` (`dev_id`, `status`, `created_at`),
  CONSTRAINT `fk_bdc_pull` FOREIGN KEY (`biomax_historical_pull_id`) REFERENCES `biomax_historical_pull` (`biomax_historical_pull_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================== 3. command result blocks ==
-- Every send_cmd_result the receiver sees, RAW. One row per (device,
-- trans_id, block number); the body bytes are stored before anything is
-- decoded, and nothing decodes them yet. A block that arrives again with
-- identical bytes bumps duplicate_count; a block that arrives again with
-- DIFFERENT bytes bumps conflict_count and leaves the stored bytes alone.
-- Out-of-order arrival is just rows with different blk_no.
--
-- match_status records how the block related to what we asked for, so a
-- result for an unknown trans_id, or for a trans_id issued to a different
-- device, is kept and visible but never attached to a pull.
CREATE TABLE IF NOT EXISTS `biomax_command_result_block` (
  `biomax_command_result_block_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `biomax_historical_pull_id` BIGINT UNSIGNED NULL COMMENT 'NULL when the block could not be matched to a pull',
  `dev_id`            VARCHAR(32) NOT NULL COMMENT 'header dev_id verbatim',
  `trans_id`          VARCHAR(40) NOT NULL DEFAULT '' COMMENT 'header trans_id verbatim - empty when absent',
  `cmd_id`            VARCHAR(40) NULL COMMENT 'header cmd_id verbatim',
  `cmd_code`          VARCHAR(40) NULL COMMENT 'header cmd_code verbatim, if the device sends one',
  `cmd_return_code`   VARCHAR(40) NULL COMMENT 'header cmd_return_code verbatim',
  `blk_no`            INT NOT NULL DEFAULT 0,
  `blk_len`           INT NULL,
  `content_length`    INT NULL,
  `headers_json`      TEXT NULL COMMENT 'every request header as received, in order',
  `body_len`          INT NOT NULL DEFAULT 0 COMMENT 'bytes actually received',
  `body_sha256`       CHAR(64) NOT NULL,
  `raw_body`          MEDIUMBLOB NULL COMMENT 'the body bytes exactly as received - decode later, never overwrite',
  `match_status`      ENUM('MATCHED','UNKNOWN_TRANS_ID','WRONG_DEVICE') NOT NULL,
  `source_ip`         VARCHAR(45) NULL,
  `received_at`       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `duplicate_count`   INT NOT NULL DEFAULT 0 COMMENT 'identical retransmissions of this block',
  `conflict_count`    INT NOT NULL DEFAULT 0 COMMENT 'retransmissions of this blk_no with DIFFERENT bytes - stored bytes untouched',
  `last_received_at`  DATETIME(3) NULL,
  PRIMARY KEY (`biomax_command_result_block_id`),
  UNIQUE KEY `uq_bcrb_dev_trans_blk` (`dev_id`, `trans_id`, `blk_no`),
  KEY `idx_bcrb_pull_blk` (`biomax_historical_pull_id`, `blk_no`),
  KEY `idx_bcrb_received` (`received_at`),
  CONSTRAINT `fk_bcrb_pull` FOREIGN KEY (`biomax_historical_pull_id`) REFERENCES `biomax_historical_pull` (`biomax_historical_pull_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================== 4. punch ingest source ====
-- Two ADDITIVE columns on the raw punch table so a row can say whether it
-- came from a live realtime_glog or from a historical pull. Every existing
-- row becomes LIVE by default, which is exactly what it was. The dedup key
-- (dev_id, user_id, io_time_raw) is NOT changed: a historical punch that is
-- already present from live ingestion is a duplicate, never a second row.
-- Guarded: MySQL has no ADD COLUMN IF NOT EXISTS.
SET @has_ingest_source = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'ingest_source'
);
SET @add_ingest_source_sql = IF(
  @has_ingest_source = 0,
  'ALTER TABLE `biomax_punch` ADD COLUMN `ingest_source` ENUM(''LIVE'',''HISTORICAL_PULL'') NOT NULL DEFAULT ''LIVE'' COMMENT ''how the row got here - LIVE realtime_glog or a historical GET_LOG_DATA pull'' AFTER `last_retransmit_at`',
  'SELECT 1'
);
PREPARE add_ingest_source_stmt FROM @add_ingest_source_sql;
EXECUTE add_ingest_source_stmt;
DEALLOCATE PREPARE add_ingest_source_stmt;

SET @has_pull_id = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'biomax_historical_pull_id'
);
SET @add_pull_id_sql = IF(
  @has_pull_id = 0,
  'ALTER TABLE `biomax_punch` ADD COLUMN `biomax_historical_pull_id` BIGINT UNSIGNED NULL COMMENT ''the pull that added this row - NULL for LIVE'' AFTER `ingest_source`, ADD KEY `idx_biomax_punch_pull` (`biomax_historical_pull_id`)',
  'SELECT 1'
);
PREPARE add_pull_id_stmt FROM @add_pull_id_sql;
EXECUTE add_pull_id_stmt;
DEALLOCATE PREPARE add_pull_id_stmt;

-- ===================================================== 5. permission ======
-- Requesting backdated data from a terminal is its own decision. Declared,
-- granted to NOBODY: administrators (user_type 2) bypass the table, and an
-- administrator may grant it to a designation deliberately later.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_biomax_historical_pull' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_biomax_historical_pull');
