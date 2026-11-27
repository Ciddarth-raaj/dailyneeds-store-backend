-- Stock Audit, phase 3: participation on the full eligible headcount, a
-- frozen eligibility snapshot per audit cycle, authorised exclusions with
-- approval history, and cycle-wise responsible persons (Supervisor, Store
-- Manager, Operations Manager). NEW TABLES ONLY plus two permission keys.

-- Module settings with history (designation ids that are eligible counting
-- staff; designation ids that qualify for each management role).
CREATE TABLE IF NOT EXISTS `sa_setting` (
  `setting_key` VARCHAR(64)  NOT NULL,
  `value_json`  JSON         NOT NULL,
  `updated_by`  INT          NULL,
  `updated_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_setting_history` (
  `id`          BIGINT       NOT NULL AUTO_INCREMENT,
  `setting_key` VARCHAR(64)  NOT NULL,
  `value_json`  JSON         NOT NULL,
  `changed_by`  INT          NULL,
  `changed_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sa_setting_history_key` (`setting_key`, `changed_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- The eligible employees of a store cycle, frozen when HR takes the
-- snapshot: later transfers, resignations and new joiners do not change it.
-- A later addition is explicit (source ADDED) and recorded.
CREATE TABLE IF NOT EXISTS `sa_cycle_snapshot` (
  `cycle_id`        BIGINT    NOT NULL,
  `employee_count`  INT       NOT NULL,
  `designation_ids` JSON      NOT NULL COMMENT 'eligible designation ids used',
  `taken_by`        INT       NULL,
  `taken_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`cycle_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS `sa_cycle_employee` (
  `cycle_id`       BIGINT       NOT NULL,
  `employee_id`    INT          NOT NULL,
  `outlet_id`      INT          NOT NULL,
  `employee_name`  VARCHAR(160) NULL COMMENT 'as at the snapshot',
  `designation_id` INT          NULL COMMENT 'as at the snapshot',
  `source`         ENUM('SNAPSHOT','ADDED') NOT NULL DEFAULT 'SNAPSHOT',
  `added_by`       INT          NULL,
  `note`           VARCHAR(255) NULL,
  `created_at`     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`cycle_id`, `employee_id`),
  KEY `idx_sa_cycle_employee_outlet` (`outlet_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Exclusion of an employee from a cycle's eligible headcount: a mandatory
-- reason, requested by one person and decided by another. Rows are never
-- deleted; one open or approved exclusion per employee per cycle.
CREATE TABLE IF NOT EXISTS `sa_employee_exclusion` (
  `id`            BIGINT       NOT NULL AUTO_INCREMENT,
  `cycle_id`      BIGINT       NOT NULL,
  `employee_id`   INT          NOT NULL,
  `reason`        VARCHAR(500) NOT NULL,
  `status`        ENUM('REQUESTED','APPROVED','REJECTED','WITHDRAWN') NOT NULL DEFAULT 'REQUESTED',
  `requested_by`  INT          NOT NULL,
  `requested_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `decided_by`    INT          NULL,
  `decided_at`    TIMESTAMP    NULL,
  `decision_note` VARCHAR(500) NULL,
  `active_employee_id` INT AS (IF(`status` IN ('REQUESTED','APPROVED'), `employee_id`, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_employee_exclusion_active` (`cycle_id`, `active_employee_id`),
  KEY `idx_sa_employee_exclusion_cycle` (`cycle_id`, `status`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Responsible person per role and audit period. Store roles carry the store
-- cycle; the Operations Manager is one per period (outlet_id 0). Replaced
-- rows are kept as history. Database guards: one ACTIVE holder per role per
-- store per period, and one ACTIVE management role per person per period, so
-- nobody can receive two management incentives for the same period.
CREATE TABLE IF NOT EXISTS `sa_role_assignment` (
  `id`           BIGINT       NOT NULL AUTO_INCREMENT,
  `period_code`  VARCHAR(16)  NOT NULL,
  `cycle_id`     BIGINT       NULL,
  `outlet_id`    INT          NOT NULL DEFAULT 0,
  `role`         ENUM('SUPERVISOR','STORE_MANAGER','OPERATIONS_MANAGER') NOT NULL,
  `employee_id`  INT          NOT NULL,
  `designation_id` INT        NULL COMMENT 'as at assignment',
  `status`       ENUM('ACTIVE','REPLACED') NOT NULL DEFAULT 'ACTIVE',
  `reason`       VARCHAR(500) NULL,
  `assigned_by`  INT          NOT NULL,
  `assigned_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `replaced_by`  INT          NULL,
  `replaced_at`  TIMESTAMP    NULL,
  `active_slot`  VARCHAR(80) AS (IF(`status` = 'ACTIVE', CONCAT(`outlet_id`, ':', `role`), NULL)) STORED,
  `active_person` INT AS (IF(`status` = 'ACTIVE', `employee_id`, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sa_role_assignment_slot` (`period_code`, `active_slot`),
  UNIQUE KEY `uq_sa_role_assignment_person` (`period_code`, `active_person`),
  KEY `idx_sa_role_assignment_period` (`period_code`, `status`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_stock_audit_roles' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_stock_audit_roles');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'approve_stock_audit_exclusions' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'approve_stock_audit_exclusions');
