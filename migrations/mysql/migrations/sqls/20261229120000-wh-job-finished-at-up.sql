-- When each Picking / Packing / Verification line's RetailPilot job finished
-- (IST), so a write-off shows when it happened, not only the day. NULL for
-- open jobs, uploaded files and days pulled before this column.
ALTER TABLE wh_report_job_rows
  ADD COLUMN finished_at DATETIME NULL AFTER job_state;
