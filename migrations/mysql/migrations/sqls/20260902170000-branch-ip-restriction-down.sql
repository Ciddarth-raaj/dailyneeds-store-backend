DELETE FROM `all_permissions` WHERE `permission_key` = 'view_branch';

ALTER TABLE `user` DROP COLUMN `ip_policy`;

ALTER TABLE `outlets` DROP COLUMN `ip_restriction_enabled`, DROP COLUMN `allowed_ips`;
