-- Reverses the Phase 1 Shift Master extension.
--
-- `shift_in_time`, `shift_out_time` and `status` were never dropped, so every
-- shift keeps its times and active flag after this runs. What is lost is the
-- Phase 1 configuration and the weekly schedule rows, which is the point.

DROP TABLE IF EXISTS `shift_weekly_schedule`;

ALTER TABLE `shift_master`
  DROP INDEX `uq_shift_master_shift_code`;

ALTER TABLE `shift_master`
  DROP COLUMN `shift_code`,
  DROP COLUMN `start_time`,
  DROP COLUMN `end_time`,
  DROP COLUMN `active`,
  DROP COLUMN `crosses_midnight`,
  DROP COLUMN `break_minutes`,
  DROP COLUMN `paid_hours`,
  DROP COLUMN `late_grace_minutes`,
  DROP COLUMN `late_deduction_interval_minutes`,
  DROP COLUMN `late_deduct_minutes`,
  DROP COLUMN `late_exclude_grace_from_deduction`,
  DROP COLUMN `late_offset_against_overtime`,
  DROP COLUMN `early_exit_grace_minutes`,
  DROP COLUMN `early_exit_deduction_interval_minutes`,
  DROP COLUMN `early_exit_deduct_minutes`,
  DROP COLUMN `early_exit_offset_against_overtime`,
  DROP COLUMN `overtime_allowed`,
  DROP COLUMN `overtime_minimum_minutes`,
  DROP COLUMN `overtime_rounding_method`,
  DROP COLUMN `overtime_rounding_interval_minutes`,
  DROP COLUMN `overtime_minimum_threshold_only`,
  DROP COLUMN `maximum_ot_minutes_per_day`,
  DROP COLUMN `pre_shift_overtime_allowed`,
  DROP COLUMN `pre_shift_overtime_minimum_minutes`,
  DROP COLUMN `pre_shift_overtime_rounding_method`,
  DROP COLUMN `pre_shift_overtime_rounding_interval_minutes`,
  DROP COLUMN `missed_clock_in_rule_enabled`,
  DROP COLUMN `missed_clock_in_treatment`,
  DROP COLUMN `minimum_hours_rule_enabled`,
  DROP COLUMN `minimum_half_day_minutes`,
  DROP COLUMN `minimum_full_day_minutes`,
  DROP COLUMN `regularization_allowed`,
  DROP COLUMN `regularization_control`,
  DROP COLUMN `regularization_limit_per_month`,
  DROP COLUMN `regularization_require_existing_punch`,
  DROP COLUMN `regularization_requires_approval`,
  DROP COLUMN `created_at`,
  DROP COLUMN `updated_at`;
