-- Work Shift rule propagation - the DURABLE, auditable recalculation job.
--
-- ADDITIVE ONLY. Columns and one ENUM value on the existing
-- `attendance_recalculation_run` table; no data is rewritten, no index is
-- dropped and no other table is touched. Every existing INSERT keeps working
-- unchanged, and an old row simply reads `trigger_source = 'MANUAL'`.
--
-- WHY THE RUN TABLE AND NOT A NEW QUEUE. A propagation IS a recalculation
-- run - the same work, the same counts, the same errors, on the same screen -
-- and the only thing it additionally needs is to be picked up later. A second
-- table would mean two places to look for "what happened to my recalculation"
-- and two definitions of its status. So the run row is the queue: it is
-- written by the Work Shift save as QUEUED, claimed by the worker, and
-- finished exactly as a manual run is.
--
-- DURABILITY. The row is committed by the save's own request, so a pm2
-- restart cannot lose the requested propagation: the worker finds it on its
-- next tick. `heartbeat_at` is what lets a run interrupted mid-flight (the
-- restart that happened WHILE it ran) be recognised as stale and requeued
-- instead of sitting in RUNNING forever, and `attempts` is what stops that
-- recovery from becoming an infinite loop.

ALTER TABLE `attendance_recalculation_run`
  MODIFY COLUMN `status`
    ENUM('QUEUED','RUNNING','COMPLETED','COMPLETED_WITH_ERRORS','FAILED')
    NOT NULL DEFAULT 'RUNNING',
  ADD COLUMN `trigger_source` ENUM('MANUAL','WORK_SHIFT_SAVE') NOT NULL DEFAULT 'MANUAL'
    COMMENT 'what started this run' AFTER `requested_by_employee_id`,
  ADD COLUMN `work_shift_id` INT NULL
    COMMENT 'the work shift whose save started this run, NULL for a manual run' AFTER `designation_id`,
  ADD COLUMN `days_skipped_locked` INT NOT NULL DEFAULT 0
    COMMENT 'attendance days left untouched because their payroll month is approved and locked' AFTER `days_processed`,
  ADD COLUMN `attempts` INT NOT NULL DEFAULT 0
    COMMENT 'how many times the worker has claimed this run',
  ADD COLUMN `heartbeat_at` TIMESTAMP(3) NULL
    COMMENT 'last sign of life from the worker processing this run',
  ADD COLUMN `last_error` TEXT NULL
    COMMENT 'why the last attempt failed, when it failed as a whole',
  ADD KEY `idx_arr_queue` (`status`, `attendance_recalculation_run_id`);
