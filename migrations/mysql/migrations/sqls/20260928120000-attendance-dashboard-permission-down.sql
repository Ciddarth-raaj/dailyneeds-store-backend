-- Remove the Attendance Dashboard permission key and every grant of it.
--
-- Safe to run: the key gates only the read-only dashboard router, so removing
-- it makes that screen 403 and changes nothing else. No other permission,
-- designation, employee, attendance or payroll row is touched, and no table
-- is dropped or altered - this migration created none.
DELETE FROM `permissions` WHERE `permission_key` = 'view_attendance_dashboard';
DELETE FROM `all_permissions` WHERE `permission_key` = 'view_attendance_dashboard';
