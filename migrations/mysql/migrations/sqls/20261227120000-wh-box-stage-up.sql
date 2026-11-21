-- The box chain (Warehouse Health): a box's loading and unloading are two
-- RetailPilot jobs, linked by the box's source document. stage_id is that
-- document (STA slug, invoice slug, ...) from picknpack.box_dimension_joblets;
-- NULL on carton boxes and on uploaded files, where the box id, the store it
-- goes to and the time order pair them instead.
ALTER TABLE wh_report_box_rows
  ADD COLUMN stage_id VARCHAR(64) NULL AFTER job_id,
  ADD INDEX idx_wh_report_box_rows_trip (report_type, box_id, planned_to_store, report_date);
