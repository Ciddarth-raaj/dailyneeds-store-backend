-- Rebuild the old switch from the policy: only `custom` meant "confined".
ALTER TABLE `user` ADD COLUMN `allow_outside_access` TINYINT(1) NOT NULL DEFAULT 1 AFTER `allowed_ips`;
UPDATE `user` SET `allow_outside_access` = 0 WHERE `ip_policy` = 'custom';
