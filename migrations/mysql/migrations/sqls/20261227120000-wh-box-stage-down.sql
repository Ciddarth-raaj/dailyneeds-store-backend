-- Reverses 20261227120000-wh-box-stage-up.sql.
ALTER TABLE wh_report_box_rows
  DROP INDEX idx_wh_report_box_rows_trip,
  DROP COLUMN stage_id;
