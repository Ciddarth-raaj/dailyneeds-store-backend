DELETE FROM `permissions` WHERE `permission_key` IN ('upload_oos_report', 'chase_oos', 'view_my_oos');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('upload_oos_report', 'chase_oos', 'view_my_oos');
DROP TABLE IF EXISTS `oos_case_events`;
DROP TABLE IF EXISTS `oos_cases`;
DROP TABLE IF EXISTS `oos_uploads`;
