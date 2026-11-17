-- Reverses 20261217120000-warehouse-daily-reports-up.sql. DESTROYS EVERY UPLOADED REPORT.
DROP TABLE IF EXISTS wh_report_box_rows;
DROP TABLE IF EXISTS wh_report_job_rows;
DROP TABLE IF EXISTS wh_report_uploads;
DELETE FROM `permissions` WHERE `permission_key` IN ('view_wh_daily_reports', 'upload_wh_daily_reports');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('view_wh_daily_reports', 'upload_wh_daily_reports');
