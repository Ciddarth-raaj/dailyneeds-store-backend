-- Reverses 20261201120000-fnf-settlement.
--
-- DESTRUCTIVE FOR F&F DATA: it drops the exit interviews, rehire assessments,
-- settlement records and F&F items. Take a dump of those six tables first if
-- any F&F has been processed. Payroll figures of ordinary months are not
-- touched; a calculation that carried F&F items loses its F&F columns, so any
-- such month must be unlocked and recalculated after a rollback.
DROP TABLE IF EXISTS `employee_rehire_assessment`;
DROP TABLE IF EXISTS `employee_exit_interview`;
DROP TABLE IF EXISTS `employee_fnf_settlement_event`;
DROP TABLE IF EXISTS `employee_fnf_settlement`;
DROP TABLE IF EXISTS `payrun_fnf_item_audit`;
DROP TABLE IF EXISTS `payrun_fnf_item`;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_payslip'
                  AND `COLUMN_NAME` = 'document_type') = 1,
  'ALTER TABLE `payrun_payslip` DROP COLUMN `document_type`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'fnf_items') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `fnf_items`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'fnf_deductions') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `fnf_deductions`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_employee_calculation'
                  AND `COLUMN_NAME` = 'fnf_additions') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `fnf_additions`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

DELETE FROM `permissions` WHERE `permission_key` IN
  ('view_fnf_settlement','manage_fnf_settlement','view_exit_interview','manage_exit_interview','override_rehire_eligibility');
DELETE FROM `all_permissions` WHERE `permission_key` IN
  ('view_fnf_settlement','manage_fnf_settlement','view_exit_interview','manage_exit_interview','override_rehire_eligibility');
