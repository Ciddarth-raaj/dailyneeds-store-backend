-- Reverses 20261225120000-wh-staff-map-up.sql. DESTROYS THE STAFF MAPPING.
DROP TABLE IF EXISTS wh_rp_staff_map;
DELETE FROM `permissions` WHERE `permission_key` = 'manage_wh_staff_map';
DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_wh_staff_map';
