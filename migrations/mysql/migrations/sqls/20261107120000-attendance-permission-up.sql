-- =====================================================================
-- Attendance PERMISSION - paid forgiven shortage, never worked time.
--
-- Management sometimes allows an employee to work fewer hours without a
-- salary deduction: leave early on a festival, come in late, step out for a
-- period during the shift. That is a PERMISSION. It never changes a punch,
-- never changes the shift a date resolves to, and never creates overtime:
-- the calculation engine (CALCULATION_VERSION 11) takes approved permission
-- windows off the shortage it would otherwise charge, after grace and before
-- the remaining deduction rule, and only where the window and the chargeable
-- shortage actually overlap.
--
-- TWO ORIGINS, ONE CALCULATION.
--
--   REQUEST  raised by (or for) the employee and decided by the EXISTING
--            attendance approval chain. PERMISSION joins
--            `attendance_approval_request.request_type` exactly as
--            SHIFT_CHANGE did: one chain, one queue, one payroll-lock rule,
--            one revoke path, one audit trail. The windows are the request's
--            payload rows in `attendance_permission` (as a regularized punch
--            is the payload of a REGULARIZATION request).
--   DIRECT   granted by an authorised management user - one employee, a
--            list, an outlet or everybody in their scope. Effective on
--            creation until revoked, with who / when / why on the row, and a
--            bulk grant correlated through `attendance_permission_bulk_operation`
--            and one `attendance_permission_bulk_item` per employee considered.
--
-- ADDITIVE. Two columns of `attendance_approval_request` are widened by one
-- value each; everything else is new. No existing row is rewritten, no stored
-- calculation is recalculated, and every new key is granted to NOBODY.
-- =====================================================================

-- ========================================== 1. the request type and group ==
ALTER TABLE `attendance_approval_request`
  MODIFY COLUMN `request_type`
    ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE','PERMISSION') NOT NULL;

-- THE OPEN-REQUEST KEY GAINS ONE GROUP. A pending Permission is a different
-- question from a pending missing-punch or OT claim on the same date, and
-- must neither block nor be blocked by one. Two open PERMISSION requests for
-- one employee and date still cannot coexist - a request carries all of its
-- windows (a late-in AND an early-out) as payload rows.
ALTER TABLE `attendance_approval_request`
  DROP INDEX `uq_aareq_open_per_employee_date`,
  DROP COLUMN `open_request_group`;
ALTER TABLE `attendance_approval_request`
  ADD COLUMN `open_request_group` ENUM('ATT','SHIFT','PERM') GENERATED ALWAYS AS
    (CASE WHEN `status` = 'PENDING'
          THEN (CASE WHEN `request_type` = 'SHIFT_CHANGE' THEN 'SHIFT'
                     WHEN `request_type` = 'PERMISSION' THEN 'PERM'
                     ELSE 'ATT' END)
          ELSE NULL END) STORED,
  ADD UNIQUE KEY `uq_aareq_open_per_employee_date`
    (`requested_for_employee_id`, `open_attendance_date`, `open_request_group`);

