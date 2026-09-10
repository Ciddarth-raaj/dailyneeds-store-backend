-- Whether the account may be used outside its allowed addresses.
--
-- Before this, a non-empty `allowed_ips` was itself the restriction, so an
-- admin had to delete the list to let someone work from elsewhere and retype
-- it afterwards. The switch separates the policy from the list: turn outside
-- access off for a user and they are confined to `allowed_ips`; turn it back
-- on and the list stays saved for next time.
--
-- Defaults to 1 so every existing account keeps working from anywhere.
ALTER TABLE `user` ADD COLUMN `allow_outside_access` TINYINT(1) NOT NULL DEFAULT 1 AFTER `allowed_ips`;

-- Preserve the old meaning for anyone already carrying a list.
UPDATE `user` SET `allow_outside_access` = 0 WHERE `allowed_ips` IS NOT NULL AND TRIM(`allowed_ips`) <> '';
