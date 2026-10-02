-- Reverses 20261111120000. DROPS BOTH TABLES WITH THEIR ROWS - those rows are
-- the correction audit, so roll back only before this feature has been used, or
-- export the two tables first.
DELETE FROM `permissions`
 WHERE `permission_key` IN ('correct_locked_attendance');
DELETE FROM `all_permissions`
 WHERE `permission_key` IN ('correct_locked_attendance');

DROP TABLE IF EXISTS `attendance_locked_period_correction_event`;
DROP TABLE IF EXISTS `attendance_locked_period_authorisation`;
