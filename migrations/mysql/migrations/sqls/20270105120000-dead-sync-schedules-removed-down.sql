-- Reverse of 20270105120000-dead-sync-schedules-removed: the rows come back
-- as they were seeded. Re-runnable.
INSERT INTO `api_sync_cron_config` (`log_type`, `label`, `category`, `cron_expression`, `is_enabled`)
SELECT t.log_type, t.label, 'sync', t.cron_expression, 1
FROM (
  SELECT 'digisme_attendance_live' AS log_type, 'DigiSME Attendance (live)' AS label, '* * * * *' AS cron_expression
  UNION ALL SELECT 'digisme_attendance_recovery', 'DigiSME Attendance Recovery', '45 6,12,18,23 * * *'
  UNION ALL SELECT 'product_sync', 'Product Sync', '0 4 * * *'
  UNION ALL SELECT 'stock_holding_report_sync', 'Stock Holding Report Sync', '30 7 * * *'
) t
WHERE NOT EXISTS (SELECT 1 FROM `api_sync_cron_config` c WHERE c.log_type = t.log_type);
