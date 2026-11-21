-- Reverses 20261228120000-wh-job-state-up.sql.
ALTER TABLE wh_report_job_rows
  DROP INDEX idx_wh_report_job_rows_chain,
  DROP COLUMN job_state;
