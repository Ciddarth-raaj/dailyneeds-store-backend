-- Reverses 20261201120000-fnf-settlement.
--
-- DESTRUCTIVE FOR F&F DATA: it drops the exit cases, settlement history, exit
-- interviews, rehire assessments / exceptions and the exit-reconcile audit.
-- Take a dump of those tables first if any has been used. No payroll figure
-- and no payslip is touched (only the payslip's document_type column goes).
DROP TABLE IF EXISTS `employee_rehire_exception`;
DROP TABLE IF EXISTS `employee_rehire_assessment`;
DROP TABLE IF EXISTS `employee_exit_interview`;
DROP TABLE IF EXISTS `employee_fnf_settlement_event`;
DROP TABLE IF EXISTS `employee_fnf_settlement`;
DROP TABLE IF EXISTS `payrun_exit_reconcile_audit`;

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'payrun_payslip'
                  AND `COLUMN_NAME` = 'document_type') = 1,
  'ALTER TABLE `payrun_payslip` DROP COLUMN `document_type`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

DELETE FROM `permissions` WHERE `permission_key` IN
  ('view_fnf_settlement','confirm_fnf_payment','view_exit_interview','manage_exit_interview','override_rehire_eligibility','approve_rehire_exception');
DELETE FROM `all_permissions` WHERE `permission_key` IN
  ('view_fnf_settlement','confirm_fnf_payment','view_exit_interview','manage_exit_interview','override_rehire_eligibility','approve_rehire_exception');
