-- Stock Audit (foundation). RetailPilot runs the audit: allotment, physical
-- counting and recounts all happen there. DNDS only MIRRORS what RetailPilot
-- recorded (sa_rp_*, read-only copies keyed by RetailPilot's own slugs, so a
-- re-read is an idempotent upsert) and keeps its OWN records of audit cycles,
-- verification results read from RetailPilot, incentives, KPI scores,
-- variance closure and approvals. Nothing here posts to payroll.
--
-- Source tables (runway SPECTRA): public.stock_audit_count_session,
-- public.stock_audit_count_line, public.stock_ledgers (STK_ADJ rows).

-- ---------------------------------------------------------------- mirror
CREATE TABLE IF NOT EXISTS `sa_rp_session` (
  `rp_slug`            VARCHAR(64)  NOT NULL COMMENT 'stock_audit_count_session.slug',
  `rp_store_id`        VARCHAR(32)  NOT NULL COMMENT 'RetailPilot store slug',
  `outlet_id`          INT          NULL     COMMENT 'outlets.outlet_id via outlets.retailpilot_id; NULL = unmapped',
  `article_id`         INT          NOT NULL COMMENT 'masterhub.articles.slug',
  `stock_location`     VARCHAR(32)  NULL,
  `status`             VARCHAR(20)  NOT NULL COMMENT 'FINALIZED / IN_PROGRESS / CANCELLED / PENDING_BATCH, as RetailPilot reports',
  `initiated_by`       VARCHAR(64)  NULL     COMMENT 'Keypoint user id',
  `finalized_by`       VARCHAR(64)  NULL     COMMENT 'Keypoint user id',
  `started_at`         DATETIME(6)  NULL     COMMENT 'UTC',
  `finalized_at`       DATETIME(6)  NULL     COMMENT 'UTC',
  `rp_updated_at`      DATETIME(6)  NOT NULL COMMENT 'UTC; the sync watermark',
  `net_adj_action`     VARCHAR(20)  NULL,
  `marker_ledger_slug` VARCHAR(64)  NULL,
  `recount_slug`       VARCHAR(64)  NULL     COMMENT 'kept verbatim; its meaning is confirmed only after real recounts are inspected',
  `cancel_reason`      VARCHAR(64)  NULL,
  `var_qty`            DECIMAL(16,3) NULL    COMMENT 'booked net qty from the finalize marker',
  `var_value`          DECIMAL(16,2) NULL    COMMENT 'booked net value at landing cost',
  `has_lines`          TINYINT(1)   NOT NULL DEFAULT 0,
  `cycle_id`           BIGINT       NULL,
  `row_hash`           CHAR(40)     NOT NULL COMMENT 'sha1 of the source row; unchanged hash = no-op upsert',
  `first_seen_at`      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_synced_at`     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`rp_slug`),
  KEY `idx_sa_rp_session_article` (`rp_store_id`, `article_id`, `stock_location`),
  KEY `idx_sa_rp_session_finalized` (`outlet_id`, `finalized_at`),
  KEY `idx_sa_rp_session_user` (`finalized_by`),
  KEY `idx_sa_rp_session_cycle` (`cycle_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_rp_line` (
  `rp_slug`        VARCHAR(64)   NOT NULL COMMENT 'stock_audit_count_line.slug',
  `session_slug`   VARCHAR(64)   NOT NULL,
  `stock_location` VARCHAR(32)   NULL,
  `batch_id`       VARCHAR(128)  NULL,
  `mrp`            DECIMAL(14,2) NULL,
  `counted_qty`    DECIMAL(16,3) NULL,
  `snapshot_qty`   DECIMAL(16,3) NULL,
  `snapshot_cells` JSON          NULL,
  `source`         VARCHAR(20)   NULL,
  `holding_type`   VARCHAR(32)   NULL,
  `status`         VARCHAR(20)   NULL,
  `rp_created_at`  DATETIME(6)   NULL,
  `rp_updated_at`  DATETIME(6)   NOT NULL,
  `row_hash`       CHAR(40)      NOT NULL,
  `last_synced_at` TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`rp_slug`),
  KEY `idx_sa_rp_line_session` (`session_slug`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_rp_adjustment` (
  `rp_ledger_slug`   VARCHAR(64)   NOT NULL COMMENT 'stock_ledgers.slug (action STK_ADJ)',
  `session_slug`     VARCHAR(64)   NULL     COMMENT 'NULL = an STK_ADJ not (yet) tied to a count session',
  `is_marker`        TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = the zero-qty finalize marker',
  `rp_store_id`      VARCHAR(32)   NOT NULL,
  `article_id`       INT           NOT NULL,
  `batch_id`         VARCHAR(128)  NULL,
  `stock_location`   VARCHAR(32)   NULL,
  `quantity`         DECIMAL(16,3) NOT NULL,
  `net_landing_cost` DECIMAL(16,4) NULL,
  `mrp`              DECIMAL(14,2) NULL,
  `traceability`     JSON          NULL,
  `ts`               DATETIME(6)   NOT NULL COMMENT 'UTC',
  `row_hash`         CHAR(40)      NOT NULL,
  `last_synced_at`   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`rp_ledger_slug`),
  KEY `idx_sa_rp_adjustment_session` (`session_slug`),
  KEY `idx_sa_rp_adjustment_match` (`rp_store_id`, `article_id`, `ts`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- sync
CREATE TABLE IF NOT EXISTS `sa_sync_state` (
  `stream`           VARCHAR(20)  NOT NULL COMMENT 'session / line / adjustment',
  `watermark_ts`     DATETIME(6)  NULL     COMMENT 'UTC; advanced only after a fully successful run',
  `watermark_slug`   VARCHAR(64)  NULL,
  `last_success_run` BIGINT       NULL,
  `updated_at`       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`stream`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_sync_run` (
  `run_id`       BIGINT       NOT NULL AUTO_INCREMENT,
  `kind`         ENUM('HISTORICAL','INCREMENTAL','RECONCILE','DRY_RUN') NOT NULL,
  `run_trigger`  ENUM('cron','manual') NOT NULL,
  `started_by`   INT          NULL,
  `status`       ENUM('RUNNING','SUCCESS','FAILED','DEFERRED') NOT NULL DEFAULT 'RUNNING',
  `resume_after` TIMESTAMP    NULL COMMENT 'DEFERRED: RetailPilot asked us to wait (Retry-After) until then',
  `window_json`  JSON         NULL COMMENT 'per stream: from (ts, slug) and to (ts, slug)',
  `counts_json`  JSON         NULL COMMENT 'per stream: pages, read, inserted, updated, unchanged',
  `issue_count`  INT          NOT NULL DEFAULT 0,
  `error`        TEXT         NULL COMMENT 'never holds keys or headers',
  `started_at`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at`  TIMESTAMP    NULL,
  PRIMARY KEY (`run_id`),
  KEY `idx_sa_sync_run_started` (`started_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_sync_issue` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `run_id`     BIGINT       NOT NULL,
  `kind`       VARCHAR(32)  NOT NULL COMMENT 'UNMAPPED_USER / UNMAPPED_STORE / FAILED_RECORD / NO_LINES / STALE_IN_PROGRESS / RECONCILE_MISMATCH',
  `rp_ref`     VARCHAR(128) NOT NULL,
  `detail`     TEXT         NULL,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_sync_issue` (`run_id`, `kind`, `rp_ref`),
  KEY `idx_sa_sync_issue_kind` (`kind`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------- DNDS records
CREATE TABLE IF NOT EXISTS `sa_cycle` (
  `cycle_id`    BIGINT       NOT NULL AUTO_INCREMENT,
  `outlet_id`   INT          NOT NULL,
  `name`        VARCHAR(120) NOT NULL,
  `period_code` VARCHAR(16)  NOT NULL COMMENT 'audit period the store cycles belong to, e.g. 2026-Q4; the Operations Manager incentive is per period',
  `start_date`  DATE         NOT NULL,
  `end_date`    DATE         NOT NULL,
  `deadline`    DATE         NOT NULL,
  `status`      ENUM('DRAFT','OPEN','CLOSED','APPROVED') NOT NULL DEFAULT 'DRAFT',
  `created_by`  INT          NULL,
  `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`cycle_id`),
  UNIQUE KEY `uq_sa_cycle_outlet_start` (`outlet_id`, `start_date`),
  UNIQUE KEY `uq_sa_cycle_outlet_period` (`outlet_id`, `period_code`),
  KEY `idx_sa_cycle_period` (`period_code`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Verification results are READ FROM RetailPilot recounts (no entry screen in
-- DNDS). One row per recount; the article's verdict is derived from its rows
-- (utils/stock_audit_verification.js). Columns stay neutral until real
-- recounts have been inspected.
CREATE TABLE IF NOT EXISTS `sa_verification` (
  `id`                    BIGINT        NOT NULL AUTO_INCREMENT,
  `cycle_id`              BIGINT        NOT NULL,
  `outlet_id`             INT           NOT NULL,
  `article_id`            INT           NOT NULL,
  `original_session_slug` VARCHAR(64)   NOT NULL,
  `recount_ref`           VARCHAR(64)   NOT NULL COMMENT 'RetailPilot reference of the recount',
  `original_user`         VARCHAR(64)   NULL,
  `recount_user`          VARCHAR(64)   NULL,
  `original_qty`          DECIMAL(16,3) NULL COMMENT 'original PHYSICAL count, never book stock',
  `recount_qty`           DECIMAL(16,3) NULL,
  `original_at`           DATETIME(6)   NULL,
  `recount_at`            DATETIME(6)   NULL,
  `net_movement_qty`      DECIMAL(16,3) NULL COMMENT 'genuine physical movements between the counts',
  `expected_qty`          DECIMAL(16,3) NULL,
  `verdict`               ENUM('MATCH','MISMATCH','UNRESOLVED','NOT_INDEPENDENT') NOT NULL,
  `verdict_reason`        VARCHAR(40)   NULL,
  `review_status`         ENUM('NONE','CONFIRMED','KEPT_UNRESOLVED') NOT NULL DEFAULT 'NONE',
  `review_note`           VARCHAR(500)  NULL,
  `reviewed_by`           INT           NULL,
  `reviewed_at`           TIMESTAMP     NULL,
  `created_at`            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_verification_recount` (`recount_ref`),
  KEY `idx_sa_verification_article` (`cycle_id`, `outlet_id`, `article_id`),
  KEY `idx_sa_verification_original` (`original_session_slug`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Eligibility of one (cycle, store, article) for the employee incentive:
-- computed (utils/stock_audit_eligibility.js) and, where ambiguous,
-- decided by a reviewer. Never "first finalized wins".
CREATE TABLE IF NOT EXISTS `sa_eligibility` (
  `cycle_id`              BIGINT       NOT NULL,
  `outlet_id`             INT          NOT NULL,
  `article_id`            INT          NOT NULL,
  `status`                ENUM('ELIGIBLE','PENDING_ELIGIBILITY_REVIEW','NOT_ELIGIBLE','EXCLUDED','NOT_APPLICABLE') NOT NULL,
  `reasons_json`          JSON         NULL,
  `original_session_slug` VARCHAR(64)  NULL,
  `rp_user_id`            VARCHAR(64)  NULL,
  `employee_id`           INT          NULL,
  `review_decision`       ENUM('AWARD','NOT_ELIGIBLE') NULL,
  `review_employee_id`    INT          NULL,
  `review_note`           VARCHAR(500) NULL,
  `reviewed_by`           INT          NULL,
  `reviewed_at`           TIMESTAMP    NULL,
  `computed_at`           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`cycle_id`, `outlet_id`, `article_id`),
  KEY `idx_sa_eligibility_status` (`cycle_id`, `status`),
  KEY `idx_sa_eligibility_employee` (`cycle_id`, `employee_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Awarded articles: one employee incentive per (cycle, store, article).
CREATE TABLE IF NOT EXISTS `sa_incentive_article` (
  `cycle_id`     BIGINT      NOT NULL,
  `outlet_id`    INT         NOT NULL,
  `article_id`   INT         NOT NULL,
  `employee_id`  INT         NOT NULL,
  `session_slug` VARCHAR(64) NOT NULL,
  `status`       ENUM('AWARDED','REVOKED') NOT NULL DEFAULT 'AWARDED',
  `rule_set_version` INT     NOT NULL,
  `created_at`   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- THE duplicate guard: one (cycle, store, article), whatever runs concurrently.
  PRIMARY KEY (`cycle_id`, `outlet_id`, `article_id`),
  UNIQUE KEY `uq_sa_incentive_article_session` (`session_slug`),
  KEY `idx_sa_incentive_article_employee` (`cycle_id`, `employee_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_rule_set` (
  `version`     INT          NOT NULL AUTO_INCREMENT,
  `rules_json`  JSON         NOT NULL,
  `status`      ENUM('DRAFT','APPROVED','RETIRED') NOT NULL DEFAULT 'DRAFT',
  `note`        VARCHAR(255) NULL,
  `supersedes`  INT          NULL COMMENT 'version this one replaces when approved',
  `created_by`  INT          NULL,
  `approved_by` INT          NULL,
  `approved_at` TIMESTAMP    NULL,
  `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`version`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_employee_incentive` (
  `id`                 BIGINT        NOT NULL AUTO_INCREMENT,
  `cycle_id`           BIGINT        NOT NULL,
  `outlet_id`          INT           NOT NULL,
  `employee_id`        INT           NOT NULL,
  `rp_user_id`         VARCHAR(64)   NULL,
  `audited_articles`   INT           NOT NULL DEFAULT 0,
  `eligible_articles`  INT           NOT NULL DEFAULT 0,
  `pending_articles`   INT           NOT NULL DEFAULT 0,
  `sample_required`    INT           NOT NULL DEFAULT 0,
  `sample_verified`    INT           NOT NULL DEFAULT 0,
  `sample_matched`     INT           NOT NULL DEFAULT 0,
  `accuracy_pct`       DECIMAL(7,4)  NULL COMMENT 'NULL = not decided (never stored as 0 or 100)',
  `rate`               DECIMAL(8,2)  NULL,
  `amount`             DECIMAL(12,2) NULL COMMENT 'NULL unless calc_status = CALCULATED',
  `calc_status`        VARCHAR(32)   NOT NULL COMMENT 'NOT_APPLICABLE / PENDING_VERIFICATION / INSUFFICIENT_SAMPLE / PENDING_ELIGIBILITY_REVIEW / CALCULATED',
  `status`             ENUM('DRAFT','APPROVED','REVOKED','POSTED') NOT NULL DEFAULT 'DRAFT',
  `rule_set_version`   INT           NOT NULL,
  `snapshot_json`      JSON          NULL COMMENT 'the inputs the figures were calculated from',
  `calculated_by`      INT           NULL,
  `revoked_by`         INT           NULL,
  `revoked_at`         TIMESTAMP     NULL,
  `revoke_reason`      VARCHAR(500)  NULL,
  `created_at`         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_employee_incentive` (`cycle_id`, `employee_id`),
  KEY `idx_sa_employee_incentive_outlet` (`outlet_id`, `status`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Supervisor / Store Manager per store, Operations Manager per period.
-- outlet_id 0 = the whole programme (Operations Manager): NOT NULL on
-- purpose, because a NULL in a unique key would allow duplicates in MySQL.
CREATE TABLE IF NOT EXISTS `sa_management_incentive` (
  `id`               BIGINT        NOT NULL AUTO_INCREMENT,
  `period_code`      VARCHAR(16)   NOT NULL,
  `cycle_id`         BIGINT        NULL COMMENT 'the store cycle (NULL for the Operations Manager)',
  `outlet_id`        INT           NOT NULL DEFAULT 0,
  `role`             ENUM('SUPERVISOR','STORE_MANAGER','OPERATIONS_MANAGER') NOT NULL,
  `employee_id`      INT           NOT NULL,
  `components_json`  JSON          NOT NULL COMMENT 'each component: measure cell, pay %, amount cell',
  `decided_amount`   DECIMAL(12,2) NOT NULL DEFAULT 0,
  `amount`           DECIMAL(12,2) NULL COMMENT 'NULL while any component is pending or unavailable',
  `amount_status`    VARCHAR(20)   NOT NULL,
  `weighted_score`   DECIMAL(7,4)  NULL,
  `status`           ENUM('DRAFT','APPROVED','REVOKED','POSTED') NOT NULL DEFAULT 'DRAFT',
  `rule_set_version` INT           NOT NULL,
  `calculated_by`    INT           NULL,
  `revoked_by`       INT           NULL,
  `revoked_at`       TIMESTAMP     NULL,
  `revoke_reason`    VARCHAR(500)  NULL,
  `created_at`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_management_incentive` (`period_code`, `outlet_id`, `role`, `employee_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_variance_closure` (
  `session_slug` VARCHAR(64)  NOT NULL,
  `outlet_id`    INT          NOT NULL,
  `status`       ENUM('OPEN','INVESTIGATING','CLOSED') NOT NULL DEFAULT 'OPEN',
  `reason`       VARCHAR(64)  NULL,
  `notes`        TEXT         NULL,
  `closed_by`    INT          NULL,
  `closed_at`    TIMESTAMP    NULL,
  `updated_at`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`session_slug`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_approval` (
  `id`          BIGINT       NOT NULL AUTO_INCREMENT,
  `entity`      VARCHAR(32)  NOT NULL COMMENT 'employee_incentive / management_incentive / rule_set',
  `entity_id`   BIGINT       NOT NULL,
  `level`       VARCHAR(32)  NOT NULL COMMENT 'STORE_MANAGER / OPERATIONS_MANAGER / OWNER',
  `round`       INT          NOT NULL DEFAULT 1 COMMENT 'goes up after a revocation; one decision per level per round',
  `approver_id` INT          NOT NULL,
  `decision`    ENUM('APPROVED','REJECTED') NOT NULL,
  `comment`     VARCHAR(255) NULL,
  `decided_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_approval_level` (`entity`, `entity_id`, `level`, `round`),
  KEY `idx_sa_approval_entity` (`entity`, `entity_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Payroll hand-over of APPROVED incentives (architecture only: posting is
-- disabled). One posting per incentive row, ever: a second attempt for the
-- same source is refused by the unique key, whatever runs concurrently.
CREATE TABLE IF NOT EXISTS `sa_payroll_posting` (
  `id`            BIGINT        NOT NULL AUTO_INCREMENT,
  `source_type`   ENUM('EMPLOYEE','MANAGEMENT') NOT NULL,
  `source_id`     BIGINT        NOT NULL COMMENT 'sa_employee_incentive.id / sa_management_incentive.id',
  `employee_id`   INT           NOT NULL,
  `period_year`   SMALLINT      NOT NULL,
  `period_month`  TINYINT       NOT NULL,
  `amount`        DECIMAL(12,2) NOT NULL,
  `status`        ENUM('PLANNED','POSTED','CANCELLED') NOT NULL DEFAULT 'PLANNED',
  `payrun_ref`    VARCHAR(64)   NULL COMMENT 'the payrun adjustment it became, once posting is enabled',
  `created_by`    INT           NULL,
  `created_at`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_payroll_posting_source` (`source_type`, `source_id`),
  KEY `idx_sa_payroll_posting_period` (`period_year`, `period_month`, `employee_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Granular permissions (constants/stock_audit_permissions.js).
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_own_stock_audit_performance' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_own_stock_audit_performance');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_stock_audit' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_stock_audit');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_stock_audit_all_stores' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_stock_audit_all_stores');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_stock_audit_employee_mapping' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_stock_audit_employee_mapping');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_stock_audit_cycles' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_stock_audit_cycles');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'import_stock_audit_allotment' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'import_stock_audit_allotment');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'approve_stock_audit_allotment_import' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'approve_stock_audit_allotment_import');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'review_stock_audit_verification' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'review_stock_audit_verification');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'review_stock_audit_variance' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'review_stock_audit_variance');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'review_stock_audit_eligibility' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'review_stock_audit_eligibility');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'calculate_stock_audit_incentives' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'calculate_stock_audit_incentives');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'approve_stock_audit_incentives' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'approve_stock_audit_incentives');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'revoke_stock_audit_incentives' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'revoke_stock_audit_incentives');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_stock_audit_policy' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_stock_audit_policy');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'run_stock_audit_sync' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'run_stock_audit_sync');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_sapl_leaderboard' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_sapl_leaderboard');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_sapl_competition' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_sapl_competition');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_sapl_prize_distribution' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_sapl_prize_distribution');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_stock_audit_hr_reports' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_stock_audit_hr_reports');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'download_stock_audit_hr_pdf' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'download_stock_audit_hr_pdf');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'process_stock_audit_payroll' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'process_stock_audit_payroll');
