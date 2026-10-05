-- Removes the key and any grant of it made since. Company records are not touched.
DELETE FROM `permissions` WHERE `permission_key` = 'manage_company_details';
DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_company_details';
