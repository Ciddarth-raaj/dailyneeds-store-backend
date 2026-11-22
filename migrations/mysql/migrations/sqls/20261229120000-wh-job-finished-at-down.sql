-- Reverses 20261229120000-wh-job-finished-at-up.sql.
ALTER TABLE wh_report_job_rows
  DROP COLUMN finished_at;
