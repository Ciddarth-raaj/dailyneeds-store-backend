-- Warehouse Daily Reports from RetailPilot: the five reports are now pulled
-- every night from RetailPilot's pick & pack jobs (picknpack.state_machine
-- and its article and box lines), not only uploaded as Excel.
--
--   wh_report_uploads.source   UPLOAD (a file) or RETAILPILOT (pulled)
--   *.worked_by                who did the job: RetailPilot's
--                              state_machine.assigned_user (a Keypoint user
--                              id; for loading and unloading, every user who
--                              scanned a box, comma-separated). NULL for
--                              uploaded files and system-finished jobs.
--   wh_report_job_rows.job_id  / wh_report_box_rows.job_id - the RetailPilot job.
ALTER TABLE wh_report_uploads
  ADD COLUMN source ENUM('UPLOAD','RETAILPILOT') NOT NULL DEFAULT 'UPLOAD' AFTER report_date;

ALTER TABLE wh_report_job_rows
  ADD COLUMN job_id VARCHAR(64) NULL AFTER report_date,
  ADD COLUMN worked_by VARCHAR(255) NULL AFTER open_jobs,
  ADD INDEX idx_wh_report_job_rows_worked_by (report_type, worked_by);

ALTER TABLE wh_report_box_rows
  ADD COLUMN job_id VARCHAR(64) NULL AFTER report_date,
  ADD COLUMN worked_by VARCHAR(255) NULL AFTER finished_at;
