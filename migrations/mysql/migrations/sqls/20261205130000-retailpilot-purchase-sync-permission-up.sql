-- =====================================================================
-- POST /purchase/retailpilot-sync (run the RetailPilot purchase sync by
-- hand, or a dry run): the permission key, and nothing else. DECLARED here
-- and granted to NOBODY: administrators hold it through the user_type 2
-- bypass, and a designation gets it only when somebody grants it on the
-- Designation screen. The scheduled sync does not need it.
-- =====================================================================
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'sync_retailpilot_purchases' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'sync_retailpilot_purchases');
