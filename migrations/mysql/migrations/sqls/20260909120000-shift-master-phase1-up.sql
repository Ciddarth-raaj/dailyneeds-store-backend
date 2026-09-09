-- Shift Master Phase 1 - the configuration payroll will later read.
--
-- Additive only. Every existing `shift_id` keeps its row, and the three
-- original columns (`shift_in_time`, `shift_out_time`, `status`) are LEFT IN
-- PLACE rather than renamed: the live web app reads all three, so an outright
-- rename would break it on deploy. The new spellings are added alongside and
-- backfilled from the originals, and repository/shift.js writes both until the
-- frontend has moved over. Dropping the originals is a later, separate
-- migration - deliberately not this one.
--
-- Nothing here calculates payroll. These are settings fields only; the
-- lateness, early-out and OT engines that consume them are a later phase.

ALTER TABLE `shift_master`
  -- Basic. `shift_code` is left NULL on existing rows: there is no safe way to
  -- derive a code for a shift that never had one, so it is for an operator to
  -- fill in. UNIQUE (added below) permits many NULLs, one of each real code.
  ADD COLUMN `shift_code` VARCHAR(20) NULL AFTER `shift_id`,
  ADD COLUMN `start_time` TIME NULL AFTER `shift_name`,
  ADD COLUMN `end_time` TIME NULL AFTER `start_time`,
  ADD COLUMN `active` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=active, 0=inactive. Successor to `status`.',
  ADD COLUMN `crosses_midnight` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=end_time lands on the next calendar day',
  ADD COLUMN `break_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `paid_hours` DECIMAL(4,2) NULL COMMENT 'Hours paid for a full day of this shift. NULL = not configured.',

  -- Lateness. Configuration for a deduction engine that does not exist yet.
  ADD COLUMN `late_grace_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `late_deduction_interval_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `late_deduct_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `late_exclude_grace_from_deduction` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `late_offset_against_overtime` TINYINT(1) NOT NULL DEFAULT 0,

  -- Early-out.
  ADD COLUMN `early_exit_grace_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `early_exit_deduction_interval_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `early_exit_deduct_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `early_exit_offset_against_overtime` TINYINT(1) NOT NULL DEFAULT 0,

  -- Post-shift OT.
  ADD COLUMN `overtime_allowed` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `overtime_minimum_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `overtime_rounding_method` ENUM('NONE', 'UP', 'DOWN', 'NEAREST') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `overtime_rounding_interval_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `overtime_minimum_threshold_only` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=minimum acts as a threshold to qualify, not as a floor on the paid amount',
  ADD COLUMN `maximum_ot_minutes_per_day` INT NULL COMMENT 'NULL = no cap',

  -- Pre-shift OT.
  ADD COLUMN `pre_shift_overtime_allowed` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `pre_shift_overtime_minimum_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `pre_shift_overtime_rounding_method` ENUM('NONE', 'UP', 'DOWN', 'NEAREST') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `pre_shift_overtime_rounding_interval_minutes` INT NOT NULL DEFAULT 0,

  -- General attendance.
  ADD COLUMN `missed_clock_in_rule_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `missed_clock_in_treatment` ENUM('FULL_DAY', 'HALF_DAY', 'LEAVE') NOT NULL DEFAULT 'HALF_DAY',
  ADD COLUMN `minimum_hours_rule_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `minimum_half_day_minutes` INT NOT NULL DEFAULT 0,
  ADD COLUMN `minimum_full_day_minutes` INT NOT NULL DEFAULT 0,

  -- Regularization. Settings only; the request/approval workflow is not built.
  ADD COLUMN `regularization_allowed` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `regularization_control` ENUM('NONE', 'LIMITED', 'UNLIMITED') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `regularization_limit_per_month` INT NULL COMMENT 'Meaningful only when regularization_control = LIMITED',
  ADD COLUMN `regularization_require_existing_punch` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `regularization_requires_approval` TINYINT(1) NOT NULL DEFAULT 1,

  ADD COLUMN `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Backfill the renamed columns from the originals, row by row, preserving
-- every existing value. `status` is treated as 1=active, which is how the web
-- app's toggle writes it; anything non-zero is read as active rather than
-- silently deactivating a shift.
UPDATE `shift_master`
SET `start_time` = `shift_in_time`,
    `end_time` = `shift_out_time`,
    `active` = CASE WHEN `status` = 0 THEN 0 ELSE 1 END,
    -- An end strictly earlier than the start can only be the next day. Equal
    -- times stay 0: that is ambiguous, and 0 is the pre-existing behaviour.
    `crosses_midnight` = CASE WHEN `shift_out_time` < `shift_in_time` THEN 1 ELSE 0 END;

ALTER TABLE `shift_master`
  ADD UNIQUE KEY `uq_shift_master_shift_code` (`shift_code`);

-- One row per shift per weekday. `day_of_week` is 0=Sunday..6=Saturday, the
-- JavaScript `Date.getDay()` / node-cron numbering already used elsewhere in
-- this backend (see utils/api_sync_log_helpers.js).
CREATE TABLE IF NOT EXISTS `shift_weekly_schedule` (
  `shift_weekly_schedule_id` INT AUTO_INCREMENT PRIMARY KEY,
  `shift_id` INT NOT NULL,
  `day_of_week` TINYINT NOT NULL COMMENT '0=Sunday .. 6=Saturday',
  `is_working_day` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=working day, 0=rest day',
  `in_time` TIME NULL COMMENT 'Required on a working day, NULL on a rest day',
  `out_time` TIME NULL COMMENT 'Required on a working day, NULL on a rest day',
  `attendance_day_cutoff` TIME NULL COMMENT 'Time of day after which a punch belongs to the next attendance day',
  `break_minutes` INT NOT NULL DEFAULT 0,
  `normal_work_minutes` INT NOT NULL DEFAULT 0 COMMENT 'out_time - in_time - break_minutes, computed by the backend',
  `ot_rate` DECIMAL(3,1) NOT NULL DEFAULT 1.0 COMMENT 'One of 0, 1, 1.5, 2, 3 - enforced in utils/shiftSchedule.js',
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_shift_weekly_schedule_shift_id`
    FOREIGN KEY (`shift_id`) REFERENCES `shift_master` (`shift_id`) ON DELETE CASCADE,
  UNIQUE KEY `uq_shift_weekly_schedule_shift_day` (`shift_id`, `day_of_week`),
  INDEX `idx_shift_weekly_schedule_shift_id` (`shift_id`)
);
