-- Warehouse Daily Reports are valued at NLC (net landing cost), never MRP.
-- The mrp columns become nlc (RetailPilot inventory_batches.net_landing_cost:
-- the stock-weighted average of the article's batches in stock, else the
-- average of its batches). Values already stored are MRP, so they are
-- cleared; the nightly pull and Analysis' "Fill NLC from RetailPilot" fill
-- them in again.
ALTER TABLE wh_report_job_rows
  CHANGE COLUMN mrp nlc DECIMAL(15,4) NULL COMMENT 'net landing cost per unit, from RetailPilot',
  CHANGE COLUMN mrp_source nlc_source VARCHAR(20) NULL;
UPDATE wh_report_job_rows SET nlc = NULL, nlc_source = NULL;

ALTER TABLE wh_report_box_rows
  CHANGE COLUMN mrp nlc DECIMAL(15,4) NULL COMMENT 'net landing cost per unit, from RetailPilot';
UPDATE wh_report_box_rows SET nlc = NULL;
