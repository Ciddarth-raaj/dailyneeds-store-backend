-- Reverse of 20260913120000-digisme-attendance-import.
--
-- Drops the two staging tables, the import dedup key and batch link, and
-- the permission key. It does NOT put the NOT NULL constraints back on
-- dev_id / raw_json and does not shrink the ingest_source ENUM: with any
-- imported punch present those would fail or destroy data. Imported punch
-- rows are NOT deleted by this file; remove them deliberately if required.

DROP TABLE IF EXISTS `biomax_attendance_import_item`;
DROP TABLE IF EXISTS `biomax_attendance_import_batch`;

SET @has_dedup = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'import_dedup_key');
SET @sql = IF(@has_dedup = 1, 'ALTER TABLE `biomax_punch` DROP COLUMN `import_dedup_key`', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @has_batch = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'import_batch_id');
SET @sql = IF(@has_batch = 1, 'ALTER TABLE `biomax_punch` DROP COLUMN `import_batch_id`', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

DELETE FROM `permissions` WHERE `permission_key` = 'manage_attendance_import';
DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_attendance_import';
