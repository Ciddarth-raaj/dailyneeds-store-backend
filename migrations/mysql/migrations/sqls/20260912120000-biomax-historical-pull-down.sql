-- Reverse of 20260912120000-biomax-historical-pull.
--
-- Drops the three historical-pull tables (children first), removes the two
-- columns it added to biomax_punch, and the one permission key. No Part 1
-- table is dropped and no punch row is deleted: the two columns carry only
-- provenance, so removing them loses which rows a pull added, nothing else.
-- Raw result blocks ARE lost by this; take a dump first if any exist.

DROP TABLE IF EXISTS `biomax_command_result_block`;
DROP TABLE IF EXISTS `biomax_device_command`;
DROP TABLE IF EXISTS `biomax_historical_pull`;

SET @has_pull_id = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'biomax_historical_pull_id'
);
SET @drop_pull_id_sql = IF(@has_pull_id = 1, 'ALTER TABLE `biomax_punch` DROP COLUMN `biomax_historical_pull_id`', 'SELECT 1');
PREPARE drop_pull_id_stmt FROM @drop_pull_id_sql;
EXECUTE drop_pull_id_stmt;
DEALLOCATE PREPARE drop_pull_id_stmt;

SET @has_ingest_source = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biomax_punch' AND COLUMN_NAME = 'ingest_source'
);
SET @drop_ingest_source_sql = IF(@has_ingest_source = 1, 'ALTER TABLE `biomax_punch` DROP COLUMN `ingest_source`', 'SELECT 1');
PREPARE drop_ingest_source_stmt FROM @drop_ingest_source_sql;
EXECUTE drop_ingest_source_stmt;
DEALLOCATE PREPARE drop_ingest_source_stmt;

DELETE FROM `permissions` WHERE `permission_key` = 'manage_biomax_historical_pull';
DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_biomax_historical_pull';
