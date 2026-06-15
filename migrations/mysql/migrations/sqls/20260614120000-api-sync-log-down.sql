DELETE FROM `all_permissions` WHERE `permission_key` = 'view_api_logs';
DROP TABLE IF EXISTS api_sync_cron_config;
DROP TABLE IF EXISTS api_sync_log;
