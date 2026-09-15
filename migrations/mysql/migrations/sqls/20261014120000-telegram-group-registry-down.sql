-- Reverses 20261014120000. The registry is a record of which groups exist and
-- nothing else reads it, so dropping the table loses no other feature's data.
DELETE FROM `permissions`     WHERE `permission_key` IN ('view_telegram_groups', 'manage_telegram_groups');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('view_telegram_groups', 'manage_telegram_groups');

DROP TABLE IF EXISTS `telegram_group_registry`;
