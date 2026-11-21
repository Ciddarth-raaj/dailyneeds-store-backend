-- The stage chain (Warehouse Health): the RetailPilot job state of each
-- Picking / Packing / Verification line. A PICKED_PACKED (pick-pack) job is
-- picked and packed in one: its goods go straight on to loading, with no
-- Packing line. NULL on uploaded files.
ALTER TABLE wh_report_job_rows
  ADD COLUMN job_state VARCHAR(30) NULL AFTER picking_job,
  ADD INDEX idx_wh_report_job_rows_chain (report_type, report_date, stage_id);
