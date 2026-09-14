-- Reverse of 20261013120000-digisme-attendance-api-sync.
--
-- The schedule rows go. The ENUM is NARROWED ONLY IF NOTHING USES IT: a
-- batch already recorded as DIGISME_API_PULL is the audit record of punches
-- that are in biomax_punch right now, and silently rewriting it to
-- DIGISME_ATD_DAILY would claim those punches came from a spreadsheet that
-- never existed. If any such row remains the column is left exactly as it
-- is and the SELECT below says so.
DELETE FROM `api_sync_cron_config`
 WHERE `log_type` IN ('digisme_attendance_live', 'digisme_attendance_recovery');

SET @api_batches = (SELECT COUNT(*) FROM `biomax_attendance_import_batch` WHERE `source_type` = 'DIGISME_API_PULL');
SET @sql = IF(@api_batches = 0,
  'ALTER TABLE `biomax_attendance_import_batch` MODIFY COLUMN `source_type` ENUM(''DIGISME_ATD_DAILY'') NOT NULL DEFAULT ''DIGISME_ATD_DAILY''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- REPORT ONLY.
SELECT @api_batches AS API_BATCHES_FOUND,
       IF(@api_batches = 0, 'ENUM narrowed', 'ENUM KEPT - API batches exist') AS OUTCOME;
