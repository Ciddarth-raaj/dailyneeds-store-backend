-- Schedule rows for jobs that no longer run, which the API Logs "Sync Jobs"
-- tab showed as nothing but missed slots:
--   digisme_attendance_live / _recovery  off in production
--     (DIGISME_ATTENDANCE_CRON_ENABLED=false; attendance comes from Biomax)
--   product_sync               its 4:00 cron was removed; products now sync
--     inside the 6:00 RetailPilot Stock & Prices run
--   stock_holding_report_sync  the retired Delium/GoFrugal pull
--
-- THE HISTORY STAYS: api_sync_log rows are not touched, and
-- constants/api_sync_types.js keeps the labels.
SET @had_rows = (SELECT COUNT(*) FROM `api_sync_cron_config` WHERE `log_type` IN (
  'digisme_attendance_live', 'digisme_attendance_recovery', 'product_sync', 'stock_holding_report_sync'));

DELETE FROM `api_sync_cron_config` WHERE `log_type` IN (
  'digisme_attendance_live', 'digisme_attendance_recovery', 'product_sync', 'stock_holding_report_sync');

-- REPORT ONLY.
SELECT @had_rows AS DEAD_SYNC_SCHEDULE_ROWS_REMOVED;
