-- Attendance v2 / A1 + A4 - the calculated attendance store, the employee
-- break override, and the monthly payroll roll-up.
--
-- ADDITIVE ONLY. Three new tables and four permission keys. `biomax_punch`
-- and `biomax_punch_derived` are not read, written or altered by this
-- migration, and nothing here touches `new_employee`, `work_shift`,
-- `employee_salary` or any existing permission grant.
--
-- RAW PUNCHES STAY RAW. Nothing in this file stores a punch. The calculated
-- rows below reference punches by id and hold the numbers derived from them;
-- the immutable rows in `biomax_punch` remain the only record of what a device
-- actually sent, and remain the input every recalculation starts from.
--
-- WHY A CALCULATION IS STORED AT ALL, when it is deterministic. Because
-- payroll has to be able to prove what it believed on the day it ran. The
-- stored row carries the shift snapshot and its hash, so a recomputation that
-- comes out differently can be traced to the configuration change that caused
-- it instead of being written off as drift. It is a cache with an audit trail,
-- never a second source of truth: delete every row here and a recalculation
-- reproduces them exactly.

-- ======================================== 1. the employee break override ===
-- The employee's own allowed break, which REPLACES the shift's break and
-- therefore changes their NRM for the day. Effective-dated and append-only for
-- the same reason the shift assignment history is: changing somebody's break
-- in October must not move September's worked minutes.
--
-- A NULL `break_minutes` is not permitted - "no override" is the absence of a
-- row, not a row saying nothing. Reverting to the shift's own break is done by
-- appending a row with `ends_on` set, which keeps the record of when the
-- override applied.
CREATE TABLE IF NOT EXISTS `employee_break_override` (
  `employee_break_override_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`    INT NOT NULL,
  `break_minutes`  INT NOT NULL COMMENT 'replaces the work shift break for these dates',
  `effective_from` DATE NOT NULL COMMENT 'inclusive attendance date',
  `effective_to`   DATE NULL COMMENT 'inclusive - NULL = open ended',
  `reason`         VARCHAR(255) NULL,
  `created_by`     INT NULL,
  `created_at`     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`employee_break_override_id`),
  KEY `idx_ebo_employee_effective` (`employee_id`, `effective_from`),
  CONSTRAINT `chk_ebo_break_minutes` CHECK (`break_minutes` >= 0),
  CONSTRAINT `chk_ebo_range` CHECK (`effective_to` IS NULL OR `effective_to` >= `effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ================================== 2. one calculated employee x date row ===
-- THE STABLE OUTPUT CONTRACT the future frontend reads. Every field the v2
-- handoff names is a column here, in exact integer minutes; there is no
-- 15- or 30-minute attendance rounding anywhere, and the only rounding stored
-- is the Work Shift's own OT rounding, which is visible as the difference
-- between `raw_ot_minutes` and `candidate_ot_minutes`.
--
-- IDEMPOTENT BY KEY. `uq_adc_employee_date` is what makes a recalculation an
-- INSERT ... ON DUPLICATE KEY UPDATE rather than a duplicate: re-running the
-- engine for a month can never produce a second row for a date.
--
-- NO FOREIGN KEY TO `work_shift_weekly_schedule`. The snapshot has to survive
-- the schedule row being edited or a shift being reconfigured - that is the
-- point of snapshotting it - so the reference is an id plus the JSON, exactly
-- as `biomax_punch_derived` does it.
CREATE TABLE IF NOT EXISTS `attendance_day_calculation` (
  `attendance_day_calculation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`      INT  NOT NULL,
  `attendance_date`  DATE NOT NULL,

  -- which shift applied on this date, resolved through the A0 dated history
  `work_shift_id`    INT NULL,
  `work_shift_weekly_schedule_id` INT NULL COMMENT 'snapshot reference, deliberately not an FK',
  `shift_snapshot`      JSON NOT NULL COMMENT 'the configuration this calculation consumed',
  `shift_snapshot_hash` CHAR(32) NOT NULL COMMENT 'fingerprint of the above, for drift detection',

  -- what was punched
  `raw_punch_ids`    JSON NOT NULL COMMENT 'biomax_punch ids, in order - references, never copies',
  `effective_punches` JSON NOT NULL COMMENT 'raw plus any FULLY APPROVED regularized punch',
  `punch_count`      INT NOT NULL DEFAULT 0 COMMENT 'count of EFFECTIVE punches',

  -- the day
  `attendance_day_count`    TINYINT NOT NULL DEFAULT 0 COMMENT '1 if present at all, else 0. Never a half',
  `nrm_minutes`             INT NOT NULL DEFAULT 0 COMMENT 'shift span - allowed break',
  `span_minutes`            INT NOT NULL DEFAULT 0 COMMENT 'first punch to last punch',
  `break_allowance_minutes` INT NOT NULL DEFAULT 0,
  `break_allowance_source`  ENUM('SHIFT','EMPLOYEE_OVERRIDE') NOT NULL DEFAULT 'SHIFT',
  `actual_gap_minutes`      INT NULL COMMENT 'summed OUT->IN gaps. NULL on a two-punch day: no evidence',
  `break_charged_minutes`   INT NOT NULL DEFAULT 0,
  `worked_minutes`          INT NOT NULL DEFAULT 0 COMMENT 'credited minutes',
  `shortage_minutes`        INT NOT NULL DEFAULT 0,

  -- reported, never charged: v2 has no separate monetary late/early penalty
  `late_minutes`       INT NULL,
  `early_exit_minutes` INT NULL,

  -- overtime. `approved_ot_minutes` is the ONLY column payroll may read.
  `raw_ot_minutes`       INT NOT NULL DEFAULT 0 COMMENT 'before the shift OT minimum/rounding/cap',
  `candidate_ot_minutes` INT NOT NULL DEFAULT 0 COMMENT 'after them. Worth zero until approved',
  `approved_ot_minutes`  INT NOT NULL DEFAULT 0 COMMENT 'FINAL APPROVED only',
  `ot_rate`              DECIMAL(3,1) NULL COMMENT 'the weekday multiplier from the snapshot',

  `status` ENUM('FINAL','ABSENT','REVIEW_REQUIRED','REGULARIZATION_PENDING','OT_PENDING',
                'NO_SHIFT_FOR_DATE','NO_SCHEDULE_ROW') NOT NULL,
  `is_final` TINYINT(1) NOT NULL DEFAULT 0,
  `review_reasons` JSON NULL,

  -- what a human did to this date, so the row links back to its audit trail
  `approval_request_id` BIGINT UNSIGNED NULL COMMENT 'attendance_approval_request, when there is one',

  `calculation_version` INT NOT NULL COMMENT 'utils/attendance_engine.js CALCULATION_VERSION',
  `calculated_at`       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`attendance_day_calculation_id`),
  UNIQUE KEY `uq_adc_employee_date` (`employee_id`, `attendance_date`),
  KEY `idx_adc_date` (`attendance_date`),
  KEY `idx_adc_status` (`status`, `attendance_date`),
  KEY `idx_adc_shift` (`work_shift_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================ 3. the monthly roll-up (A4) ===
-- One row per employee per month. Same idempotency story as the daily table:
-- the unique key makes a re-run an update, so a retried payroll close can
-- never double a month.
--
-- `monthly_gross` and `daily_rate` are SNAPSHOTTED from the existing
-- effective-dated salary resolver (the latest APPROVED `employee_salary` row
-- effective on or before the period). This table is not a second salary
-- source and never computes one; it records which figure it was handed.
--
-- `statutory_base_earnings` is the Salary Days line and the PF/ESI salary-day
-- base. Extra-day earnings are excluded from it by construction. No PF or ESI
-- amount is computed or stored here - `utils/salary_engine.js` owns that law
-- and is untouched.
CREATE TABLE IF NOT EXISTS `attendance_monthly_payroll` (
  `attendance_monthly_payroll_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`   INT NOT NULL,
  `period_year`   SMALLINT NOT NULL,
  `period_month`  TINYINT NOT NULL COMMENT '1-12',

  `available_from` DATE NULL COMMENT 'bounded by joining date',
  `available_to`   DATE NULL COMMENT 'bounded by last working date',
  `available_dates` INT NOT NULL DEFAULT 0,
  `notional_offs`   INT NOT NULL DEFAULT 0 COMMENT 'floor(available_dates / 7)',
  `base_days`       INT NOT NULL DEFAULT 0 COMMENT 'available_dates - notional_offs',

  `attendance_days` INT NOT NULL DEFAULT 0,
  `salary_days`     INT NOT NULL DEFAULT 0 COMMENT 'min(attendance_days, base_days)',
  `extra_days`      INT NOT NULL DEFAULT 0 COMMENT 'max(attendance_days - base_days, 0)',

  `monthly_gross` DECIMAL(12,2) NULL COMMENT 'snapshotted from the M2/M4 salary resolver',
  `daily_rate`    DECIMAL(12,2) NULL COMMENT 'monthly_gross / 26',

  `salary_earnings`    DECIMAL(12,2) NULL,
  `extra_day_earnings` DECIMAL(12,2) NULL,

  `shortage_minutes`         INT NOT NULL DEFAULT 0,
  `missing_minute_deduction` DECIMAL(12,2) NULL COMMENT 'shortage x (daily_rate / that date NRM)',

  `approved_ot_minutes`  INT NOT NULL DEFAULT 0,
  `approved_ot_earnings` DECIMAL(12,2) NULL,

  `statutory_base_days`     INT NOT NULL DEFAULT 0 COMMENT '= salary_days. The PF/ESI base',
  `statutory_base_earnings` DECIMAL(12,2) NULL COMMENT '= salary_earnings. Extra days excluded',

  `total_attendance_payable` DECIMAL(12,2) NULL
    COMMENT 'salary + extra + approved OT - shortage. BEFORE other existing deductions/components',

  `held_dates` JSON NULL COMMENT 'dates not settled - payroll must not treat the month as final',
  `is_final`   TINYINT(1) NOT NULL DEFAULT 0,

  `payroll_version` INT NOT NULL,
  `calculated_at`   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`attendance_monthly_payroll_id`),
  UNIQUE KEY `uq_amp_employee_period` (`employee_id`, `period_year`, `period_month`),
  KEY `idx_amp_period` (`period_year`, `period_month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========================================================== permissions ====
-- Declared in `all_permissions`, and granted to HR EXECUTIVE by designation
-- NAME exactly as 20260910160000 and 20260911120000 do. Administrators
-- (user_type 2) need no grant: the permission middleware bypasses the table.
-- `all_permissions` has no unique key on `permission_key`, so each insert
-- guards itself and a re-run adds nothing.
--
--   view_calculated_attendance     read the calculated day rows        HR EXECUTIVE
--   recalculate_attendance         re-run the engine for a range       HR EXECUTIVE
--   view_attendance_payroll        read the monthly roll-up            HR EXECUTIVE
--   manage_employee_break_override set somebody's special break        NOBODY (admin only)
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_calculated_attendance' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_calculated_attendance');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'recalculate_attendance' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'recalculate_attendance');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_attendance_payroll' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_attendance_payroll');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_employee_break_override' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_employee_break_override');

-- The three READ/RECALC keys to HR EXECUTIVE and nobody else. The break
-- override key receives NO grant: changing somebody's NRM changes their pay,
-- and an administrator grants it deliberately on the designation screen.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM ( SELECT 'view_calculated_attendance' AS `permission_key`
           UNION ALL SELECT 'recalculate_attendance'
           UNION ALL SELECT 'view_attendance_payroll' ) k
    JOIN ( SELECT `designation_id` FROM `designation`
            WHERE UPPER(TRIM(`designation_name`)) = 'HR EXECUTIVE' ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );
