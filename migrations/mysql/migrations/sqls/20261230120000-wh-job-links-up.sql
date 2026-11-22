-- The stage chain follows each line by the RetailPilot job it came from,
-- not by box id (carton barcodes are reused on every delivery) or date:
--   job lines: packing_job / loading_job / unloading_job from the line's meta
--              (a Verification line names its whole chain; picking_job is
--              already kept)
--   box rows:  picking_job, packing_job and packing_jobs (a merged GRN crate
--              can hold several, comma-separated) from the box joblet's meta
ALTER TABLE wh_report_job_rows
  ADD COLUMN packing_job VARCHAR(64) NULL AFTER picking_job,
  ADD COLUMN loading_job VARCHAR(64) NULL AFTER packing_job,
  ADD COLUMN unloading_job VARCHAR(64) NULL AFTER loading_job;

ALTER TABLE wh_report_box_rows
  ADD COLUMN picking_job VARCHAR(64) NULL AFTER stage_id,
  ADD COLUMN packing_job VARCHAR(64) NULL AFTER picking_job,
  ADD COLUMN packing_jobs VARCHAR(1000) NULL AFTER packing_job;
