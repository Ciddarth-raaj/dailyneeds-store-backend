-- Reverse of 20260911120000-biomax-raw-attendance.
--
-- Drops the eight Biomax tables (children first, for the foreign keys) and
-- removes the six permission keys and their grants. Touches nothing else.
-- RAW PUNCH DATA IS LOST BY THIS - it is a down migration, not a cleanup;
-- take a dump first if any real punches have been received.

DROP TABLE IF EXISTS `biomax_derivation_change`;
DROP TABLE IF EXISTS `biomax_derivation_run`;
DROP TABLE IF EXISTS `biomax_punch_derived`;
DROP TABLE IF EXISTS `biomax_punch`;
DROP TABLE IF EXISTS `biomax_raw_request`;
DROP TABLE IF EXISTS `biomax_device_event`;
DROP TABLE IF EXISTS `biomax_device_assignment`;
DROP TABLE IF EXISTS `biomax_device`;

DELETE FROM `permissions`
 WHERE `permission_key` IN ('view_raw_attendance', 'export_raw_attendance',
                            'view_attendance_punch_audit', 'view_biomax_devices',
                            'manage_biomax_devices', 'rederive_attendance');
DELETE FROM `all_permissions`
 WHERE `permission_key` IN ('view_raw_attendance', 'export_raw_attendance',
                            'view_attendance_punch_audit', 'view_biomax_devices',
                            'manage_biomax_devices', 'rederive_attendance');
