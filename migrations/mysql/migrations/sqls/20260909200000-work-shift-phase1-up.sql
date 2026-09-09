-- Work Shift Phase 1 - the payroll/attendance shift master.
--
-- Additive and isolated. The live `shift_master` table is deliberately NOT
-- touched here: it keeps serving the current system, `new_employee.shift_id`
-- keeps pointing at it, and nothing in this migration reads, copies or
-- backfills from it. `work_shift` starts empty; the real shift set is entered
-- by hand, and employees are mapped onto it in a later, manual phase.
--
-- Nothing here calculates payroll. These are settings fields only; the
-- lateness, early-out and OT engines that consume them are a later phase.
--
-- Daily In/Out times live in `work_shift_weekly_schedule` and nowhere else,
-- so there is exactly one authoritative answer to "when does this shift run
-- on a Tuesday".

CREATE TABLE IF NOT EXISTS `work_shift` (
  `work_shift_id` INT AUTO_INCREMENT PRIMARY KEY,

  -- Basic. Unlike the old `shift_master`, a code is mandatory: every work
  -- shift is created by hand, so there is no legacy row to leave blank.
  `shift_code` VARCHAR(20) NOT NULL,
  `shift_name` VARCHAR(150) NOT NULL,
  `active` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=active, 0=inactive',

  -- Lateness. Configuration for a deduction engine that does not exist yet.
  `late_grace_minutes` INT NOT NULL DEFAULT 0,
  `late_deduction_interval_minutes` INT NOT NULL DEFAULT 0,
  `late_deduct_minutes` INT NOT NULL DEFAULT 0,
  `late_exclude_grace_from_deduction` TINYINT(1) NOT NULL DEFAULT 0,
  `late_offset_against_overtime` TINYINT(1) NOT NULL DEFAULT 0,

  -- Early-out.
  `early_exit_grace_minutes` INT NOT NULL DEFAULT 0,
  `early_exit_deduction_interval_minutes` INT NOT NULL DEFAULT 0,
  `early_exit_deduct_minutes` INT NOT NULL DEFAULT 0,
  `early_exit_offset_against_overtime` TINYINT(1) NOT NULL DEFAULT 0,

  -- Post-shift OT.
  `overtime_allowed` TINYINT(1) NOT NULL DEFAULT 0,
  `overtime_minimum_minutes` INT NOT NULL DEFAULT 0,
  `overtime_rounding_method` ENUM('NONE', 'UP', 'DOWN', 'NEAREST') NOT NULL DEFAULT 'NONE',
  `overtime_rounding_interval_minutes` INT NOT NULL DEFAULT 0,
  `overtime_minimum_threshold_only` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=minimum acts as a threshold to qualify, not as a floor on the paid amount',
  `maximum_ot_minutes_per_day` INT NULL COMMENT 'NULL = no cap',

  -- Pre-shift OT.
  `pre_shift_overtime_allowed` TINYINT(1) NOT NULL DEFAULT 0,
  `pre_shift_overtime_minimum_minutes` INT NOT NULL DEFAULT 0,
  `pre_shift_overtime_rounding_method` ENUM('NONE', 'UP', 'DOWN', 'NEAREST') NOT NULL DEFAULT 'NONE',
  `pre_shift_overtime_rounding_interval_minutes` INT NOT NULL DEFAULT 0,

  -- General attendance.
  `missed_clock_in_rule_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `missed_clock_in_treatment` ENUM('FULL_DAY', 'HALF_DAY', 'LEAVE') NOT NULL DEFAULT 'HALF_DAY',
  `minimum_hours_rule_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `minimum_half_day_minutes` INT NOT NULL DEFAULT 0,
  `minimum_full_day_minutes` INT NOT NULL DEFAULT 0,

  -- Regularization. Settings only; the request/approval workflow is not built.
  -- `regularization_limit_per_month` counts how many times in a month an
  -- employee may regularize, and is meaningful only while
  -- `regularization_control_enabled` = 1. NULL means no limit recorded.
  `regularization_allowed` TINYINT(1) NOT NULL DEFAULT 0,
  `regularization_control_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `regularization_limit_per_month` INT NULL COMMENT 'Times per month, not an age in days. Meaningful only when regularization_control_enabled = 1.',
  `regularization_require_existing_punch` TINYINT(1) NOT NULL DEFAULT 1,
  `regularization_requires_approval` TINYINT(1) NOT NULL DEFAULT 1,

  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY `uq_work_shift_shift_code` (`shift_code`)
);

-- One row per shift per weekday, and a saved schedule is always all seven.
-- `day_of_week` is 0=Sunday..6=Saturday, the JavaScript `Date.getDay()` /
-- node-cron numbering already used elsewhere in this backend (see
-- utils/api_sync_log_helpers.js).
--
-- `normal_work_minutes` is written by the backend from in/out/break, never
-- taken from the caller - see utils/workShift.js.
--
-- `attendance_day_cutoff` is the attendance-day boundary (which work date a
-- punch belongs to). It is NOT the overnight flag: whether a shift crosses
-- midnight is derived from out_time < in_time, not stored.
CREATE TABLE IF NOT EXISTS `work_shift_weekly_schedule` (
  `work_shift_weekly_schedule_id` INT AUTO_INCREMENT PRIMARY KEY,
  `work_shift_id` INT NOT NULL,
  `day_of_week` TINYINT NOT NULL COMMENT '0=Sunday .. 6=Saturday',
  `is_working_day` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=working day, 0=rest day',
  `in_time` TIME NULL COMMENT 'Required on a working day, NULL on a rest day',
  `out_time` TIME NULL COMMENT 'Required on a working day, NULL on a rest day',
  `attendance_day_cutoff` TIME NULL COMMENT 'Time of day after which a punch belongs to the next attendance day',
  `break_minutes` INT NOT NULL DEFAULT 0,
  `normal_work_minutes` INT NOT NULL DEFAULT 0 COMMENT 'out_time - in_time - break_minutes, computed by the backend',
  `ot_rate` DECIMAL(3,1) NOT NULL DEFAULT 1.0 COMMENT 'One of 0, 1, 1.5, 2, 3 - enforced in utils/workShift.js',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_work_shift_weekly_schedule_work_shift_id`
    FOREIGN KEY (`work_shift_id`) REFERENCES `work_shift` (`work_shift_id`) ON DELETE CASCADE,
  -- Also the index the foreign key needs: `work_shift_id` is its leftmost
  -- column, so a separate index on it would never be used.
  UNIQUE KEY `uq_work_shift_weekly_schedule_shift_day` (`work_shift_id`, `day_of_week`)
);
