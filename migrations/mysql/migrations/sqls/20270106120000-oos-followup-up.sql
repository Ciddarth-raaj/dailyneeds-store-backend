-- Out-of-stock follow-up (utils/oos_followup.js): the daily upload of
-- RetailPilot's out-of-stock report becomes CASES - one (article, store)
-- out of stock, open from the first report it is in until the first report
-- it is missing from - each with its supplier, buyer, likely cause, tier and
-- the buyer's answer.

CREATE TABLE IF NOT EXISTS `oos_uploads` (
  `oos_upload_id` BIGINT NOT NULL AUTO_INCREMENT,
  `report_date`   DATE NOT NULL,
  `file_name`     VARCHAR(255) NULL,
  `total_rows`    INT NOT NULL DEFAULT 0,
  `opened`        INT NOT NULL DEFAULT 0,
  `still_out`     INT NOT NULL DEFAULT 0,
  `closed`        INT NOT NULL DEFAULT 0,
  `skipped`       INT NOT NULL DEFAULT 0,
  `warnings`      TEXT NULL,
  `uploaded_by`   INT NULL,
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`oos_upload_id`),
  KEY `idx_oos_uploads_date` (`report_date`)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `oos_cases` (
  `oos_case_id`   BIGINT NOT NULL AUTO_INCREMENT,
  `article_id`    INT NOT NULL,
  `store`         VARCHAR(64) NOT NULL,
  `article_name`  VARCHAR(255) NULL,
  `category`      VARCHAR(120) NULL,
  `class`         VARCHAR(4) NULL,
  `mrp`           DECIMAL(14,2) NULL,
  `cover_now`     DECIMAL(14,2) NULL,
  `planned`       DECIMAL(14,2) NULL,
  `pct`           DECIMAL(14,2) NULL,
  `stock`         DECIMAL(14,2) NULL,
  `value`         DECIMAL(14,2) NULL,
  `supplier_cid`  VARCHAR(64) NULL,
  `supplier_name` VARCHAR(255) NULL,
  `buyer_id`      INT NULL,
  `buyer_name`    VARCHAR(255) NULL,
  `cause`         VARCHAR(20) NOT NULL,
  `cause_detail`  VARCHAR(255) NULL,
  `po_slug`       VARCHAR(100) NULL,
  `tier`          TINYINT NOT NULL,
  `stores_out`    TINYINT NOT NULL DEFAULT 1,
  `status`        ENUM('open','closed') NOT NULL DEFAULT 'open',
  `opened_on`     DATE NOT NULL,
  `last_seen_on`  DATE NOT NULL,
  `closed_on`     DATE NULL,
  `reason`        VARCHAR(32) NULL,
  `reason_by`     INT NULL,
  `reason_at`     DATETIME NULL,
  `last_note`     VARCHAR(500) NULL,
  `last_note_by`  INT NULL,
  `last_note_at`  DATETIME NULL,
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`oos_case_id`),
  KEY `idx_oos_cases_open_buyer` (`status`, `buyer_id`),
  KEY `idx_oos_cases_article_store` (`article_id`, `store`),
  KEY `idx_oos_cases_closed_on` (`closed_on`)
) ENGINE = InnoDB;

-- Every answer and note on a case, newest last.
CREATE TABLE IF NOT EXISTS `oos_case_events` (
  `oos_case_event_id` BIGINT NOT NULL AUTO_INCREMENT,
  `oos_case_id`       BIGINT NOT NULL,
  `kind`              ENUM('reason','note') NOT NULL,
  `reason`            VARCHAR(32) NULL,
  `note`              VARCHAR(500) NULL,
  `employee_id`       INT NULL,
  `created_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`oos_case_event_id`),
  KEY `idx_oos_case_events_case` (`oos_case_id`)
) ENGINE = InnoDB;

-- upload_oos_report  upload the morning report
-- chase_oos          the chaser's view: every buyer's lines, notes on any line
-- view_my_oos        a buyer's own lines (their suppliers), and answering them
INSERT INTO `all_permissions` (`permission_key`)
  SELECT k FROM (SELECT 'upload_oos_report' AS k UNION ALL SELECT 'chase_oos' UNION ALL SELECT 'view_my_oos') t
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` a WHERE a.`permission_key` = t.k);
