-- Reverse of 20260927120000-digisme-employee-sync-removed.
--
-- Restores the schedule row as Stage 0C left it: DISABLED. It is not
-- re-enabled, because the code that the schedule would run no longer exists -
-- reinstating that is a code change, not a migration. Guarded on the unique
-- key so a re-run adds nothing.
INSERT INTO `api_sync_cron_config` (`log_type`, `label`, `category`, `cron_expression`, `is_enabled`)
  SELECT 'employee_sync', 'Employee Sync', 'sync', '0 7 * * *', 0 FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `api_sync_cron_config` WHERE `log_type` = 'employee_sync');
