-- =====================================================================
-- Historical OT Review: calculated OT that the automatic-OT cutover left
-- without an approval request (attendance dates before the cutover), raised
-- ONLY by an authorised administrator, ONE REVIEWED DATE AT A TIME.
--
-- ADDITIVE ONLY. Three new tables and one permission key. No existing table
-- is altered and no existing row is changed. Nothing here approves or pays
-- anything: an authorised review creates ordinary PENDING OT requests that
-- walk the employee's normal approval chain. An approval in a payroll-locked
-- month settles forward as Prior-Month OT through the existing
-- `attendance_ot_late_settlement` path, priced from the locked calculation;
-- no locked or published payroll row is touched.
-- =====================================================================

-- 1. ONE REVIEW BATCH: what was previewed, who authorised it, what happened.
CREATE TABLE IF NOT EXISTS `attendance_ot_historical_review_batch` (
  `review_batch_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `from_date` DATE NOT NULL,
  `to_date` DATE NOT NULL,
  `status` ENUM('AUTHORISED','APPLIED','FAILED') NOT NULL DEFAULT 'AUTHORISED',
  `preview_hash` CHAR(64) NOT NULL COMMENT 'sha256 of the preview the administrator authorised',
  `item_count` INT NOT NULL DEFAULT 0,
  `authorised_by_employee_id` INT NOT NULL,
  `authorised_by_user_id` INT NULL,
  `authorised_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `applied_at` TIMESTAMP(3) NULL,
  `summary` JSON NULL COMMENT 'outcome counts when applied',
  `note` VARCHAR(255) NULL,
  PRIMARY KEY (`review_batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. EVERY REVIEWED DATE, exactly as the administrator saw it, and its outcome.
CREATE TABLE IF NOT EXISTS `attendance_ot_historical_review_item` (
  `review_item_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `review_batch_id` BIGINT UNSIGNED NOT NULL,
  `employee_id` INT NOT NULL,
  `attendance_date` DATE NOT NULL COMMENT 'the original work date',
  `calculated_ot_minutes` INT NOT NULL COMMENT 'claimable OT at preview',
  `payroll_status` VARCHAR(24) NOT NULL COMMENT 'NOT_CALCULATED, CALCULATED, APPROVED_LOCKED, PUBLISHED',
  `payroll_calculation_id` BIGINT UNSIGNED NULL COMMENT 'the payroll source reference at preview',
  `proposed_action` VARCHAR(48) NOT NULL,
  `outcome` ENUM('AUTHORISED','CREATED','SKIPPED','FAILED') NOT NULL DEFAULT 'AUTHORISED',
  `created_request_id` BIGINT UNSIGNED NULL,
  `outcome_detail` VARCHAR(255) NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `decided_at` TIMESTAMP(3) NULL,
  PRIMARY KEY (`review_item_id`),
  UNIQUE KEY `uq_aohri_batch_employee_date` (`review_batch_id`, `employee_id`, `attendance_date`),
  KEY `idx_aohri_employee_date` (`employee_id`, `attendance_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. NEVER TWICE. One row per employee and date the review ever raised OT
--    on: the primary key refuses a repeat backfill of the same date, by any
--    batch, whatever later became of the request.
CREATE TABLE IF NOT EXISTS `attendance_ot_historical_review_raised` (
  `employee_id` INT NOT NULL,
  `attendance_date` DATE NOT NULL,
  `review_item_id` BIGINT UNSIGNED NOT NULL,
  `attendance_approval_request_id` BIGINT UNSIGNED NULL,
  `raised_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`employee_id`, `attendance_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. The permission key. DECLARED and granted to NOBODY: administrators hold
--    it through the user_type 2 bypass; a designation gets it only when
--    somebody grants it on the Designation screen.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'attendance_ot_historical_review' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'attendance_ot_historical_review');
