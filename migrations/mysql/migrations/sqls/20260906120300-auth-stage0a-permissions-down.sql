DELETE FROM `permissions` WHERE `permission_key` IN ('manage_user_accounts', 'unlock_user_accounts', 'view_auth_log');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('manage_user_accounts', 'unlock_user_accounts', 'view_auth_log');
