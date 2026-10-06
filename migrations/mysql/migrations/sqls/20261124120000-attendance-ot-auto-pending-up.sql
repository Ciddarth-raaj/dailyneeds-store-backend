-- Attendance OT: eligible overtime enters approval AUTOMATICALLY.
--
-- ADDITIVE ONLY. Two new tables. No existing table is altered, no row of
-- `attendance_approval_request` is rewritten, and no enum value is removed.
--
-- THE OT RECORD IS NOT DUPLICATED. An automatically raised OT is an ordinary
-- `attendance_approval_request` row with request_type 'OT' and
-- auto_created = 1 (a column that has existed since 20260919120000), walking
-- the same approval chain, decided by the same `decide`, from DnDS or
-- Telegram alike. These two tables only GATE and AUDIT the automation.

-- ============================================== 1. the cutover, one row ====
-- From which attendance date the system raises OT on its own. Seeded to the
-- IST business date five days before this migration runs, so the deploy
-- covers the previous five attendance days (the backfill) and no older date
-- is suddenly asked about by a later recalculation of an old month.
--
-- `enabled` = 0 is the kill switch: auto-raising stops at once (nothing is
-- deleted or undone, and decisions continue exactly as before).
CREATE TABLE IF NOT EXISTS `attendance_ot_auto_pending_setting` (
  `setting_id` TINYINT UNSIGNED NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `auto_pending_from_date` DATE NOT NULL
    COMMENT 'no OT is raised automatically for an attendance date before this',
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`setting_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `attendance_ot_auto_pending_setting` (`setting_id`, `enabled`, `auto_pending_from_date`)
  SELECT 1, 1, DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE) - INTERVAL 5 DAY FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `attendance_ot_auto_pending_setting` WHERE `setting_id` = 1);

-- ======================================== 2. what the automation did ======
-- One row per thing the system did to an OT request on its own:
--   CREATED          raised PENDING from the attendance engine's eligible OT
--   MINUTES_CHANGED  a PENDING request's minutes followed a recalculation
--   WITHDRAWN        a PENDING auto request was CANCELLED because the
--                    eligible OT went away (its steps are stamped SKIPPED)
-- A human decision is never written here: it is on `attendance_approval_step`
-- (who, when, from WEB or TELEGRAM, remarks), exactly as before.
CREATE TABLE IF NOT EXISTS `attendance_ot_auto_pending_log` (
  `attendance_ot_auto_pending_log_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL,
  `employee_id` INT NOT NULL,
  `attendance_date` DATE NOT NULL,
  `action` ENUM('CREATED','MINUTES_CHANGED','WITHDRAWN') NOT NULL,
  `previous_ot_minutes` INT NULL,
  `new_ot_minutes` INT NULL,
  `trigger_source` VARCHAR(64) NULL COMMENT 'RECALCULATION, DECISION, BACKFILL, ...',
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_ot_auto_pending_log_id`),
  KEY `idx_aoapl_request` (`attendance_approval_request_id`),
  KEY `idx_aoapl_employee_date` (`employee_id`, `attendance_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
