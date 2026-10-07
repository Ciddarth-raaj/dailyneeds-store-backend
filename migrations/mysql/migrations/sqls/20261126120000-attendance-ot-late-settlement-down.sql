-- Reverses 20261126120000. WARNING: once any prior-month OT has been settled
-- into a payroll, running this drops that money's breakdown (the payslip
-- snapshots keep their own copy). The column DROPs are guarded the same way
-- they were added.
SET @t = 'payrun_employee_calculation';
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'prior_month_ot') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `prior_month_ot`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = @t
                  AND `COLUMN_NAME` = 'prior_month_ot_amount') = 1,
  'ALTER TABLE `payrun_employee_calculation` DROP COLUMN `prior_month_ot_amount`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
DROP TABLE IF EXISTS `attendance_ot_late_settlement_log`;
DROP TABLE IF EXISTS `attendance_ot_late_settlement`;
