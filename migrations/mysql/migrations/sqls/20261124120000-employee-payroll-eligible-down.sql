-- Drops exactly the column the up-migration added. Every employee marked
-- "not payroll eligible" returns to the payroll population.

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
                  AND `COLUMN_NAME` = 'payroll_eligible') = 1,
  'ALTER TABLE `new_employee` DROP COLUMN `payroll_eligible`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
