-- Removes the key and any grant of it made since. No purchase is touched.
DELETE FROM `permissions` WHERE `permission_key` = 'sync_retailpilot_purchases';
DELETE FROM `all_permissions` WHERE `permission_key` = 'sync_retailpilot_purchases';