-- ====================================== 2. a bulk DIRECT grant, as a whole ==
CREATE TABLE IF NOT EXISTS `attendance_permission_bulk_operation` (
  `bulk_operation_id` CHAR(36) NOT NULL,
  `target_mode` ENUM('EMPLOYEES','OUTLETS','ALL') NOT NULL
    COMMENT 'ALL = every eligible employee inside the grantor''s outlet scope',
  `target_employee_ids` JSON NULL,
  `target_outlet_ids` JSON NULL,
  `attendance_date` DATE NOT NULL,
  `from_time` TIME NOT NULL,
  `to_time` TIME NULL COMMENT 'NULL when to_shift_end = 1',
  `to_shift_end` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = until each employee''s own scheduled shift end for the date',
  `reason` VARCHAR(500) NOT NULL,
  `remarks` VARCHAR(500) NULL,
  `preview_fingerprint` CHAR(64) NOT NULL COMMENT 'the preview the grantor confirmed',
  `considered_count` INT NOT NULL DEFAULT 0,
  `succeeded_count` INT NOT NULL DEFAULT 0,
  `skipped_count` INT NOT NULL DEFAULT 0,
  `failed_count` INT NOT NULL DEFAULT 0,
  `created_by_employee_id` INT NULL,
  `created_by_user_id` INT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` TIMESTAMP(3) NULL,
  PRIMARY KEY (`bulk_operation_id`),
  KEY `idx_apbo_date` (`attendance_date`),
  KEY `idx_apbo_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================= 3. the permission windows ===
CREATE TABLE IF NOT EXISTS `attendance_permission` (
  `attendance_permission_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id` INT NOT NULL,
  `attendance_date` DATE NOT NULL,
  -- Full date-times, like a punch, so a window on an overnight shift that
  -- runs past midnight is ordinary arithmetic.
  `permission_from` DATETIME NOT NULL,
  `permission_to` DATETIME NOT NULL,
  `to_shift_end` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = granted "until the scheduled shift end"; permission_to is that end as resolved at creation',
  `permission_minutes` INT NOT NULL COMMENT 'the window length as approved; what it COVERS is calculated',
  `reason` VARCHAR(500) NOT NULL,
  `remarks` VARCHAR(500) NULL,
  `source` ENUM('REQUEST','DIRECT') NOT NULL,
  `attendance_approval_request_id` BIGINT UNSIGNED NULL
    COMMENT 'REQUEST only: the PERMISSION request whose APPROVED + SETTLED state makes this effective',
  `bulk_operation_id` CHAR(36) NULL COMMENT 'DIRECT only: set when created through a bulk grant',
  `outlet_id` INT NULL COMMENT 'the employee''s outlet when this was created, for scope and audit',
  `work_shift_id` INT NULL COMMENT 'the shift the date resolved to when this was created',
  `created_by_employee_id` INT NULL,
  `created_by_user_id` INT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- A DIRECT grant is revoked here. A REQUEST permission is revoked through
  -- the request (CANCELLED + `attendance_approval_revocation`), never here.
  `revoked_by_employee_id` INT NULL,
  `revoked_by_user_id` INT NULL,
  `revoked_at` TIMESTAMP(3) NULL,
  `revoke_reason` VARCHAR(500) NULL,
  `revoke_bulk_operation_id` CHAR(36) NULL COMMENT 'set when revoked as part of revoking a whole bulk grant',
  `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_permission_id`),
  KEY `idx_ap_employee_date` (`employee_id`, `attendance_date`),
  KEY `idx_ap_date` (`attendance_date`),
  KEY `idx_ap_request` (`attendance_approval_request_id`),
  KEY `idx_ap_bulk` (`bulk_operation_id`),
  KEY `idx_ap_outlet_date` (`outlet_id`, `attendance_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ================================ 4. one row per employee a bulk considered ==
-- Append-only. Records the employees that were SKIPPED or FAILED as well as
-- the ones granted, so "why did X not get the festival permission?" has an
-- answer after the fact.
CREATE TABLE IF NOT EXISTS `attendance_permission_bulk_item` (
  `attendance_permission_bulk_item_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bulk_operation_id` CHAR(36) NOT NULL,
  `employee_id` INT NOT NULL,
  `outlet_id` INT NULL,
  `outcome` ENUM('SUCCEEDED','SKIPPED','FAILED') NOT NULL,
  `code` VARCHAR(64) NULL,
  `message` VARCHAR(500) NULL,
  `attendance_permission_id` BIGINT UNSIGNED NULL,
  `recalculated` TINYINT(1) NULL COMMENT '1 = the date was stored recalculated, 0 = open day (stored by the daily run), NULL = nothing granted',
  `acted_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_permission_bulk_item_id`),
  KEY `idx_apbi_operation` (`bulk_operation_id`),
  KEY `idx_apbi_employee` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ======================================== 5. what a stored day applied ===
-- `shortage_minutes` stays the ONE charged figure payroll prices; it is now
-- the charge after permission. Beside it, what the permission did. Rows
-- written before this column existed keep NULL where the value cannot be
-- proven after the fact (the shortage before permission, the payable
-- minutes) and 0 where it can (no permission existed, so none applied).
ALTER TABLE `attendance_day_calculation`
  ADD COLUMN `permission_ids` JSON NULL
    COMMENT 'the effective permissions the date carried',
  ADD COLUMN `permission_window_minutes` INT NOT NULL DEFAULT 0
    COMMENT 'their windows, merged and clipped to the resolved shift',
  ADD COLUMN `permission_minutes` INT NOT NULL DEFAULT 0
    COMMENT 'paid permission (not worked) actually forgiven from the shortage',
  ADD COLUMN `permission_late_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `permission_early_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `permission_away_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `shortage_before_permission_minutes` INT NULL DEFAULT NULL
    COMMENT 'the charge without permission. NULL = written before this column existed',
  ADD COLUMN `payable_minutes` INT NULL DEFAULT NULL
    COMMENT 'base NRM less the charged shortage; OT separate. NULL = written before this column existed';

ALTER TABLE `attendance_monthly_payroll`
  ADD COLUMN `permission_minutes` INT NOT NULL DEFAULT 0
    COMMENT 'paid permission forgiven on the month''s final days - for display; the deduction already reflects it';

-- ========================================================== permissions ====
--   view_attendance_permissions            the Permission register        NOBODY
--   raise_attendance_permission_request    request Permission for YOURSELF NOBODY
--   raise_attendance_permission_for_others raise a request for an employee NOBODY
--                                          in scope (it still goes through
--                                          the approval chain)
--   approve_attendance_permission          reach the Permission decision   NOBODY
--                                          endpoint - the chain decides who
--                                          may decide each stage
--   grant_attendance_permission            DIRECT grant to chosen          NOBODY
--                                          employees in scope
--   grant_attendance_permission_bulk       DIRECT grant to outlets or to   NOBODY
--                                          everybody in scope
--   revoke_attendance_permission           revoke a DIRECT grant in scope  NOBODY
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_attendance_permissions' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_attendance_permissions');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'raise_attendance_permission_request' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'raise_attendance_permission_request');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'raise_attendance_permission_for_others' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'raise_attendance_permission_for_others');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'approve_attendance_permission' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'approve_attendance_permission');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'grant_attendance_permission' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'grant_attendance_permission');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'grant_attendance_permission_bulk' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'grant_attendance_permission_bulk');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'revoke_attendance_permission' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'revoke_attendance_permission');

-- REPORT ONLY: every key exists and nobody holds it yet.
SELECT `permission_key`,
       ( SELECT COUNT(*) FROM `permissions` p
          WHERE p.`permission_key` = a.`permission_key` AND p.`is_active` = TRUE
       ) AS `DESIGNATIONS_HOLDING_IT_grant_on_the_permissions_screen`
  FROM `all_permissions` a
 WHERE a.`permission_key` IN (
   'view_attendance_permissions', 'raise_attendance_permission_request',
   'raise_attendance_permission_for_others', 'approve_attendance_permission',
   'grant_attendance_permission', 'grant_attendance_permission_bulk',
   'revoke_attendance_permission'
 );
