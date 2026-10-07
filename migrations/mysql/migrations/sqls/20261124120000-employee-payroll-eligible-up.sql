-- PAYROLL ELIGIBLE - whether this employee is paid through DnDS payroll.
--
-- ONE ADDITIVE COLUMN, NO DATA REWRITTEN. DEFAULT 1 and NOT NULL, so every
-- employee who exists today stays payroll-eligible exactly as before, and
-- every employee created afterwards is eligible unless an administrator
-- says otherwise.
--
-- WHAT `0` MEANS. The employee is left out of the payroll population: not
-- listed, counted, initialized, calculated, paid or reported by payroll for
-- any month that has not already been initialized. It is NOT a status, NOT
-- a resignation and NOT an attendance switch - the employee stays active in
-- the Employee Master and in attendance. Months already initialized keep
-- their payrun rows unchanged (the flag is not effective-dated).
--
-- Guarded by information_schema, so a re-run is a no-op.

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
                  AND `COLUMN_NAME` = 'payroll_eligible') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `payroll_eligible` TINYINT(1) NOT NULL DEFAULT 1 COMMENT ''1 = paid through DnDS payroll; 0 = salary not applicable, excluded from the payroll population (still active, attendance unchanged)'' AFTER `attendance_required`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
