-- Reverse of 20260926120000-employee-family-key.
--
-- `employee_name` was never altered and every reader still uses it, so
-- dropping the column returns the table to exactly its previous state. The
-- backfilled links are discarded, which is safe precisely because nothing
-- reads them yet - and is why the application cutover is a separate change.
SET @drop_fk = IF(
  (SELECT COUNT(*) FROM `information_schema`.`TABLE_CONSTRAINTS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_family'
      AND `CONSTRAINT_NAME` = 'fk_employee_family_employee') > 0,
  'ALTER TABLE `employee_family` DROP FOREIGN KEY `fk_employee_family_employee`',
  'DO 0');
PREPARE stmt FROM @drop_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @drop_index = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_family'
      AND `INDEX_NAME` = 'idx_employee_family_employee') > 0,
  'ALTER TABLE `employee_family` DROP INDEX `idx_employee_family_employee`',
  'DO 0');
PREPARE stmt FROM @drop_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @drop_column = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_family'
      AND `COLUMN_NAME` = 'employee_id') > 0,
  'ALTER TABLE `employee_family` DROP COLUMN `employee_id`',
  'DO 0');
PREPARE stmt FROM @drop_column;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
