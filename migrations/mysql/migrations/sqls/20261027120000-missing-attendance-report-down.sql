-- Remove the Missing Attendance report's two permission keys, every grant of
-- them, and the notification ledger this migration created.
--
-- SAFE TO RUN. The keys gate only the read-only report router, so removing
-- them makes that screen 403 and changes nothing else. The table is dropped
-- because this migration created it and nothing else reads it: it holds no
-- attendance figure, no payroll figure and no employee detail - only the
-- record of which alerts were attempted. Dropping it means a re-run of the
-- 06:00 job could message somebody again about a date they were already told
-- about, which is the known and accepted cost of reversing this feature.
--
-- NO ATTENDANCE, PUNCH, SHIFT, EMPLOYEE OR PAYROLL TABLE IS TOUCHED, because
-- the `up` created none and altered none.
DROP TABLE IF EXISTS `attendance_missing_notification`;

DELETE FROM `permissions` WHERE `permission_key` IN ('view_missing_attendance_report', 'export_missing_attendance_report');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('view_missing_attendance_report', 'export_missing_attendance_report');
