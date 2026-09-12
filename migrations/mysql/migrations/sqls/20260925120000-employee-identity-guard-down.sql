-- Reverse of 20260925120000-employee-identity-guard.
--
-- Drops the unique key, the two source-identity columns and the name index.
-- No employee row was written by the up migration, so nothing is restored
-- here; dropping the columns discards any source codes written since, which
-- is the point of a down migration for an additive change.
SET @drop_source_key = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `INDEX_NAME` = 'uq_new_employee_source') > 0,
  'ALTER TABLE `new_employee` DROP INDEX `uq_new_employee_source`',
  'DO 0');
PREPARE stmt FROM @drop_source_key;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @drop_source_code = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'source_employee_code') > 0,
  'ALTER TABLE `new_employee` DROP COLUMN `source_employee_code`',
  'DO 0');
PREPARE stmt FROM @drop_source_code;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @drop_source_system = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'source_system') > 0,
  'ALTER TABLE `new_employee` DROP COLUMN `source_system`',
  'DO 0');
PREPARE stmt FROM @drop_source_system;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @drop_name_index = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `INDEX_NAME` = 'idx_new_employee_name') > 0,
  'ALTER TABLE `new_employee` DROP INDEX `idx_new_employee_name`',
  'DO 0');
PREPARE stmt FROM @drop_name_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
