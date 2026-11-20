-- Reverses 20261223120000-wh-report-retailpilot-up.sql. Pulled reports stay,
-- but lose who did each job and which job it was.
ALTER TABLE wh_report_box_rows DROP COLUMN worked_by, DROP COLUMN job_id;
ALTER TABLE wh_report_job_rows DROP INDEX idx_wh_report_job_rows_worked_by, DROP COLUMN worked_by, DROP COLUMN job_id;
ALTER TABLE wh_report_uploads DROP COLUMN source;
