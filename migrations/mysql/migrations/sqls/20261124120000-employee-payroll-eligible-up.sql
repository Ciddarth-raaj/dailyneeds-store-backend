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
--
-- AND ITS AUDIT TRAIL. DnDS has no general Employee Master change audit (the
-- other admin-only switches are only application-logged), so this flag gets
-- its own append-only table: who changed whom, from what to what, and when.
-- No row is written by this migration.

SET @sql = IF((SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
                WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
                  AND `COLUMN_NAME` = 'payroll_eligible') = 0,
  'ALTER TABLE `new_employee` ADD COLUMN `payroll_eligible` TINYINT(1) NOT NULL DEFAULT 1 COMMENT ''1 = paid through DnDS payroll; 0 = salary not applicable, excluded from the payroll population (still active, attendance unchanged)'' AFTER `attendance_required`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `employee_payroll_eligible_audit` (
  `audit_id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `employee_id`        INT NOT NULL,
  `old_value`          TINYINT(1) NOT NULL,
  `new_value`          TINYINT(1) NOT NULL,
  `changed_by`         INT NULL DEFAULT NULL COMMENT 'acting employee_id; NULL for an account with no employee record',
  `changed_by_user_id` INT NULL DEFAULT NULL COMMENT 'acting user.user_id',
  `changed_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`audit_id`),
  KEY `idx_payroll_eligible_audit_employee` (`employee_id`, `changed_at`),
  CONSTRAINT `fk_payroll_eligible_audit_employee`
    FOREIGN KEY (`employee_id`) REFERENCES `new_employee` (`employee_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='append-only: one row per change of new_employee.payroll_eligible';
