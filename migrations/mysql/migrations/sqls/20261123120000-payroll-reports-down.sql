-- Reverses 20261123120000-payroll-reports. Payrun data is never touched.
DELETE FROM `report_template`
 WHERE `dataset_key` IN ('PAYROLL_REGISTER','PAYROLL_EPF','PAYROLL_ESI','PAYROLL_BANK','PAYROLL_OT','PAYROLL_DEDUCTIONS','PAYROLL_ATTENDANCE');
DELETE FROM `report_export_log` WHERE `format` IN ('pdf','ecr','esic');
ALTER TABLE `report_export_log`
  MODIFY COLUMN `format` ENUM('xlsx','csv') NOT NULL;
DROP TABLE IF EXISTS `payroll_report_default_template`;
DROP TABLE IF EXISTS `payroll_report_layout`;
