-- Reverses 20261224120000-wh-report-nlc-up.sql. The values are cleared: they
-- are NLC, not MRP.
UPDATE wh_report_box_rows SET nlc = NULL;
ALTER TABLE wh_report_box_rows CHANGE COLUMN nlc mrp DECIMAL(15,2) NULL;
UPDATE wh_report_job_rows SET nlc = NULL, nlc_source = NULL;
ALTER TABLE wh_report_job_rows
  CHANGE COLUMN nlc mrp DECIMAL(15,2) NULL,
  CHANGE COLUMN nlc_source mrp_source ENUM('FILE','GRN') NULL;
