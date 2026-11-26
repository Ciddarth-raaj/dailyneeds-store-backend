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
  `status`       ENUM('RUNNING','SUCCESS','FAILED') NOT NULL DEFAULT 'RUNNING',
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
  `start_date`  DATE         NOT NULL,
  `end_date`    DATE         NOT NULL,
  `deadline`    DATE         NOT NULL,
  `status`      ENUM('DRAFT','OPEN','CLOSED','APPROVED') NOT NULL DEFAULT 'DRAFT',
  `created_by`  INT          NULL,
  `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`cycle_id`),
  UNIQUE KEY `uq_sa_cycle_outlet_start` (`outlet_id`, `start_date`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Verification results are READ FROM RetailPilot recounts (no entry screen in
-- DNDS). Columns stay generic until real recounts have been inspected.
CREATE TABLE IF NOT EXISTS `sa_verification` (
  `id`                    BIGINT        NOT NULL AUTO_INCREMENT,
  `cycle_id`              BIGINT        NOT NULL,
  `original_session_slug` VARCHAR(64)   NOT NULL,
  `recount_ref`           VARCHAR(64)   NOT NULL COMMENT 'RetailPilot reference of the recount',
  `original_user`         VARCHAR(64)   NULL,
  `recount_user`          VARCHAR(64)   NULL,
  `original_qty`          DECIMAL(16,3) NULL,
  `recount_qty`           DECIMAL(16,3) NULL,
  `original_at`           DATETIME(6)   NULL,
  `recount_at`            DATETIME(6)   NULL,
  `is_match`              TINYINT(1)    NULL COMMENT 'NULL = not decidable',
  `independent`           TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = recount user differs from original user',
  `created_at`            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_verification_recount` (`recount_ref`),
  KEY `idx_sa_verification_original` (`original_session_slug`),
  KEY `idx_sa_verification_cycle` (`cycle_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- One credited article per store per cycle: the duplicate-incentive guard.
CREATE TABLE IF NOT EXISTS `sa_incentive_article` (
  `cycle_id`     BIGINT      NOT NULL,
  `outlet_id`    INT         NOT NULL,
  `article_id`   INT         NOT NULL,
  `employee_id`  INT         NOT NULL,
  `session_slug` VARCHAR(64) NOT NULL,
  `created_at`   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`cycle_id`, `outlet_id`, `article_id`),
  UNIQUE KEY `uq_sa_incentive_article_session` (`session_slug`),
  KEY `idx_sa_incentive_article_employee` (`cycle_id`, `employee_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_rule_set` (
  `version`     INT          NOT NULL AUTO_INCREMENT,
  `rules_json`  JSON         NOT NULL,
  `status`      ENUM('DRAFT','APPROVED','RETIRED') NOT NULL DEFAULT 'DRAFT',
  `note`        VARCHAR(255) NULL,
  `created_by`  INT          NULL,
  `approved_by` INT          NULL,
  `approved_at` TIMESTAMP    NULL,
  `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`version`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_employee_incentive` (
  `id`               BIGINT        NOT NULL AUTO_INCREMENT,
  `cycle_id`         BIGINT        NOT NULL,
  `employee_id`      INT           NOT NULL,
  `rp_user_id`       VARCHAR(64)   NULL,
  `unique_articles`  INT           NOT NULL DEFAULT 0,
  `lines_rechecked`  INT           NOT NULL DEFAULT 0,
  `lines_matched`    INT           NOT NULL DEFAULT 0,
  `accuracy_pct`     DECIMAL(7,4)  NULL,
  `rate`             DECIMAL(8,2)  NULL,
  `amount`           DECIMAL(12,2) NULL,
  `calc_status`      VARCHAR(32)   NOT NULL COMMENT 'PENDING_VERIFICATION / INSUFFICIENT_SAMPLE / CALCULATED',
  `status`           ENUM('DRAFT','APPROVED','POSTED','VOID') NOT NULL DEFAULT 'DRAFT',
  `rule_set_version` INT           NOT NULL,
  `created_at`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_employee_incentive` (`cycle_id`, `employee_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_management_kpi` (
  `id`               BIGINT        NOT NULL AUTO_INCREMENT,
  `cycle_id`         BIGINT        NOT NULL,
  `outlet_id`        INT           NULL COMMENT 'NULL for the Operations Manager total row',
  `role`             ENUM('SUPERVISOR','STORE_MANAGER','OPERATIONS_MANAGER') NOT NULL,
  `employee_id`      INT           NOT NULL,
  `kpi_key`          VARCHAR(40)   NOT NULL,
  `score_pct`        DECIMAL(7,4)  NULL,
  `amount`           DECIMAL(12,2) NULL,
  `evidence_json`    JSON          NULL,
  `status`           ENUM('DRAFT','APPROVED','POSTED','VOID') NOT NULL DEFAULT 'DRAFT',
  `rule_set_version` INT           NOT NULL,
  `created_at`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_management_kpi` (`cycle_id`, `outlet_id`, `role`, `employee_id`, `kpi_key`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_variance_closure` (
  `session_slug` VARCHAR(64)  NOT NULL,
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
  `entity`      VARCHAR(32)  NOT NULL COMMENT 'cycle / employee_incentive / management_kpi / rule_set',
  `entity_id`   BIGINT       NOT NULL,
  `level`       VARCHAR(32)  NOT NULL COMMENT 'STORE_MANAGER / OPERATIONS_MANAGER / OWNER',
  `approver_id` INT          NOT NULL,
  `decision`    ENUM('APPROVED','REJECTED') NOT NULL,
  `comment`     VARCHAR(255) NULL,
  `decided_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sa_approval_entity` (`entity`, `entity_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_stock_audit' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_stock_audit');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'approve_stock_audit_incentive' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'approve_stock_audit_incentive');
