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
DROP TABLE IF EXISTS `employee_break_override`;
