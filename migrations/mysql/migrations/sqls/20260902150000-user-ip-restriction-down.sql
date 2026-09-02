DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_ip_restrictions';

ALTER TABLE `user` DROP COLUMN `allowed_ips`;
