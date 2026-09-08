-- Drops both Aadhaar tables and the key declaration. The identity table must
-- go first: the verification table is its FK target.
DROP TABLE IF EXISTS `employee_aadhaar_identity`;
DROP TABLE IF EXISTS `employee_aadhaar_verification`;
DELETE FROM `permissions` WHERE `permission_key` = 'view_aadhaar_full';
DELETE FROM `all_permissions` WHERE `permission_key` = 'view_aadhaar_full';
