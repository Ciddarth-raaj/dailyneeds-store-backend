DROP TABLE IF EXISTS grn_verifications;

DELETE FROM `all_permissions`
WHERE `permission_key` = 'verify_grn';
