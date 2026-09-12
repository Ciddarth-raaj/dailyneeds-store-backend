-- Reverses 20260918120000 exactly. The permission ROWS are removed too,
-- because this migration is the only thing that created them; nothing that
-- existed before is restored, because nothing that existed before was changed.
DELETE FROM `permissions`
 WHERE `permission_key` IN ('view_calculated_attendance', 'recalculate_attendance',
                            'view_attendance_payroll', 'manage_employee_break_override');
DELETE FROM `all_permissions`
 WHERE `permission_key` IN ('view_calculated_attendance', 'recalculate_attendance',
                            'view_attendance_payroll', 'manage_employee_break_override');

DROP TABLE IF EXISTS `attendance_monthly_payroll`;
DROP TABLE IF EXISTS `attendance_day_calculation`;

-- The Special Break Duration Override column. Dropping it loses the overrides
-- that were entered, which is exactly what reversing the migration that
-- introduced the field means; nothing else on `new_employee` is touched.
ALTER TABLE `new_employee` DROP COLUMN `special_break_override_minutes`;
