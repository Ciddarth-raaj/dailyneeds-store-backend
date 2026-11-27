-- Stock Audit, phase 2: bulk RetailPilot CSV allotment import and the
-- Stock Audit Premier League (SAPL). NEW TABLES ONLY: no existing table is
-- altered and no existing row is changed. Employee mapping reuses the
-- existing wh_rp_staff_map (same Keypoint user ids); branch mapping reuses
-- outlets.retailpilot_id.

-- RetailPilot users seen in allotment files or audit sessions (name as
-- RetailPilot shows it), so the mapping screen can list unmapped users.
CREATE TABLE IF NOT EXISTS `sa_rp_user` (
  `rp_user_id`   VARCHAR(100) NOT NULL COMMENT 'Keypoint user id, as in wh_rp_staff_map.rp_user_id',
  `rp_name`      VARCHAR(160) NULL,
  `last_rp_store_id` VARCHAR(32) NULL,
  `first_seen_at` TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at`  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`rp_user_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- One bulk upload: HR picks the audit period, uploads every auditor's CSV,
-- validates, then confirms. Nothing reaches sa_allotment before CONFIRMED.
CREATE TABLE IF NOT EXISTS `sa_allotment_batch` (
  `batch_id`        BIGINT       NOT NULL AUTO_INCREMENT,
  `period_code`     VARCHAR(16)  NOT NULL COMMENT 'audit period (sa_cycle.period_code) HR selected',
  `status`          ENUM('VALIDATED','CONFIRMED','DISCARDED') NOT NULL DEFAULT 'VALIDATED',
  `file_count`      INT          NOT NULL DEFAULT 0,
  `summary_json`    JSON         NULL COMMENT 'validation totals shown before confirming',
  `created_by`      INT          NULL,
  `confirmed_by`    INT          NULL,
  `confirmed_at`    TIMESTAMP    NULL,
  `created_at`      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`batch_id`),
  KEY `idx_sa_allotment_batch_period` (`period_code`, `status`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- One CSV in a batch. A CONFIRMED file is one auditor's allotment REVISION
-- for one store cycle; a corrected file becomes the next revision.
CREATE TABLE IF NOT EXISTS `sa_allotment_file` (
  `file_id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `batch_id`        BIGINT       NOT NULL,
  `file_name`       VARCHAR(255) NOT NULL,
  `content_sha1`    CHAR(40)     NOT NULL COMMENT 'fingerprint of the normalised rows: same rows = same file',
  `rp_store_id`     VARCHAR(32)  NULL,
  `outlet_id`       INT          NULL,
  `cycle_id`        BIGINT       NULL,
  `rp_user_id`      VARCHAR(100) NULL,
  `rp_user_name`    VARCHAR(160) NULL,
  `employee_id`     INT          NULL COMMENT 'mapping at upload time; NULL = unmapped',
  `validation`      ENUM('VALID','WARNINGS','CONFLICT','REJECTED','ALREADY_IMPORTED') NOT NULL,
  `auditable`       INT          NOT NULL DEFAULT 0 COMMENT 'Effective = Y',
  `not_auditable`   INT          NOT NULL DEFAULT 0 COMMENT 'Effective = N',
  `line_errors`     INT          NOT NULL DEFAULT 0,
  `issues_json`     JSON         NULL,
  `revision`        INT          NULL COMMENT 'set when CONFIRMED',
  `diff_json`       JSON         NULL COMMENT 'added / removed / unchanged vs the previous revision',
  `state`           ENUM('STAGED','CURRENT','SUPERSEDED','DISCARDED') NOT NULL DEFAULT 'STAGED',
  `created_at`      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`file_id`),
  -- one revision number per auditor per store cycle, whatever runs concurrently
  UNIQUE KEY `uq_sa_allotment_file_revision` (`cycle_id`, `rp_user_id`, `revision`),
  KEY `idx_sa_allotment_file_batch` (`batch_id`),
  KEY `idx_sa_allotment_file_current` (`cycle_id`, `rp_user_id`, `state`),
  KEY `idx_sa_allotment_file_sha` (`cycle_id`, `content_sha1`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Every row of every staged / confirmed file (revision history).
CREATE TABLE IF NOT EXISTS `sa_allotment_line` (
  `file_id`     BIGINT     NOT NULL,
  `article_id`  INT        NOT NULL,
  `effective`   CHAR(1)    NOT NULL COMMENT 'Y = auditable, N = not auditable',
  `article_name` VARCHAR(255) NULL,
  PRIMARY KEY (`file_id`, `article_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- The CURRENT allotment: one row per (store cycle, auditor, article).
CREATE TABLE IF NOT EXISTS `sa_allotment` (
  `cycle_id`    BIGINT       NOT NULL,
  `outlet_id`   INT          NOT NULL,
  `rp_user_id`  VARCHAR(100) NOT NULL,
  `article_id`  INT          NOT NULL,
  `effective`   CHAR(1)      NOT NULL,
  `file_id`     BIGINT       NOT NULL,
  -- NULL for Effective = N, so only AUDITABLE rows take part in the guard below
  `auditable_article_id` INT AS (IF(`effective` = 'Y', `article_id`, NULL)) STORED,
  `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`cycle_id`, `rp_user_id`, `article_id`),
  -- THE conflicting-allotment guard: one auditor per auditable article per store cycle
  UNIQUE KEY `uq_sa_allotment_auditable` (`cycle_id`, `auditable_article_id`),
  KEY `idx_sa_allotment_article` (`cycle_id`, `article_id`),
  KEY `idx_sa_allotment_file` (`file_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- Premier League
-- A season is one audit period. Scoring weights are confirmed (35/40/20/5);
-- qualification, tie-breakers and the prize distribution method stay
-- CONFIGURABLE in rules_json until management confirms them.
CREATE TABLE IF NOT EXISTS `sa_sapl_season` (
  `season_id`     BIGINT        NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(120)  NOT NULL,
  `period_code`   VARCHAR(16)   NOT NULL,
  `start_date`    DATE          NOT NULL,
  `deadline`      DATE          NOT NULL COMMENT 'common deadline for every store',
  `prize_amount`  DECIMAL(12,2) NOT NULL DEFAULT 10000.00,
  `rules_json`    JSON          NOT NULL COMMENT 'weights (locked) + qualification / tie-breakers / prize method (configurable)',
  `status`        ENUM('DRAFT','OPEN','AWAITING_VERIFICATION','VERIFIED','FINAL','CLOSED') NOT NULL DEFAULT 'DRAFT',
  `verified_by`   INT           NULL COMMENT 'independent verifier; never the person who finalises',
  `verified_at`   TIMESTAMP     NULL,
  `finalized_by`  INT           NULL,
  `finalized_at`  TIMESTAMP     NULL,
  `winner_outlet_id` INT        NULL,
  `created_by`    INT           NULL,
  `created_at`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`season_id`),
  UNIQUE KEY `uq_sa_sapl_season_period` (`period_code`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Daily standings: provisional every day; is_final only after verification.
CREATE TABLE IF NOT EXISTS `sa_sapl_standing` (
  `season_id`     BIGINT       NOT NULL,
  `standing_date` DATE         NOT NULL,
  `outlet_id`     INT          NOT NULL,
  `points_json`   JSON         NOT NULL COMMENT 'per KPI: measure cell and points (pending KPIs carry no points)',
  `total_points`  DECIMAL(6,1) NOT NULL,
  `complete`      TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = every KPI measured',
  `rank_no`       INT          NULL,
  `is_final`      TINYINT(1)   NOT NULL DEFAULT 0,
  `computed_at`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`season_id`, `standing_date`, `outlet_id`),
  KEY `idx_sa_sapl_standing_store` (`outlet_id`, `season_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Prize distribution DRAFT for the winning store. Never posted to payroll by
-- this module; the method is whatever the season's rules_json names.
CREATE TABLE IF NOT EXISTS `sa_sapl_prize_share` (
  `season_id`    BIGINT        NOT NULL,
  `employee_id`  INT           NOT NULL,
  `outlet_id`    INT           NOT NULL,
  `method`       VARCHAR(32)   NOT NULL,
  `basis_json`   JSON          NULL,
  `amount`       DECIMAL(12,2) NOT NULL,
  `status`       ENUM('DRAFT','APPROVED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  `created_by`   INT           NULL,
  `created_at`   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`season_id`, `employee_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
