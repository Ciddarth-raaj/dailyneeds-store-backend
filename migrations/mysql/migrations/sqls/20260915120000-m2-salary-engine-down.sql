-- Reverses M2.
--
-- THE SALARY TABLE IS DROPPED, WHICH DESTROYS SALARY HISTORY. That is what a
-- down migration for a new table means, and it is safe only while the table is
-- still empty - which it is until somebody records an opening salary. Once
-- real salaries exist, rolling back is an export first, not a `db-migrate
-- down`. The table is dropped LAST so that a failure earlier in this file
-- leaves the data still there.
--
-- `new_employee.salary` is untouched here because M2 never touched it.

-- The permission keys, by name, from both tables.
DELETE FROM `permissions` WHERE `permission_key` IN (
  'view_salary', 'add_salary', 'edit_salary', 'manual_salary_component_override',
  'approve_salary_revision', 'view_payroll', 'process_payroll', 'hr_reports');
DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'view_salary', 'add_salary', 'edit_salary', 'manual_salary_component_override',
  'approve_salary_revision', 'view_payroll', 'process_payroll', 'hr_reports');

-- The tri-state statutory field. Guarded so the file can be re-run.
SET @drop_previous_pf_member = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'new_employee'
      AND `COLUMN_NAME` = 'previous_pf_member') = 1,
  'ALTER TABLE `new_employee` DROP COLUMN `previous_pf_member`',
  'DO 0');
PREPARE drop_stmt FROM @drop_previous_pf_member;
EXECUTE drop_stmt;
DEALLOCATE PREPARE drop_stmt;

DROP TABLE IF EXISTS `employee_salary`;
