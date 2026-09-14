-- DigiSME attendance API sync - the automated replacement for the manual
-- Excel upload.
--
-- TWO CHANGES, both additive, both guarded, neither touching a punch row.
--
--   1. biomax_attendance_import_batch.source_type gains DIGISME_API_PULL.
--   2. api_sync_cron_config gains the two schedule rows the operator screen
--      reads, so the API Sync Log page can label and show these jobs.
--
-- WHAT DELIBERATELY DOES NOT CHANGE: `biomax_punch.ingest_source`. An API
-- punch is stored as DIGISME_IMPORT, exactly like an Excel one. The unique
-- `import_dedup_key` added by 20260913120000 is
--
--     CONCAT(ingest_source, '|', user_id, '|', io_time_raw)
--
-- so a separate DIGISME_API value would give the SAME REAL PUNCH two
-- different keys and let it exist twice - once from each route - which is
-- precisely what the key exists to prevent. The Excel/API distinction is
-- carried on the BATCH instead, where nothing but the audit reads it.

-- ================== 1. import batch: source_type gains DIGISME_API_PULL
-- Appending a value to an ENUM is a metadata-only change in MySQL 8:
-- DIGISME_ATD_DAILY keeps its position and every existing row its value.
-- Guarded on the column type so the file re-runs cleanly.
SET @source_type = (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'biomax_attendance_import_batch'
     AND COLUMN_NAME = 'source_type'
);
SET @sql = IF(@source_type IS NOT NULL AND @source_type NOT LIKE '%DIGISME_API_PULL%',
  'ALTER TABLE `biomax_attendance_import_batch` MODIFY COLUMN `source_type` ENUM(''DIGISME_ATD_DAILY'',''DIGISME_API_PULL'') NOT NULL DEFAULT ''DIGISME_ATD_DAILY'' COMMENT ''DIGISME_ATD_DAILY = the manual Excel upload; DIGISME_API_PULL = the automated GetRawAttendance sync''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ============================== 2. the operator-facing schedule rows
-- NOTE for whoever edits these later: this table does NOT schedule anything.
-- The real schedules are the strings passed to cronService.register() in
-- server.js; these rows are what the API Sync Log screen DISPLAYS, and the
-- two are kept equal by hand. Changing a cron here alone changes nothing but
-- the label - see 20260701120000-product-sync-cron-4am, which exists because
-- the two drifted apart once already.
INSERT INTO `api_sync_cron_config` (`log_type`, `label`, `category`, `cron_expression`, `is_enabled`) VALUES
  ('digisme_attendance_live', 'DigiSME Attendance (live)', 'sync', '* * * * *', 1),
  ('digisme_attendance_recovery', 'DigiSME Attendance Recovery', 'sync', '45 6,12,18,23 * * *', 1)
ON DUPLICATE KEY UPDATE
  `label` = VALUES(`label`),
  `category` = VALUES(`category`),
  `cron_expression` = VALUES(`cron_expression`);

-- REPORT ONLY.
SELECT (SELECT COUNT(*) FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'biomax_attendance_import_batch'
           AND COLUMN_NAME = 'source_type'
           AND COLUMN_TYPE LIKE '%DIGISME_API_PULL%') AS SOURCE_TYPE_READY,
       (SELECT COUNT(*) FROM `api_sync_cron_config`
         WHERE `log_type` IN ('digisme_attendance_live','digisme_attendance_recovery')) AS SCHEDULE_ROWS;
