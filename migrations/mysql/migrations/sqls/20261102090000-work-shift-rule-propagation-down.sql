ALTER TABLE `attendance_recalculation_run`
  DROP KEY `uq_arr_pending_shift`,
  DROP COLUMN `pending_work_shift_id`,
  DROP KEY `idx_arr_queue`,
  DROP COLUMN `queued_at`,
  DROP COLUMN `superseded_by_run_id`,
  DROP COLUMN `last_error`,
  DROP COLUMN `heartbeat_at`,
  DROP COLUMN `attempts`,
  DROP COLUMN `days_skipped_locked`,
  DROP COLUMN `work_shift_id`,
  DROP COLUMN `trigger_source`,
  MODIFY COLUMN `status`
    ENUM('RUNNING','COMPLETED','COMPLETED_WITH_ERRORS','FAILED')
    NOT NULL DEFAULT 'RUNNING';
