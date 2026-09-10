-- Branch-level static IP restriction. Every employee assigned to the outlet
-- (new_employee.store_id = outlets.outlet_id) is bound to `allowed_ips` while
-- `ip_restriction_enabled` = 1. The list is kept while the switch is off so it
-- need not be retyped to turn the rule back on.
ALTER TABLE `outlets`
  ADD COLUMN `allowed_ips` VARCHAR(1000) NULL DEFAULT NULL AFTER `gofrugal_id`,
  ADD COLUMN `ip_restriction_enabled` TINYINT(1) NOT NULL DEFAULT 0 AFTER `allowed_ips`;

-- Per-user policy replaces the two-state outside-access switch:
--   branch        follow the branch rule (default); personal list ignored
--   custom        personal list enforced, unioned with the branch list
--   unrestricted  explicit exemption, no check
-- `allow_outside_access` is left in place for now so the previous release
-- keeps working during the seconds between migrate and reload; a later
-- cleanup migration drops it.
ALTER TABLE `user`
  ADD COLUMN `ip_policy` VARCHAR(16) NOT NULL DEFAULT 'branch' AFTER `allow_outside_access`;

-- Admins are exempt by default.
UPDATE `user` SET `ip_policy` = 'unrestricted' WHERE `user_type` = 2;
-- Anyone explicitly confined today stays confined. Runs last so it wins for
-- an admin who was deliberately restricted.
UPDATE `user` SET `ip_policy` = 'custom' WHERE `allow_outside_access` = 0;

-- The branch pages move under Masters and gain a gate of their own.
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_branch');
