-- Reverses 20261112120000-payrun-payslip. Drops the payslip tables and the
-- lifecycle log's payslip_id column. Payroll figures and statuses are untouched.
DROP TABLE IF EXISTS `payrun_payslip_notification`;
DROP TABLE IF EXISTS `payrun_payslip`;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_lifecycle_audit'
                  AND `COLUMN_NAME` = 'payslip_id') = 1,
  'ALTER TABLE `payrun_employee_lifecycle_audit` DROP COLUMN `payslip_id`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
