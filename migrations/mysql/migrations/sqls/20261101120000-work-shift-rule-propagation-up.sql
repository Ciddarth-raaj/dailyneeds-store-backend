-- Work Shift rule propagation - the AUDIT of a recalculation a shift SAVE started.
--
-- ADDITIVE ONLY. Three nullable/defaulted columns on the existing
-- `attendance_recalculation_run` table; no data is rewritten, no index is
-- dropped and no other table is touched. Every existing INSERT keeps working
-- unchanged, and an old row simply reads `trigger_source = 'MANUAL'`.
--
-- WHY. A shift rule saved today now recalculates the open attendance dates
-- of everybody who was on that shift, automatically. That is a write nobody
-- explicitly asked for on the Recalculate screen, so it has to be as
-- traceable as one that was: which shift started it, that it was a shift
-- save rather than a person, and how many days were left alone because their
-- payroll month is locked.

ALTER TABLE `attendance_recalculation_run`
  ADD COLUMN `trigger_source` ENUM('MANUAL','WORK_SHIFT_SAVE') NOT NULL DEFAULT 'MANUAL'
    COMMENT 'what started this run' AFTER `requested_by_employee_id`,
  ADD COLUMN `work_shift_id` INT NULL
    COMMENT 'the work shift whose save started this run, NULL for a manual run' AFTER `designation_id`,
  ADD COLUMN `days_skipped_locked` INT NOT NULL DEFAULT 0
    COMMENT 'attendance days left untouched because their payroll month is approved and locked' AFTER `days_processed`;
