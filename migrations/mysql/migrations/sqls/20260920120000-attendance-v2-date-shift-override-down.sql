-- Reverses 20260920120000 exactly.
DELETE FROM `permissions`
 WHERE `permission_key` IN ('edit_attendance_date_shift');
DELETE FROM `all_permissions`
 WHERE `permission_key` IN ('edit_attendance_date_shift');

DROP TABLE IF EXISTS `attendance_date_shift_override`;
