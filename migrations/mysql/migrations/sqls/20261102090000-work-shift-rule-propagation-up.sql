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
  ADD COLUMN `queued_at` TIMESTAMP(3) NULL
    COMMENT 'when the propagation obligation was recorded; survives every claim, unlike started_at',
  ADD KEY `idx_arr_queue` (`status`, `trigger_source`, `attendance_recalculation_run_id`);

-- ONE PENDING PROPAGATION PER SHIFT, ENFORCED BY THE DATABASE.
--
-- Two Work Shift saves committing at the same moment both SELECT, both find
-- no queued row, and both INSERT: "one pending job per shift" was a claim the
-- code could not keep. MySQL has no partial index, so the invariant is
-- expressed as a generated column that is NULL for every row the rule does
-- not cover - a completed run, a failed one, a manual bulk run - and NULLs do
-- not collide in a UNIQUE index. Historical rows therefore all read NULL and
-- none of them can conflict.
--
-- The loser of the race now gets ER_DUP_ENTRY instead of writing a duplicate,
-- and `repository/work_shift.js` reuses the row that won.
ALTER TABLE `attendance_recalculation_run`
  ADD COLUMN `pending_work_shift_id` INT
    GENERATED ALWAYS AS (
      IF(`status` = 'QUEUED' AND `trigger_source` = 'WORK_SHIFT_SAVE', `work_shift_id`, NULL)
    ) STORED
    COMMENT 'the shift this run still owes a propagation for, NULL when it owes none',
  ADD UNIQUE KEY `uq_arr_pending_shift` (`pending_work_shift_id`);
