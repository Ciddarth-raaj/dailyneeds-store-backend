-- Reverses 20260924120000 exactly. `biomax_punch` is not touched.
DELETE FROM `permissions`
 WHERE `permission_key` IN ('void_attendance_punch');
DELETE FROM `all_permissions`
 WHERE `permission_key` IN ('void_attendance_punch');

DROP TABLE IF EXISTS `attendance_punch_void`;
