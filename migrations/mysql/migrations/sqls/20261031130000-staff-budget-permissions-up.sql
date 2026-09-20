-- The Staff Budget screen's two permission keys.
--
--   view_staff_budget   read the approved headcount plan and its budgets
--   edit_staff_budget   change approved headcount, and configure the rates
--
-- Reads and writes are separate keys because they are separate decisions: a
-- store or operations lead may need to see the approved plan for their
-- location without being able to move the numbers in it.
--
-- THIS MIGRATION GRANTS THEM TO NOBODY, DELIBERATELY.
--
-- Staff Budget is approved manpower: how many positions exist and what they
-- cost. Who may see that, and who may change it, is a decision to be made
-- deliberately rather than inherited from whichever designation a migration
-- happened to name. Earlier HR migrations in this repository grant on deploy
-- by matching `designation.designation_name`; that is not done here, so no
-- designation's reach widens when this runs.
--
-- The keys therefore appear on the designation permissions screen with no
-- holders, and an administrator grants them there. Administrators themselves
-- need no grant - middlewares/permissions.js bypasses this table for
-- `user_type` 2 - so the feature is reachable and reviewable from the moment
-- it deploys without anybody else's access changing.
--
-- ADDITIVE AND NARROW: two rows in `all_permissions` and nothing else. It
-- revokes nothing, writes no grant, and does not touch the legacy
-- `view_store_budget` / `add_store_budger` keys of the old /store-budget
-- screen.

-- `all_permissions` has no unique key on permission_key, so each insert
-- guards itself and a re-run adds nothing.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_staff_budget' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_staff_budget');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'edit_staff_budget' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'edit_staff_budget');

-- REPORT ONLY. db-migrate prints result sets, so whoever runs the deploy sees
-- that both keys exist and that nobody holds them yet.
SELECT `permission_key`,
       ( SELECT COUNT(*) FROM `permissions` p
          WHERE p.`permission_key` = a.`permission_key` AND p.`is_active` = TRUE
       ) AS `DESIGNATIONS_HOLDING_IT_grant_on_the_permissions_screen`
  FROM `all_permissions` a
 WHERE a.`permission_key` IN ('view_staff_budget', 'edit_staff_budget');
