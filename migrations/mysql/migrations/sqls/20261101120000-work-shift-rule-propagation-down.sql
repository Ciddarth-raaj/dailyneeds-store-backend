ALTER TABLE `attendance_recalculation_run`
  DROP COLUMN `trigger_source`,
  DROP COLUMN `work_shift_id`,
  DROP COLUMN `days_skipped_locked`;
