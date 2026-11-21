-- Reverses 20261226120000-warehouse-health-up.sql.
DROP TABLE IF EXISTS wh_health_summary_sends;
ALTER TABLE wh_report_job_rows
  DROP INDEX idx_wh_report_job_rows_picking_job,
  DROP INDEX idx_wh_report_job_rows_job,
  DROP COLUMN picking_job,
  DROP COLUMN stage_id;
DELETE FROM `permissions` WHERE `permission_key` IN ('view_warehouse_health', 'receive_warehouse_health_summary');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('view_warehouse_health', 'receive_warehouse_health_summary');
