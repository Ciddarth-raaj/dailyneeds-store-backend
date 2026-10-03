-- Payrun lifecycle - down. Drops only what the up added.
DROP TABLE IF EXISTS `payrun_employee_lifecycle_audit`;
SET @t = 'payrun_employee_calculation';
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t AND `COLUMN_NAME` = 'net_pay_rounding') > 0, 'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `net_pay_rounding`', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t AND `COLUMN_NAME` = 'published_at') > 0, 'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `published_at`', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS` WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t AND `COLUMN_NAME` = 'published_by') > 0, 'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `published_by`', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
DELETE FROM `all_permissions` WHERE `permission_key` IN ('unlock_payrun', 'publish_payrun');
